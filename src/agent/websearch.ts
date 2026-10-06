/**
 * Web search + page-to-text for the agent's opt-in web tools (v0.3).
 *
 * Design decisions:
 *  - PRIVACY: everything else in selora-cli talks ONLY to the Selora gateway.
 *    The functions in this module deliberately talk to other hosts (Brave,
 *    Tavily, DuckDuckGo, and whatever page fetchPageText is pointed at).
 *    That is why the tools built on it (agent/tools/web.ts) sit behind an
 *    explicit opt-in gate and are OFF by default — this module never makes
 *    that decision; it only fails honestly when it is asked to run.
 *  - NO NEW DEPENDENCIES: native fetch only, and the DuckDuckGo result HTML
 *    (and page HTML) is parsed with plain string/regex code. The
 *    two-runtime-deps rule (CONTRIBUTING.md) rules out a parser package; the
 *    shapes read here are narrow (result anchors, result__snippet elements,
 *    <title>, script/style blocks), so regex is enough and fails soft: a
 *    malformed row is skipped, never a crash.
 *  - SIGNALS: every request gets a 20 s timeout combined with the caller's
 *    optional AbortSignal. AbortSignal.any is NOT used — the engine floor is
 *    Node 20.0, which predates it — so the two signals are combined manually
 *    with listeners on a fresh controller.
 *  - HONESTY: every failure is a WebSearchError with a plain message (host,
 *    HTTP status, body excerpt capped at 200 chars). Wire data is decoded
 *    defensively: Record lookups are guarded with rec()/strField(), unknown
 *    provider values fall back to the keyless DuckDuckGo, and nothing here
 *    throws a raw TypeError at the caller or dumps a raw response body.
 */

const UA = 'selora-cli/0.3 (+https://github.com/ToxicAngelX/selora-cli)';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESULTS = 8;
/** fetchPageText output cap — 40,000 characters of readable text. */
const PAGE_TEXT_CAP = 40_000;
/** How much of an error response body may ever appear in an error message. */
const BODY_EXCERPT_CAP = 200;

export type SearchProviderName = 'brave' | 'tavily' | 'duckduckgo';

export interface SearchOptions {
  provider: SearchProviderName;
  apiKey?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchError';
  }
}

/**
 * Resolve the search provider from the environment. SELORA_SEARCH_PROVIDER
 * selects brave|tavily|duckduckgo; anything unknown or absent selects
 * duckduckgo (the no-API-key fallback). SELORA_SEARCH_API_KEY supplies the
 * key — brave/tavily check it at SEARCH time, not here, so config resolution
 * alone can never fail. An empty-string key is treated as absent.
 */
export function resolveSearchConfig(env: NodeJS.ProcessEnv = process.env): SearchOptions {
  const raw = env['SELORA_SEARCH_PROVIDER'];
  const provider: SearchProviderName =
    raw === 'brave' || raw === 'tavily' || raw === 'duckduckgo' ? raw : 'duckduckgo';
  const key = env['SELORA_SEARCH_API_KEY'];
  if (key !== undefined && key !== '') return { provider, apiKey: key };
  return { provider };
}

// ---------------------------------------------------------------------------
// HTTP plumbing (timeout + honest errors)
// ---------------------------------------------------------------------------

interface HttpCall {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A caller signal combined with the 20 s timeout, plus cleanup. */
interface SignalGuard {
  signal: AbortSignal;
  dispose: () => void;
  timedOut: () => boolean;
}

/**
 * Combine an optional external AbortSignal with a timeout on a fresh
 * controller, using plain listeners (Node 20.0 has no AbortSignal.any).
 * dispose() must run after the fetch settles so no timer or listener leaks.
 */
function timeoutGuard(external: AbortSignal | undefined, ms: number): SignalGuard {
  const ctl = new AbortController();
  let timedOut = false;
  const onExternalAbort = (): void => {
    ctl.abort();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  if (external !== undefined && external.aborted) ctl.abort();
  external?.addEventListener('abort', onExternalAbort, { once: true });
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the remote host';
  }
}

/**
 * fetch + timeout + status gate. Network/abort rejections become
 * WebSearchError(err.message) — or a plain timeout message when the 20 s
 * timer fired. Non-2xx becomes '<host> answered HTTP <status>' with at most
 * 200 whitespace-collapsed characters of the body as context, never more.
 */
async function httpFetch(url: string, call: HttpCall, external?: AbortSignal): Promise<Response> {
  const host = hostOf(url);
  const guard = timeoutGuard(external, REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    const init: RequestInit = { signal: guard.signal };
    if (call.headers !== undefined) init.headers = call.headers;
    if (call.method !== undefined) init.method = call.method;
    if (call.body !== undefined) init.body = call.body;
    res = await fetch(url, init);
  } catch (err) {
    if (guard.timedOut()) throw new WebSearchError(`${host} timed out after 20 s`);
    throw new WebSearchError(errText(err));
  } finally {
    guard.dispose();
  }
  if (!res.ok) {
    let excerpt = '';
    try {
      excerpt = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, BODY_EXCERPT_CAP);
    } catch {
      // no readable body — the status line alone is the honest message
    }
    throw new WebSearchError(
      excerpt === ''
        ? `${host} answered HTTP ${res.status}`
        : `${host} answered HTTP ${res.status} — ${excerpt}`,
    );
  }
  return res;
}

/** Read + JSON.parse the body; unreadable/unparseable → honest error. */
async function readJson(res: Response, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new WebSearchError(`${what} returned an unreadable body`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WebSearchError(`${what} returned an unparseable body`);
  }
}

// ---------------------------------------------------------------------------
// Wire-shape helpers (the guarded Record lookups)
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A non-empty string field — anything else (missing, wrong type, '') is absent. */
function strField(src: Record<string, unknown>, key: string): string | undefined {
  const v = Object.hasOwn(src, key) ? src[key] : undefined;
  return typeof v === 'string' && v !== '' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Entity decoding + tag stripping (shared by DDG parsing and fetchPageText)
// ---------------------------------------------------------------------------

/**
 * The basic HTML entities. &amp; is decoded LAST so an escaped entity
 * ("&amp;lt;") decodes once, to the literal text "&lt;", not to "<".
 */
const ENTITIES: readonly (readonly [string, string])[] = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#x27;', "'"],
  ['&#39;', "'"],
  ['&nbsp;', ' '],
  ['&amp;', '&'],
];

function decodeEntities(s: string): string {
  let out = s;
  for (const [entity, ch] of ENTITIES) out = out.split(entity).join(ch);
  return out;
}

/** Strip tags, decode entities, collapse runs of whitespace — for short text. */
function cleanInlineText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function requireKey(provider: string, key: string | undefined): string {
  if (key === undefined) {
    throw new WebSearchError(`${provider} search requires SELORA_SEARCH_API_KEY`);
  }
  return key;
}

function braveSearch(
  query: string,
  opts: SearchOptions,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const key = requireKey('brave', opts.apiKey);
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
    q: query,
    count: String(MAX_RESULTS),
  })}`;
  return httpFetch(
    url,
    {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'X-Subscription-Token': key,
      },
    },
    signal,
  ).then(async (res) => parseBraveResults(await readJson(res, 'brave search')));
}

/** data.web.results[] → {title, url, description}; malformed rows skipped. */
function parseBraveResults(body: unknown): WebSearchResult[] {
  const root = rec(body);
  const data = root !== null ? rec(root['data']) : null;
  const web = data !== null ? rec(data['web']) : null;
  const rows = web !== null && Array.isArray(web['results']) ? (web['results'] as unknown[]) : [];
  const out: WebSearchResult[] = [];
  for (const row of rows) {
    if (out.length >= MAX_RESULTS) break;
    const r = rec(row);
    if (r === null) continue;
    const title = strField(r, 'title');
    const url = strField(r, 'url');
    if (title === undefined || url === undefined) continue;
    out.push({ title, url, snippet: strField(r, 'description') ?? '' });
  }
  return out;
}

function tavilySearch(
  query: string,
  opts: SearchOptions,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const key = requireKey('tavily', opts.apiKey);
  return httpFetch(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: MAX_RESULTS }),
    },
    signal,
  ).then(async (res) => parseTavilyResults(await readJson(res, 'tavily search')));
}

/** results[] → {title, url, content}; malformed rows skipped. */
function parseTavilyResults(body: unknown): WebSearchResult[] {
  const root = rec(body);
  const rows =
    root !== null && Array.isArray(root['results']) ? (root['results'] as unknown[]) : [];
  const out: WebSearchResult[] = [];
  for (const row of rows) {
    if (out.length >= MAX_RESULTS) break;
    const r = rec(row);
    if (r === null) continue;
    const title = strField(r, 'title');
    const url = strField(r, 'url');
    if (title === undefined || url === undefined) continue;
    out.push({ title, url, snippet: strField(r, 'content') ?? '' });
  }
  return out;
}

function duckduckgoSearch(
  query: string,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`;
  return httpFetch(url, { headers: { 'User-Agent': UA } }, signal).then(async (res) => {
    let html: string;
    try {
      html = await res.text();
    } catch {
      throw new WebSearchError('duckduckgo returned an unreadable body');
    }
    return parseDdgHtml(html);
  });
}

/**
 * DuckDuckGo HTML is parsed with targeted regexes, not a general parser:
 *  - result anchors: every <a …> whose class contains the token result__a;
 *    anchors never nest, so a non-greedy <a…>…</a> scan is sound.
 *  - snippets: elements of any tag whose class contains result__snippet; the
 *    class token is required IN the opening tag of the match, so a wrapping
 *    <div class="result"> can never swallow the inner elements, and the
 *    closing tag must match the opening one (a nested <b> cannot end the
 *    snippet early).
 *  - hrefs come out of redirect wrappers (//duckduckgo.com/l/?uddg=<enc>&…),
 *    which are unwrapped and decoded; every other href passes through
 *    unchanged. Attribute values are entity-decoded before parsing (an "&"
 *    inside a URL attribute is written "&amp;" in HTML).
 *  - titles/snippets are tag-stripped + entity-decoded; malformed rows
 *    (missing href or empty title) are skipped, never invented.
 */
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const SNIPPET_RE =
  /<([a-z][a-z0-9]*)\b[^>]*\bclass\s*=\s*(?:"[^"]*\bresult__snippet\b[^"]*"|'[^']*\bresult__snippet\b[^']*')[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const RESULT_A_TOKEN_RE = /\bresult__a\b/;

/** An attribute's value from a tag's raw attribute string (quotes optional). */
function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  if (m === null) return undefined;
  return m[1] ?? m[2] ?? '';
}

/**
 * Unwrap a DuckDuckGo redirect href (//duckduckgo.com/l/?uddg=<encoded>&…)
 * into the target URL; any other href passes through as-is. A malformed
 * uddg value falls back to the raw param rather than throwing.
 */
function unwrapDdgHref(href: string): string {
  let candidate = href;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  try {
    const u = new URL(candidate);
    const isDdgHost = u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com');
    if (isDdgHost && u.pathname === '/l/') {
      const uddg = u.searchParams.get('uddg');
      if (uddg !== null && uddg !== '') {
        try {
          return decodeURIComponent(uddg);
        } catch {
          return uddg;
        }
      }
    }
  } catch {
    // not a parseable URL — pass the original href through unchanged
  }
  return href;
}

function parseDdgHtml(html: string): WebSearchResult[] {
  const snippets: string[] = [];
  for (const m of html.matchAll(SNIPPET_RE)) {
    if (snippets.length >= MAX_RESULTS) break;
    snippets.push(cleanInlineText(m[2] ?? ''));
  }
  const results: WebSearchResult[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    if (results.length >= MAX_RESULTS) break;
    const attrs = m[1] ?? '';
    const cls = attrValue(attrs, 'class') ?? '';
    if (!RESULT_A_TOKEN_RE.test(cls)) continue;
    const href = attrValue(attrs, 'href');
    if (href === undefined || href === '') continue;
    const title = cleanInlineText(m[2] ?? '');
    if (title === '') continue;
    results.push({ title, url: unwrapDdgHref(decodeEntities(href)), snippet: '' });
  }
  return results.map((r, i) => ({ ...r, snippet: snippets[i] ?? '' }));
}

/** Search the web with the chosen provider. Every failure is a WebSearchError. */
export async function runWebSearch(
  query: string,
  opts: SearchOptions,
  init?: { signal?: AbortSignal },
): Promise<WebSearchResult[]> {
  switch (opts.provider) {
    case 'brave':
      return braveSearch(query, opts, init?.signal);
    case 'tavily':
      return tavilySearch(query, opts, init?.signal);
    default:
      return duckduckgoSearch(query, init?.signal);
  }
}

// ---------------------------------------------------------------------------
// fetchPageText — one web page as readable text
// ---------------------------------------------------------------------------

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/**
 * HTML → readable text: title extracted (entity-decoded, whitespace
 * collapsed); script/style blocks removed; remaining tags stripped; entities
 * decoded; trailing spaces trimmed per line; runs of 3+ blank lines
 * collapsed to one blank line. The caller caps the resulting text.
 */
function htmlToText(html: string): { title: string | undefined; text: string } {
  let title: string | undefined;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (titleMatch !== null) {
    const t = cleanInlineText(titleMatch[1] ?? '');
    if (t !== '') title = t;
  }
  let body = html;
  body = body.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ');
  body = body.replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');
  body = decodeEntities(body.replace(/<[^>]*>/g, ''));
  body = body.replace(/[ \t]+$/gm, '');
  // 3+ blank lines (4+ newlines, possibly space-padded) → exactly one blank line.
  body = body.replace(/\n(?:[ \t]*\n){3,}/g, '\n\n');
  return { title, text: body.trim() };
}

/**
 * Fetch one web page and return its readable text. Refuses non-http(s) URLs
 * and non-text content types up front; non-2xx and network failures are
 * WebSearchErrors from the shared HTTP plumbing. text/html is stripped to
 * text; other text/* bodies pass through as-is; both are capped at
 * PAGE_TEXT_CAP characters. The title falls back to the URL itself.
 */
export async function fetchPageText(
  url: string,
  init?: { signal?: AbortSignal },
): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebSearchError(`refused non-http(s) URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebSearchError(`refused non-http(s) URL: ${url}`);
  }
  const res = await httpFetch(url, { headers: { 'User-Agent': UA } }, init?.signal);
  const contentType = res.headers.get('content-type');
  if (contentType === null || !/^text\//i.test(contentType)) {
    throw new WebSearchError(`refused content-type ${contentType ?? '(none)'}`);
  }
  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new WebSearchError('the page body was unreadable');
  }
  const truncated = body.length > PAGE_TEXT_CAP;
  if (/^text\/html\b/i.test(contentType)) {
    const { title, text } = htmlToText(body);
    const capped = truncated ? text.slice(0, PAGE_TEXT_CAP) : text;
    return { url, title: title ?? url, text: capped, truncated };
  }
  // Plain text (or any other text/*): the body as-is, same cap.
  return { url, title: url, text: truncated ? body.slice(0, PAGE_TEXT_CAP) : body, truncated };
}
