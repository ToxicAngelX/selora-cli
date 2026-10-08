/**
 * Chat/agent UI glue (v0.3): theme adapters for the pure markdown and diff
 * renderers, plus the Claude-Code-style tool display helpers —
 *   ● Read(src/api.ts)
 *     ⎿ read src/index.ts (1 line, 14 B)
 * with content collapsed to 5 lines ("… +N lines") and pre-rendered diffs
 * printed indented. Every helper degrades to plain text when the theme is
 * disabled (level 0 / mono) — the display is then structure, not decoration.
 */

import type { Theme } from './theme.js';
import type { MarkdownStyle } from './markdown.js';
import type { DiffStyle } from './diff.js';
import { sanitizeTerminalText, terminalTextWidth, truncateTerminalText } from './terminal-text.js';

/** Tool name → display name (read_file → Read). Unknown → capitalized. */
const TOOL_DISPLAY: Readonly<Record<string, string>> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  list_dir: 'List',
  create_dir: 'CreateDir',
  move: 'Move',
  copy: 'Copy',
  remove: 'Remove',
  run_command: 'Run',
  web_search: 'Search',
  web_fetch: 'Fetch',
  git_status: 'GitStatus',
  git_diff: 'Diff',
  git_log: 'Log',
  git_commit: 'Commit',
  git_restore: 'Restore',
};

/** The model-facing label `tool(args)` → display `Name(args)`. */
export function toolDisplayName(name: string): string {
  const safeName = sanitizeTerminalText(name);
  const mapped = Object.hasOwn(TOOL_DISPLAY, safeName) ? TOOL_DISPLAY[safeName] : undefined;
  return mapped ?? safeName.charAt(0).toUpperCase() + safeName.slice(1);
}

/** `● Read(src/api.ts)` — the tool-call header line. */
export function renderToolStart(name: string, label: string, theme: Theme): string {
  const safeName = sanitizeTerminalText(name);
  const safeLabel = sanitizeTerminalText(label);
  const args = safeLabel.startsWith(`${safeName}(`)
    ? safeLabel.slice(safeName.length + 1, -1)
    : safeLabel;
  return `${theme.cyan('●')} ${theme.star(`${toolDisplayName(safeName)}(${sanitizeTerminalText(args)})`)}`;
}

/** How many content lines survive before the "… +N lines" collapse. */
export const RESULT_COLLAPSE_LINES = 5;

export interface ToolResultDisplay {
  name: string;
  label: string;
  ok: boolean;
  summary: string;
  content?: string | undefined;
  /** Pre-rendered styled diff lines (from the loop's renderDiff). */
  diff?: readonly string[] | undefined;
}

/** The `⎿` result lines: summary, collapsed content, and the diff. */
export function renderToolResult(info: ToolResultDisplay, theme: Theme): string[] {
  const out: string[] = [];
  const mark = info.ok ? theme.success('⎿') : theme.error('⎿');
  const summary = sanitizeTerminalText(info.summary);
  out.push(`  ${mark} ${info.ok ? theme.dim(summary) : theme.error(summary)}`);
  if (info.content !== undefined && info.content !== '') {
    const lines = sanitizeTerminalText(info.content).split('\n');
    const shown = lines.slice(0, RESULT_COLLAPSE_LINES);
    for (const line of shown) out.push(`      ${theme.dim(line)}`);
    if (lines.length > RESULT_COLLAPSE_LINES) {
      out.push(`      ${theme.dim(`… +${lines.length - RESULT_COLLAPSE_LINES} lines`)}`);
    }
  }
  if (info.diff !== undefined && info.diff.length > 0) {
    // v1.3: the boxed diff renderer produces full-width rows (╭ │ ╰) that
    // must NOT be indented (padding to the terminal width would overflow);
    // legacy pre-rendered rows keep the 6-space indent.
    const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    const boxed = info.diff[0]!.replace(ANSI_RE, '').startsWith('╭');
    for (const line of info.diff) out.push(boxed ? line : `      ${line}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// theme adapters
// ---------------------------------------------------------------------------

/** MarkdownStyle backed by the theme, with boxes bounded by terminal cells. */
export function markdownStyleFor(
  theme: Theme,
  width = process.stdout.columns ?? 80,
): MarkdownStyle {
  const columns = Math.max(1, Math.min(80, Number.isFinite(width) ? Math.floor(width) : 80));
  return {
    heading: (text, level) =>
      level === 1 ? theme.wrap(theme.palette.star, text, { bold: true }) : theme.star(text),
    bold: (text) => theme.wrap(theme.palette.star, text, { bold: true }),
    italic: (text) => theme.dim(text),
    code: (text) => theme.cyan(text),
    bullet: (marker, text, indent) => {
      const pad = '  '.repeat(indent);
      const mark = /^\d+$/.test(marker) ? `${marker}. ` : '• ';
      return `${pad}${theme.violet(mark)}${text}`;
    },
    codeBlock: (lines, lang) => {
      if (columns < 7) return lines.map((line) => truncateTerminalText(line, columns));
      const innerMax = Math.max(3, columns - 6);
      const width = Math.min(
        innerMax,
        Math.max(...lines.map((l) => terminalTextWidth(l)), terminalTextWidth(lang) + 2, 3),
      );
      const safeLang = truncateTerminalText(lang, Math.max(1, width - 2));
      const top =
        safeLang === ''
          ? theme.dim(`╭${'─'.repeat(width + 2)}╮`)
          : theme.dim(
              `╭─ ${theme.cyan(safeLang)} ${'─'.repeat(Math.max(0, width - terminalTextWidth(safeLang) - 1))}╮`,
            );
      const body = lines.map((line) => {
        const l = truncateTerminalText(line, width);
        return theme.dim(`│ ${l}${' '.repeat(Math.max(0, width - terminalTextWidth(l)))} │`);
      });
      const bottom = theme.dim(`╰${'─'.repeat(width + 2)}╯`);
      return [top, ...body, bottom];
    },
    paragraph: (text) => theme.star(text),
    hr: () => theme.dim('─'.repeat(40)),
    quote: (text) => theme.dim(`> ${text}`),
  };
}

/** DiffStyle backed by the theme (identity when color is off). */
export function diffStyleFor(theme: Theme): DiffStyle {
  return {
    add: (text) => theme.success(text),
    del: (text) => theme.error(text),
    ctx: (text) => theme.dim(text),
    meta: (text) => theme.dim(text),
    lineNo: (n) => theme.dim(String(n).padStart(3, ' ')),
  };
}
