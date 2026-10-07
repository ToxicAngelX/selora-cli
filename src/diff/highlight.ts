/**
 * src/diff/highlight.ts — zero-dependency syntax highlighting for diff rows.
 * cli-highlight/shiki would blow the 150 KB npm tarball budget, so this is a
 * hand-rolled line SCANNER (never one giant regex): each line is walked once,
 * left to right, in O(line length).
 *
 * Token roles are deliberately coarse — keyword | string | comment | number |
 * plain — because the renderer only needs five colors that must stay legible
 * on top of diff row backgrounds. Segments rejoin EXACTLY to the input line
 * (concatenating every segment's `text` reproduces the line), which the
 * renderer relies on when intersecting tokens with word-diff segments.
 *
 * Language support is by file extension (plus a few basenames: Dockerfile,
 * Makefile, .env) covering the common agent-edited languages; unknown
 * extensions yield a single 'plain' segment. Comment/string handling is a
 * per-line approximation: block comments that open and don't close consume
 * the REST of that line, and state never carries across lines (diffs are
 * shown line-by-line; full parser state machines are out of budget). Strings
 * are escape-aware (\x doesn't end the string). SQL and Dockerfile keywords
 * match case-insensitively. The extension → language-spec lookup is cached in
 * a Map. This module NEVER throws: any internal surprise yields one 'plain'
 * segment for the whole line.
 */

export type HighlightRole = 'keyword' | 'string' | 'comment' | 'number' | 'plain';

export interface HighlightSegment {
  text: string;
  role: HighlightRole;
}

// ---------------------------------------------------------------------------
// language specs
// ---------------------------------------------------------------------------

interface LangSpec {
  /** Line-comment openers (rest of line is a comment). Longest match wins. */
  lineComments: readonly string[];
  /** Block comment [open, close] pairs (per-line approximation). */
  blockComments: ReadonlyArray<readonly [string, string]>;
  /** String delimiters (' " `). */
  quotes: readonly string[];
  keywords: ReadonlySet<string>;
  /** Match keywords lowercased (SQL, Dockerfile). */
  keywordFoldCase: boolean;
}

function spec(
  lineComments: readonly string[],
  blockComments: ReadonlyArray<readonly [string, string]>,
  quotes: readonly string[],
  keywords: readonly string[],
  keywordFoldCase = false,
): LangSpec {
  return { lineComments, blockComments, quotes, keywords: new Set(keywords), keywordFoldCase };
}

const C_BLOCK: ReadonlyArray<readonly [string, string]> = [['/*', '*/']];
const HTML_BLOCK: ReadonlyArray<readonly [string, string]> = [['<!--', '-->']];

const JS_KW = [
  'abstract',
  'any',
  'as',
  'asserts',
  'async',
  'await',
  'bigint',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'namespace',
  'never',
  'new',
  'null',
  'number',
  'object',
  'of',
  'override',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'return',
  'satisfies',
  'set',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unknown',
  'var',
  'void',
  'while',
  'yield',
];
const PY_KW = [
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'None',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield',
];
const RB_KW = [
  'alias',
  'and',
  'attr_accessor',
  'attr_reader',
  'attr_writer',
  'begin',
  'BEGIN',
  'break',
  'case',
  'class',
  'def',
  'defined',
  'do',
  'else',
  'elsif',
  'end',
  'END',
  'ensure',
  'extend',
  'false',
  'for',
  'if',
  'in',
  'include',
  'lambda',
  'module',
  'new',
  'next',
  'nil',
  'not',
  'or',
  'proc',
  'redo',
  'require',
  'rescue',
  'retry',
  'return',
  'self',
  'super',
  'then',
  'true',
  'undef',
  'unless',
  'until',
  'when',
  'while',
  'yield',
];
const GO_KW = [
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'false',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'iota',
  'map',
  'nil',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'true',
  'type',
  'var',
];
const RS_KW = [
  'as',
  'async',
  'await',
  'box',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'Self',
  'self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
];
const JVM_KW = [
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'companion',
  'const',
  'continue',
  'data',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'false',
  'final',
  'finally',
  'float',
  'for',
  'fun',
  'if',
  'implicit',
  'implements',
  'import',
  'in',
  'init',
  'inline',
  'instanceof',
  'int',
  'interface',
  'internal',
  'lazy',
  'long',
  'match',
  'native',
  'new',
  'null',
  'object',
  'override',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'sealed',
  'short',
  'static',
  'strictfp',
  'super',
  'suspend',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'trait',
  'transient',
  'true',
  'try',
  'typealias',
  'val',
  'var',
  'void',
  'volatile',
  'when',
  'while',
  'with',
  'yield',
];
const C_KW = [
  'auto',
  'bool',
  'break',
  'case',
  'catch',
  'char',
  'class',
  'concept',
  'const',
  'constexpr',
  'continue',
  'decltype',
  'default',
  'delegate',
  'delete',
  'do',
  'double',
  'else',
  'enum',
  'event',
  'explicit',
  'export',
  'extern',
  'false',
  'float',
  'for',
  'foreach',
  'friend',
  'get',
  'goto',
  'if',
  'in',
  'inline',
  'int',
  'interface',
  'internal',
  'is',
  'lock',
  'long',
  'namespace',
  'new',
  'noexcept',
  'nullptr',
  'null',
  'out',
  'override',
  'partial',
  'private',
  'protected',
  'public',
  'readonly',
  'ref',
  'register',
  'requires',
  'return',
  'set',
  'short',
  'signed',
  'sizeof',
  'static',
  'static_assert',
  'string',
  'struct',
  'switch',
  'template',
  'this',
  'throw',
  'true',
  'try',
  'typedef',
  'typename',
  'union',
  'unsigned',
  'using',
  'var',
  'virtual',
  'void',
  'volatile',
  'while',
];
const SH_KW = [
  'alias',
  'case',
  'cd',
  'coproc',
  'do',
  'done',
  'echo',
  'elif',
  'else',
  'esac',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'local',
  'printf',
  'read',
  'return',
  'select',
  'set',
  'shift',
  'source',
  'test',
  'then',
  'time',
  'trap',
  'true',
  'unalias',
  'unset',
  'until',
  'while',
];
const SQL_KW = [
  'all',
  'alter',
  'and',
  'as',
  'asc',
  'begin',
  'between',
  'by',
  'case',
  'commit',
  'create',
  'delete',
  'desc',
  'distinct',
  'drop',
  'else',
  'end',
  'exists',
  'foreign',
  'from',
  'full',
  'function',
  'grant',
  'group',
  'having',
  'in',
  'index',
  'inner',
  'insert',
  'into',
  'is',
  'join',
  'key',
  'left',
  'like',
  'limit',
  'not',
  'null',
  'offset',
  'on',
  'or',
  'order',
  'outer',
  'primary',
  'procedure',
  'references',
  'revoke',
  'right',
  'rollback',
  'select',
  'set',
  'table',
  'then',
  'transaction',
  'trigger',
  'union',
  'update',
  'values',
  'view',
  'when',
  'where',
];
const PHP_KW = [
  'abstract',
  'array',
  'as',
  'break',
  'case',
  'catch',
  'class',
  'clone',
  'const',
  'continue',
  'declare',
  'default',
  'do',
  'echo',
  'else',
  'elseif',
  'empty',
  'enum',
  'extends',
  'false',
  'final',
  'finally',
  'fn',
  'for',
  'foreach',
  'function',
  'global',
  'if',
  'implements',
  'include',
  'instanceof',
  'interface',
  'isset',
  'list',
  'match',
  'namespace',
  'new',
  'null',
  'print',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'return',
  'static',
  'switch',
  'this',
  'throw',
  'trait',
  'true',
  'try',
  'unset',
  'use',
  'var',
  'while',
  'yield',
];
const SWIFT_KW = [
  'Any',
  'as',
  'associatedtype',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'continue',
  'default',
  'defer',
  'deinit',
  'do',
  'else',
  'enum',
  'extension',
  'fallthrough',
  'false',
  'fileprivate',
  'for',
  'func',
  'guard',
  'if',
  'import',
  'in',
  'init',
  'inout',
  'internal',
  'is',
  'let',
  'nil',
  'open',
  'operator',
  'precedencegroup',
  'private',
  'protocol',
  'public',
  'repeat',
  'rethrows',
  'return',
  'Self',
  'self',
  'some',
  'static',
  'struct',
  'subscript',
  'super',
  'switch',
  'throw',
  'throws',
  'true',
  'try',
  'typealias',
  'var',
  'where',
  'while',
];
const LUA_KW = [
  'and',
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'false',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'local',
  'nil',
  'not',
  'or',
  'repeat',
  'return',
  'then',
  'true',
  'until',
  'while',
];
const DOCKER_KW = [
  'ADD',
  'ARG',
  'CMD',
  'COPY',
  'ENTRYPOINT',
  'ENV',
  'EXPOSE',
  'FROM',
  'HEALTHCHECK',
  'LABEL',
  'MAINTAINER',
  'ONBUILD',
  'RUN',
  'SHELL',
  'STOPSIGNAL',
  'USER',
  'VOLUME',
  'WORKDIR',
];
const MAKE_KW = [
  'define',
  'else',
  'endef',
  'export',
  'ifdef',
  'ifeq',
  'ifndef',
  'ifneq',
  'include',
  'override',
];
const BOOL_KW = ['false', 'null', 'true'];
const YAML_KW = ['false', 'no', 'null', 'off', 'on', 'true', 'yes'];

/** Language ids — several extensions share one spec. */
const SPECS: Record<string, LangSpec> = {
  js: spec(['//'], C_BLOCK, ["'", '"', '`'], JS_KW),
  py: spec(['#'], [], ["'", '"'], PY_KW),
  rb: spec(['#'], [], ["'", '"'], RB_KW),
  go: spec(['//'], C_BLOCK, ["'", '"', '`'], GO_KW),
  rs: spec(['//'], C_BLOCK, ["'", '"'], RS_KW),
  jvm: spec(['//'], C_BLOCK, ["'", '"'], JVM_KW),
  c: spec(['//'], C_BLOCK, ["'", '"'], C_KW),
  sh: spec(['#'], [], ["'", '"', '`'], SH_KW),
  json: spec([], [], ['"'], BOOL_KW),
  yaml: spec(['#'], [], ["'", '"'], YAML_KW),
  toml: spec(['#'], [], ["'", '"'], BOOL_KW),
  md: spec([], HTML_BLOCK, [], []),
  html: spec([], HTML_BLOCK, ["'", '"'], []),
  css: spec(['//'], C_BLOCK, ["'", '"'], []),
  sql: spec(['--'], C_BLOCK, ["'", '"', '`'], SQL_KW, true),
  php: spec(['//', '#'], C_BLOCK, ["'", '"', '`'], PHP_KW),
  swift: spec(['//'], C_BLOCK, ["'", '"'], SWIFT_KW),
  lua: spec(['--'], [], ["'", '"'], LUA_KW),
  docker: spec(['#'], [], ["'", '"'], DOCKER_KW, true),
  make: spec(['#'], [], ["'", '"'], MAKE_KW),
  ini: spec(['#', ';'], [], ["'", '"'], BOOL_KW),
};

const EXT_TO_LANG: Record<string, string> = {
  ts: 'js',
  tsx: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  mts: 'js',
  cts: 'js',
  py: 'py',
  pyw: 'py',
  pyi: 'py',
  rb: 'rb',
  go: 'go',
  rs: 'rs',
  java: 'jvm',
  kt: 'jvm',
  kts: 'jvm',
  scala: 'jvm',
  sc: 'jvm',
  c: 'c',
  h: 'c',
  cpp: 'c',
  cc: 'c',
  cxx: 'c',
  hpp: 'c',
  hh: 'c',
  cs: 'c',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'md',
  markdown: 'md',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  sql: 'sql',
  php: 'php',
  swift: 'swift',
  lua: 'lua',
  mk: 'make',
  env: 'ini',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  properties: 'ini',
  editorconfig: 'ini',
};

/** Cache: extension/basename key → resolved spec (null = unknown, plain only). */
const SPEC_CACHE = new Map<string, LangSpec | null>();

function specFor(filePath: string): LangSpec | null {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  let key: string;
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) key = 'docker';
  else if (base === 'makefile' || base === 'gnumakefile') key = 'make';
  else if (base === '.env' || base.startsWith('.env.')) key = 'ini';
  else {
    const dot = base.lastIndexOf('.');
    key = dot > 0 ? base.slice(dot + 1) : '';
  }
  const cached = SPEC_CACHE.get(key);
  if (cached !== undefined) return cached;
  const lang = Object.hasOwn(EXT_TO_LANG, key) ? EXT_TO_LANG[key] : undefined;
  const resolved = lang !== undefined && Object.hasOwn(SPECS, lang) ? (SPECS[lang] ?? null) : null;
  SPEC_CACHE.set(key, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// the scanner
// ---------------------------------------------------------------------------

const NUMBER_RE =
  /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d(?:[\d_]*\d)?(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d+)?)/;

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/** The longest line-comment opener matching at `i`, or null. */
function matchLineComment(spec: LangSpec, line: string, i: number): boolean {
  for (const opener of spec.lineComments) {
    if (line.startsWith(opener, i)) return true;
  }
  return false;
}

function matchBlockStart(
  spec: LangSpec,
  line: string,
  i: number,
): readonly [string, string] | null {
  for (const pair of spec.blockComments) {
    if (line.startsWith(pair[0], i)) return pair;
  }
  return null;
}

function scan(line: string, spec: LangSpec): HighlightSegment[] {
  const segs: HighlightSegment[] = [];
  let i = 0;
  let plainStart = 0;
  const flushPlain = (end: number): void => {
    if (end > plainStart) segs.push({ text: line.slice(plainStart, end), role: 'plain' });
  };

  while (i < line.length) {
    if (matchLineComment(spec, line, i)) {
      flushPlain(i);
      segs.push({ text: line.slice(i), role: 'comment' });
      return segs;
    }
    const block = matchBlockStart(spec, line, i);
    if (block !== null) {
      flushPlain(i);
      const close = line.indexOf(block[1], i + block[0].length);
      if (close === -1) {
        segs.push({ text: line.slice(i), role: 'comment' });
        return segs;
      }
      segs.push({ text: line.slice(i, close + block[1].length), role: 'comment' });
      i = close + block[1].length;
      plainStart = i;
      continue;
    }
    const ch = line[i]!;
    if (spec.quotes.includes(ch)) {
      flushPlain(i);
      let j = i + 1;
      while (j < line.length) {
        const cj = line[j]!;
        if (cj === '\\') {
          j += 2; // escape: the next char is part of the string no matter what
          continue;
        }
        j += 1;
        if (cj === ch) break;
      }
      segs.push({ text: line.slice(i, j), role: 'string' });
      i = j;
      plainStart = i;
      continue;
    }
    if (isDigit(ch)) {
      const m = NUMBER_RE.exec(line.slice(i));
      if (m !== null && m[0] !== '') {
        flushPlain(i);
        segs.push({ text: m[0], role: 'number' });
        i += m[0].length;
        plainStart = i;
        continue;
      }
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < line.length && isIdentPart(line[j]!)) j += 1;
      const word = line.slice(i, j);
      const key = spec.keywordFoldCase ? word.toLowerCase() : word;
      if (spec.keywords.has(key)) {
        flushPlain(i);
        segs.push({ text: word, role: 'keyword' });
        plainStart = j;
      }
      i = j; // non-keyword identifiers stay inside the current plain run
      continue;
    }
    i += 1;
  }
  flushPlain(line.length);
  return segs;
}

/**
 * Tokenize one line of `filePath`'s language. Segments rejoin exactly to
 * `line`; unknown extensions (and any internal error) yield one 'plain'
 * segment covering the whole line. Never throws.
 */
export function highlightLine(line: string, filePath: string): HighlightSegment[] {
  if (line === '') return [];
  try {
    const spec = specFor(filePath);
    if (spec === null) return [{ text: line, role: 'plain' }];
    const segs = scan(line, spec);
    return segs.length === 0 ? [{ text: line, role: 'plain' }] : segs;
  } catch {
    return [{ text: line, role: 'plain' }];
  }
}
