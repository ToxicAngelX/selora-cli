/**
 * Web tool tests: resolveSearchConfig, runWebSearch (all three providers),
 * fetchPageText, the webToolsEnabled opt-in gate, and the web_search /
 * web_fetch Tool objects. NO test makes a real network call — global fetch
 * is stubbed with vi.stubGlobal('fetch', vi.fn()…) and restored with
 * vi.unstubAllGlobals() after every test. The opt-in gate tests use a temp
 * XDG config home (freshEnv / explicit env objects) and temp project cwd
 * directories so a real ~/.config/selora or a repo selora.json can never
 * flip a result. Untrusted input shapes feed wrong JSON and expect honest
 * {ok:false} results, never a crash.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../src/agent/tool.js';
import {
  fetchPageText,
  resolveSearchConfig,
  runWebSearch,
  WebSearchError,
} from '../src/agent/websearch.js';
import { webFetchTool, webSearchTool, webToolsEnabled } from '../src/agent/tools/web.js';
import { saveConfig } from '../src/config/index.js';
import { cleanup, freshEnv } from './helpers/env.js';

// ---------------------------------------------------------------------------
// Stubs + fixtures
// ---------------------------------------------------------------------------

interface MockResponseOpts {
  status?: number;
  body?: unknown;
  contentType?: string | null;
}

/** A Response-shaped object for the stubbed global fetch (no real network). */
function mockResponse(opts: MockResponseOpts): Response {
  const status = opts.status ?? 200;
  const text = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? null);
  const contentType = opts.contentType === undefined ? null : opts.contentType;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
  } as unknown as Response;
}

const ENV_KEYS = ['SELORA_WEB_TOOLS', 'SELORA_SEARCH_PROVIDER', 'SELORA_SEARCH_API_KEY'] as const;
let savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'selora-web-cwd-'));
  tempDirs.push(d);
  return d;
}

/** An env pointing XDG at a temp dir (so the real global config is invisible). */
function isolatedEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'selora-web-xdg-'));
  tempDirs.push(dir);
  return { env: { XDG_CONFIG_HOME: join(dir, 'xdg') }, dir };
}

function toolCtx(cwd: string, dryRun: boolean): ToolContext & { dryRun: boolean } {
  return { cwd, dryRun };
}

const UA_RE = /^selora-cli\/0\.3 /;

/** 3 results: a uddg-redirect href, a plain href, and one without snippet. */
const DDG_HTML = [
  '<div class="results">',
  '<div class="result results_links">',
  '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=xyz">Result <b>One</b> &amp; More</a>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>first</b> snippet &amp; more &lt;detail&gt;</a>',
  '</div>',
  '<div class="result">',
  '<a class="result__a" href="https://example.org/two">Result Two &#39;quoted&#39;</a>',
  '<a class="result__snippet">Second snippet &nbsp;end</a>',
  '</div>',
  '<div class="result">',
  '<a class="result__a" href="https://example.net/three">Result Three</a>',
  '</div>',
  '</div>',
].join('\n');

const DDG_TEN_RESULTS = Array.from(
  { length: 10 },
  (_, i) => `<a class="result__a" href="https://example.com/r${i}">Title ${i}</a>`,
).join('\n');

// ---------------------------------------------------------------------------
// resolveSearchConfig
// ---------------------------------------------------------------------------

describe('resolveSearchConfig', () => {
  it('defaults to the keyless duckduckgo provider', () => {
    expect(resolveSearchConfig({})).toEqual({ provider: 'duckduckgo' });
  });

  it('reads provider and api key from the env', () => {
    expect(
      resolveSearchConfig({ SELORA_SEARCH_PROVIDER: 'brave', SELORA_SEARCH_API_KEY: 'k-test' }),
    ).toEqual({ provider: 'brave', apiKey: 'k-test' });
    expect(resolveSearchConfig({ SELORA_SEARCH_PROVIDER: 'tavily' })).toEqual({
      provider: 'tavily',
    });
  });

  it('falls back to duckduckgo on an unknown provider; empty key is absent', () => {
    expect(resolveSearchConfig({ SELORA_SEARCH_PROVIDER: 'google' })).toEqual({
      provider: 'duckduckgo',
    });
    expect(resolveSearchConfig({ SELORA_SEARCH_API_KEY: '' })).toEqual({
      provider: 'duckduckgo',
    });
  });
});

// ---------------------------------------------------------------------------
// runWebSearch — duckduckgo (HTML parsing)
// ---------------------------------------------------------------------------

describe('runWebSearch duckduckgo', () => {
  it('parses titles/urls/snippets: uddg unwrap, tag strip, entity decode', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(mockResponse({ body: DDG_HTML, contentType: 'text/html' }));
    vi.stubGlobal('fetch', mock);
    const results = await runWebSearch('query one', { provider: 'duckduckgo' });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toBe('https://html.duckduckgo.com/html/?q=query+one');
    expect(init.headers['User-Agent']).toMatch(UA_RE);
    expect(results).toEqual([
      {
        title: 'Result One & More',
        url: 'https://example.com/one',
        snippet: 'The first snippet & more <detail>',
      },
      {
        title: "Result Two 'quoted'",
        url: 'https://example.org/two',
        snippet: 'Second snippet end',
      },
      { title: 'Result Three', url: 'https://example.net/three', snippet: '' },
    ]);
  });

  it('caps results at 8 even when the page has 10', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ body: DDG_TEN_RESULTS, contentType: 'text/html' })),
    );
    const results = await runWebSearch('q', { provider: 'duckduckgo' });
    expect(results).toHaveLength(8);
    expect(results[7]!.url).toBe('https://example.com/r7');
  });

  it('passes non-redirect hrefs through unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ body: DDG_HTML, contentType: 'text/html' })),
    );
    const results = await runWebSearch('q', { provider: 'duckduckgo' });
    expect(results[1]!.url).toBe('https://example.org/two');
  });

  it('non-2xx → WebSearchError naming the host and status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ status: 403, body: 'nope' })));
    await expect(runWebSearch('q', { provider: 'duckduckgo' })).rejects.toBeInstanceOf(
      WebSearchError,
    );
    await expect(runWebSearch('q', { provider: 'duckduckgo' })).rejects.toThrow(
      'html.duckduckgo.com answered HTTP 403',
    );
  });

  it('network rejection → WebSearchError with the raw message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(runWebSearch('q', { provider: 'duckduckgo' })).rejects.toThrow('fetch failed');
  });
});

// ---------------------------------------------------------------------------
// runWebSearch — brave / tavily (JSON parsing)
// ---------------------------------------------------------------------------

describe('runWebSearch brave', () => {
  const braveBody = {
    data: {
      web: {
        results: [
          { title: 'T1', url: 'https://a.example/1', description: 'D1' },
          { title: 42, url: 'not-a-string' }, // malformed row — skipped
          { title: 'T2', url: 'https://a.example/2' }, // missing description
        ],
      },
    },
  };

  it('hits the brave API with the key header and parses results', async () => {
    const mock = vi.fn().mockResolvedValue(mockResponse({ body: braveBody }));
    vi.stubGlobal('fetch', mock);
    const results = await runWebSearch('hello world', { provider: 'brave', apiKey: 'k-brave' });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toContain('https://api.search.brave.com/res/v1/web/search?');
    expect(String(url)).toContain('q=hello+world');
    expect(String(url)).toContain('count=8');
    expect(init.headers['X-Subscription-Token']).toBe('k-brave');
    expect(init.headers['Accept']).toBe('application/json');
    expect(results).toEqual([
      { title: 'T1', url: 'https://a.example/1', snippet: 'D1' },
      { title: 'T2', url: 'https://a.example/2', snippet: '' },
    ]);
  });

  it('missing key → honest WebSearchError, no request made', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    await expect(runWebSearch('q', { provider: 'brave' })).rejects.toThrow(
      'brave search requires SELORA_SEARCH_API_KEY',
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it('non-200 → error mentioning the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ status: 429, body: 'rate limited' })),
    );
    await expect(runWebSearch('q', { provider: 'brave', apiKey: 'k' })).rejects.toThrow('HTTP 429');
  });

  it('unparseable JSON body → honest error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(mockResponse({ body: 'not json at all', contentType: 'text/html' })),
    );
    await expect(runWebSearch('q', { provider: 'brave', apiKey: 'k' })).rejects.toThrow(
      'unparseable body',
    );
  });
});

describe('runWebSearch tavily', () => {
  it('POSTs the documented body and parses results', async () => {
    const mock = vi.fn().mockResolvedValue(
      mockResponse({
        body: { results: [{ title: 'T', url: 'https://t.example/', content: 'C' }] },
      }),
    );
    vi.stubGlobal('fetch', mock);
    const results = await runWebSearch('hello world', { provider: 'tavily', apiKey: 'k-tav' });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      api_key: 'k-tav',
      query: 'hello world',
      max_results: 8,
    });
    expect(results).toEqual([{ title: 'T', url: 'https://t.example/', snippet: 'C' }]);
  });

  it('missing key → honest WebSearchError', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(runWebSearch('q', { provider: 'tavily' })).rejects.toThrow(
      'tavily search requires SELORA_SEARCH_API_KEY',
    );
  });
});

// ---------------------------------------------------------------------------
// fetchPageText
// ---------------------------------------------------------------------------

describe('fetchPageText', () => {
  const PAGE_URL = 'https://example.com/page';

  const PAGE_HTML = [
    '<!doctype html>',
    '<html><head><title>My &amp; Page</title>',
    '<style>body { color: red; }</style>',
    '<script>var hidden = "<p>script text</p>";</script>',
    '</head>',
    '<body>',
    '<h1>Hello &lt;world&gt;</h1>',
    '<p>First paragraph.</p>   ',
    '',
    '',
    '',
    '<p>After blank lines.</p>',
    '</body></html>',
    '',
  ].join('\n');

  it('extracts the title, removes script/style, strips tags, decodes entities', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(mockResponse({ body: PAGE_HTML, contentType: 'text/html' }));
    vi.stubGlobal('fetch', mock);
    const page = await fetchPageText(PAGE_URL);
    expect(mock).toHaveBeenCalledTimes(1);
    const [, init] = mock.mock.calls[0]!;
    expect(init.headers['User-Agent']).toMatch(UA_RE);
    expect(page.title).toBe('My & Page');
    expect(page.text).toBe('My & Page\n\nHello <world>\nFirst paragraph.\n\nAfter blank lines.');
    expect(page.text).not.toContain('script text');
    expect(page.text).not.toContain('color: red');
    expect(page.text).not.toContain('<h1>');
    expect(page.truncated).toBe(false);
  });

  it('falls back to the URL as title when the page has none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ body: '<p>hi</p>', contentType: 'text/html' })),
    );
    const page = await fetchPageText(PAGE_URL);
    expect(page.title).toBe(PAGE_URL);
    expect(page.text).toBe('hi');
  });

  it('truncates text/plain bodies at 40,000 chars with truncated: true', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(mockResponse({ body: 'x'.repeat(45_000), contentType: 'text/plain' })),
    );
    const page = await fetchPageText(PAGE_URL);
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(40_000);
    expect(page.title).toBe(PAGE_URL);
  });

  it('passes text/plain bodies through as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ body: 'plain body\nline two', contentType: 'text/plain' }),
        ),
    );
    const page = await fetchPageText(PAGE_URL);
    expect(page).toEqual({
      url: PAGE_URL,
      title: PAGE_URL,
      text: 'plain body\nline two',
      truncated: false,
    });
  });

  it('refuses non-http(s) URLs and unparseable URLs', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    for (const bad of ['ftp://example.com/f', 'file:///etc/passwd', 'not a url']) {
      await expect(fetchPageText(bad)).rejects.toBeInstanceOf(WebSearchError);
      await expect(fetchPageText(bad)).rejects.toThrow('refused non-http(s) URL');
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('refuses non-2xx with the host and status in the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ status: 404, body: 'gone' })));
    await expect(fetchPageText(PAGE_URL)).rejects.toThrow('example.com answered HTTP 404');
  });

  it('refuses content types that are not text/', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ body: '{"a":1}', contentType: 'application/json' })),
    );
    await expect(fetchPageText(PAGE_URL)).rejects.toThrow('refused content-type application/json');
  });

  it('refuses a missing content-type header honestly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ body: 'x', contentType: null })),
    );
    await expect(fetchPageText(PAGE_URL)).rejects.toThrow('refused content-type (none)');
  });
});

// ---------------------------------------------------------------------------
// webToolsEnabled — the opt-in gate
// ---------------------------------------------------------------------------

describe('webToolsEnabled', () => {
  it('is off by default (no env flag, no global config, no project field)', () => {
    const { env } = isolatedEnv();
    expect(webToolsEnabled(env, tempCwd())).toBe(false);
  });

  it('is on for SELORA_WEB_TOOLS=1 or =true (and only those)', () => {
    const { env } = isolatedEnv();
    const cwd = tempCwd();
    expect(webToolsEnabled({ ...env, SELORA_WEB_TOOLS: '1' }, cwd)).toBe(true);
    expect(webToolsEnabled({ ...env, SELORA_WEB_TOOLS: 'true' }, cwd)).toBe(true);
    expect(webToolsEnabled({ ...env, SELORA_WEB_TOOLS: '0' }, cwd)).toBe(false);
    expect(webToolsEnabled({ ...env, SELORA_WEB_TOOLS: 'yes' }, cwd)).toBe(false);
  });

  it('reads the project selora.json agent.webTools field', () => {
    const { env } = isolatedEnv();
    const cwd = tempCwd();
    writeFileSync(join(cwd, 'selora.json'), JSON.stringify({ agent: { webTools: true } }), 'utf8');
    expect(webToolsEnabled(env, cwd)).toBe(true);
    const off = tempCwd();
    writeFileSync(join(off, 'selora.json'), JSON.stringify({ agent: { webTools: false } }), 'utf8');
    expect(webToolsEnabled(env, off)).toBe(false);
  });

  it('reads the global config webTools field', () => {
    const { env, dir } = isolatedEnv();
    saveConfig({ webTools: true }, env);
    expect(webToolsEnabled(env, tempCwd())).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// The Tool objects
// ---------------------------------------------------------------------------

describe('web_search / web_fetch tools', () => {
  it('are gated off by default with a notice naming the opt-in routes', async () => {
    const t = freshEnv();
    try {
      const mock = vi.fn();
      vi.stubGlobal('fetch', mock);
      const cwd = tempCwd();
      const search = await webSearchTool.run({ query: 'selora docs' }, toolCtx(cwd, false));
      expect(search.ok).toBe(false);
      expect(search.summary).toContain('web tools are off');
      expect(search.summary).toContain('SELORA_WEB_TOOLS=1');
      expect(search.summary).toContain('non-Selora host');
      expect(search.summary).toContain('selora.json');
      const fetchRes = await webFetchTool.run({ url: 'https://example.com/' }, toolCtx(cwd, false));
      expect(fetchRes.ok).toBe(false);
      expect(fetchRes.summary).toContain('web_fetch: web tools are off');
      expect(mock).not.toHaveBeenCalled();
    } finally {
      cleanup(t.dir);
    }
  });

  it('enabled + dry run describes the action and never fetches', async () => {
    const t = freshEnv();
    process.env['SELORA_WEB_TOOLS'] = '1';
    try {
      const mock = vi.fn();
      vi.stubGlobal('fetch', mock);
      const cwd = tempCwd();
      const search = await webSearchTool.run({ query: 'selora docs' }, toolCtx(cwd, true));
      expect(search).toEqual({
        ok: true,
        summary: 'would search the web for selora docs (provider: duckduckgo)',
      });
      const fetchRes = await webFetchTool.run({ url: 'https://example.com/x' }, toolCtx(cwd, true));
      expect(fetchRes).toEqual({ ok: true, summary: 'would fetch https://example.com/x' });
      expect(mock).not.toHaveBeenCalled();
    } finally {
      cleanup(t.dir);
    }
  });

  it('enabled + real run returns result blocks with the URLs', async () => {
    const t = freshEnv();
    process.env['SELORA_WEB_TOOLS'] = '1';
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse({ body: DDG_HTML, contentType: 'text/html' })),
      );
      const cwd = tempCwd();
      const res = await webSearchTool.run({ query: 'query one' }, toolCtx(cwd, false));
      expect(res.ok).toBe(true);
      expect(res.summary).toContain('3 results');
      expect(res.summary).toContain('provider: duckduckgo');
      expect(res.content).toContain('https://example.com/one');
      expect(res.content).toContain('Result One & More');
      expect(res.content).toContain('The first snippet & more <detail>');
    } finally {
      cleanup(t.dir);
    }
  });

  it('enabled + real run of web_fetch returns title + text', async () => {
    const t = freshEnv();
    process.env['SELORA_WEB_TOOLS'] = '1';
    try {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            mockResponse({ body: '<title>T</title>\n<p>body</p>', contentType: 'text/html' }),
          ),
      );
      const cwd = tempCwd();
      const res = await webFetchTool.run({ url: 'https://example.com/p' }, toolCtx(cwd, false));
      expect(res.ok).toBe(true);
      // Title text survives in the stripped body too (naive-but-honest pipeline).
      expect(res.content).toBe('T\n\nT\nbody');
      expect(res.summary).toContain('6 chars');
    } finally {
      cleanup(t.dir);
    }
  });

  it('WebSearchError becomes an honest {ok:false} one-liner', async () => {
    const t = freshEnv();
    process.env['SELORA_WEB_TOOLS'] = '1';
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse({ status: 500, body: 'boom' })),
      );
      const cwd = tempCwd();
      const search = await webSearchTool.run({ query: 'q' }, toolCtx(cwd, false));
      expect(search.ok).toBe(false);
      expect(search.summary).toContain('web_search:');
      expect(search.summary).toContain('HTTP 500');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ status: 503, body: 'x' })));
      const fetchRes = await webFetchTool.run(
        { url: 'https://example.com/p' },
        toolCtx(cwd, false),
      );
      expect(fetchRes.ok).toBe(false);
      expect(fetchRes.summary).toContain('web_fetch:');
      expect(fetchRes.summary).toContain('HTTP 503');
    } finally {
      cleanup(t.dir);
    }
  });

  it('refuses non-http URLs on the real path without fetching', async () => {
    const t = freshEnv();
    process.env['SELORA_WEB_TOOLS'] = '1';
    try {
      const mock = vi.fn();
      vi.stubGlobal('fetch', mock);
      const cwd = tempCwd();
      const res = await webFetchTool.run({ url: 'ftp://example.com/f' }, toolCtx(cwd, false));
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('refused non-http(s) URL');
      expect(mock).not.toHaveBeenCalled();
    } finally {
      cleanup(t.dir);
    }
  });

  it('refuses bad input shapes honestly (missing / non-string / non-object)', async () => {
    const cwd = tempCwd();
    expect((await webSearchTool.run({}, toolCtx(cwd, false))).summary).toContain(
      'missing required field "query"',
    );
    expect((await webSearchTool.run({ query: 42 }, toolCtx(cwd, false))).summary).toContain(
      'query must be a non-empty string',
    );
    expect((await webSearchTool.run(null, toolCtx(cwd, false))).summary).toContain(
      'input must be an object',
    );
    expect((await webFetchTool.run({}, toolCtx(cwd, false))).summary).toContain(
      'missing required field "url"',
    );
    expect((await webFetchTool.run({ url: 123 }, toolCtx(cwd, false))).summary).toContain(
      'url must be a non-empty string',
    );
  });

  it('permission labels clip long queries to 60 chars', () => {
    expect(webSearchTool.permissionLabel({ query: 'q'.repeat(80) })).toBe(
      `web_search(${'q'.repeat(60)}…)`,
    );
    expect(webSearchTool.permissionLabel({ query: 'ok' })).toBe('web_search(ok)');
    expect(webSearchTool.permissionLabel({ nope: 1 })).toBe('web_search(<invalid query>)');
    expect(webFetchTool.permissionLabel({ url: 'https://example.com/' })).toBe(
      'web_fetch(https://example.com/)',
    );
    expect(webFetchTool.permissionLabel({})).toBe('web_fetch(<invalid url>)');
  });
});
