/**
 * web_search / web_fetch — the v0.3 OPT-IN web tools.
 *
 * Everything else in selora-cli talks ONLY to the Selora gateway; these two
 * tools are the deliberate exception (a search provider, an arbitrary page
 * host). They therefore run an OPT-IN GATE first and are disabled by
 * default: env (SELORA_WEB_TOOLS=1|true), global config (webTools: true),
 * or project selora.json (agent.webTools: true), env checked first. The
 * disabled message doubles as the first-use notice — it says a non-Selora
 * host is involved and names all three ways to opt in, so the model can pass
 * the reason back to the user instead of guessing.
 *
 * Input is untrusted model JSON: fields are checked with Object.hasOwn +
 * typeof before use; a bad shape is an honest {ok:false} result, never a
 * crash. runWebSearch/fetchPageText failures (WebSearchError) are mapped to
 * {ok:false} one-liners too — nothing escapes tool.run. Dry runs describe
 * what WOULD happen and never touch the network.
 */

import type { Tool, ToolResult } from '../tool.js';
import { loadConfig } from '../../config/index.js';
import { loadProjectConfig } from '../../config/project.js';
import type { FetchedPage, WebSearchResult } from '../websearch.js';
import { fetchPageText, resolveSearchConfig, runWebSearch } from '../websearch.js';

const QUERY_LABEL_CAP = 60;

/**
 * The opt-in gate, exported for unit tests: env flag, then global config,
 * then project selora.json. Only the enabling values count — SELORA_WEB_TOOLS
 * set to anything else (or absent) defers to the config files. A malformed
 * global or project config degrades to "off" (the config readers ignore it).
 */
export function webToolsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): boolean {
  const flag = env['SELORA_WEB_TOOLS'];
  if (flag === '1' || flag === 'true') return true;
  if (loadConfig(env).webTools === true) return true;
  return loadProjectConfig(cwd).agent?.webTools === true;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function badShape(message: string): ToolResult {
  return { ok: false, summary: message };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The first-use notice for a disabled tool (tool-specific sender phrase). */
function disabledNotice(tool: string, what: string): string {
  return (
    `${tool}: web tools are off — they send ${what} to a non-Selora host. ` +
    'Enable: SELORA_WEB_TOOLS=1, or "agent": {"webTools": true} in selora.json, ' +
    'or "webTools": true in the global config.'
  );
}

/** One human line for a permission label; queries are capped at 60 chars. */
function clipLabel(s: string): string {
  return s.length <= QUERY_LABEL_CAP ? s : `${s.slice(0, QUERY_LABEL_CAP)}…`;
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web. Returns up to 8 results as title, URL, and snippet. ' +
    'You MUST cite the result URLs in your answer. Note: the query is sent ' +
    'to a non-Selora search provider (opt-in required, off by default).',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query (plain words)' },
    },
    required: ['query'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const q = r !== null && typeof r['query'] === 'string' ? r['query'] : '<invalid query>';
    return `web_search(${clipLabel(q)})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('web_search: input must be an object');
    if (!Object.hasOwn(r, 'query')) return badShape('web_search: missing required field "query"');
    if (typeof r['query'] !== 'string' || r['query'].trim() === '') {
      return badShape('web_search: query must be a non-empty string');
    }
    const query = r['query'] as string;
    if (!webToolsEnabled(process.env, ctx.cwd)) {
      return { ok: false, summary: disabledNotice('web_search', 'your query') };
    }
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would search the web for ${clipLabel(query)} (provider: ${resolveSearchConfig().provider})`,
      };
    }
    const opts = resolveSearchConfig();
    let results: WebSearchResult[];
    try {
      results = await runWebSearch(query, opts);
    } catch (err) {
      return badShape(`web_search: ${errText(err)}`);
    }
    if (results.length === 0) {
      return {
        ok: true,
        summary: `web_search: 0 results for ${clipLabel(query)} (provider: ${opts.provider})`,
      };
    }
    const content = results.map((x) => `${x.title}\n  ${x.url}\n  ${x.snippet}`).join('\n\n');
    return {
      ok: true,
      summary: `web_search: ${results.length} results for ${clipLabel(query)} (provider: ${opts.provider})`,
      content,
    };
  },
};

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch one web page and return it as readable text (HTML stripped to ' +
    'plain text, capped at ~40 KB). Use it to read a page behind a URL from ' +
    'web_search. Note: the request goes to an arbitrary non-Selora host ' +
    '(opt-in required, off by default).',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to fetch' },
    },
    required: ['url'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const u = r !== null && typeof r['url'] === 'string' ? r['url'] : '<invalid url>';
    return `web_fetch(${u})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('web_fetch: input must be an object');
    if (!Object.hasOwn(r, 'url')) return badShape('web_fetch: missing required field "url"');
    if (typeof r['url'] !== 'string' || r['url'].trim() === '') {
      return badShape('web_fetch: url must be a non-empty string');
    }
    const url = r['url'] as string;
    if (!webToolsEnabled(process.env, ctx.cwd)) {
      return { ok: false, summary: disabledNotice('web_fetch', 'the page request') };
    }
    if (ctx.dryRun) {
      return { ok: true, summary: `would fetch ${url}` };
    }
    let page: FetchedPage;
    try {
      page = await fetchPageText(url);
    } catch (err) {
      return badShape(`web_fetch: ${errText(err)}`);
    }
    const content =
      `${page.title}\n\n${page.text}` + (page.truncated ? '\n\n(… truncated at 40 KB)' : '');
    return {
      ok: true,
      summary: `web_fetch: fetched ${url} — ${page.text.length} chars${page.truncated ? ', truncated at 40 KB' : ''}`,
      content,
    };
  },
};
