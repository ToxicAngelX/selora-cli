/**
 * src/diff/review.ts — REVIEW: the interactive approve/reject gate of the
 * diff subsystem.
 *
 * Pipeline position: the ENGINE computes a FileDiff, the RENDERER turns it
 * into styled lines, REVIEW shows those lines and collects a ReviewDecision,
 * and only then does SAFETY write anything. Review itself NEVER touches the
 * filesystem — its only outputs are io.write lines and the decision it
 * returns.
 *
 * Decisions (types.ts): apply this file · apply only selected hunks · apply
 * this and all remaining files · reject (with an optional reason fed back to
 * the model) · cancel the whole review. The mode short-circuits the gate:
 * 'auto' renders and applies without asking, 'dry-run' renders and rejects
 * with reason 'dry-run' so the caller writes nothing.
 *
 * The interaction model mirrors agent/permissions.ts (the proven gate):
 *  - Key parsing is a pure exported function (parseReviewKey): one raw stdin
 *    chunk in, one semantic key out. Unknown bytes are ignored, never fatal;
 *    q / Esc / Ctrl+C all mean cancel.
 *  - TTY + raw-capable stdin → a single-key raw-mode loop. The caller's line
 *    editor is paused, stdin is resumed, and one 'data' listener drives a
 *    small state machine (main prompt ↔ the hunk-by-hunk sub-flow). EVERY
 *    exit path runs through ONE idempotent restore() in a finally: listeners
 *    removed, setRawMode(false) (best-effort, guarded), line editor resumed.
 *    Ctrl+C mid-hunk therefore cancels cleanly instead of wedging the
 *    terminal in raw mode.
 *  - A reject is resolved in TWO phases exactly like permissions'
 *    menuAskWithReason: the raw loop ends (terminal back in cooked mode) and
 *    only then is the optional reason line read via nextLine — the reason
 *    goes back to the model.
 *  - Non-TTY / piped stdin → the same prompt printed as one line, answers
 *    read as lines until a decision arrives. [h] and [s] need a TTY and
 *    degrade to honest one-line notes; [e] still reprints the full diff. EOF
 *    without an answer CANCELS — the safe default, with a note, never a
 *    hang.
 *  - Line answers come from the caller's shared line source (nextLine — the
 *    chat REPL owns its readline and must never get a second listener) or,
 *    when absent, from a readline this module owns for the duration of the
 *    call (the permissions.ts owned-readline pattern: line queue + waiter
 *    list, 'close' rejects pending waiters, an already-ended stdin is
 *    detected up front so a late-attached pipe can never hang, and the
 *    readline is closed when the review settles).
 *
 * renderChangeSetSummary is a pure, theme-styled table for a whole change
 * set: one row per file (✚ created / ✎ modified / ✖ deleted / ➜ renamed)
 * with right-aligned +added −removed stats ('(binary)' for binary files) and
 * a totals row. Paths are truncated by DISPLAY width (string-width), so wide
 * glyphs never break the column, and at color level 0 every line is plain
 * text — zero ANSI, always readable.
 */

import * as readline from 'node:readline';
import stringWidth from 'string-width';
import { renderFileDiff } from './renderer.js';
import type {
  FileDiff,
  RenderOptions,
  ReviewDecision,
  ReviewMode,
  SecretFinding,
} from './types.js';
import type { Theme } from '../ui/theme.js';

// ---------------------------------------------------------------------------
// public API — the io channel, the request, the options
// ---------------------------------------------------------------------------

export interface ReviewIo {
  stdin: NodeJS.ReadableStream;
  isTTY: boolean;
  /** Styled output channel (stderr in the app) — ONE line per call, no trailing newline. */
  write: (s: string) => void;
  /**
   * Line answers (the non-TTY prompt, the reject-reason line) from the
   * caller's SHARED line source. Absent → review owns a readline over stdin
   * for the duration of the call (permissions.ts owned-readline pattern).
   */
  nextLine?: (() => Promise<string>) | undefined;
  pauseInput?: (() => void) | undefined;
  resumeInput?: (() => void) | undefined;
}

export interface ReviewRequest {
  diff: FileDiff;
  /** Position in a multi-file change set (1-based), shown as "file 2 of 5". */
  position?: { index: number; total: number } | undefined;
  secrets?: readonly SecretFinding[] | undefined;
  /** Conflict warning text (file changed on disk since read) — shown prominently. */
  conflict?: string | undefined;
}

export interface ReviewOptions {
  mode: ReviewMode;
  theme: Theme;
  render?: RenderOptions | undefined;
}

// ---------------------------------------------------------------------------
// key parsing (pure, exported for tests — the parseMenuKey pattern)
// ---------------------------------------------------------------------------

export type ReviewKey =
  'apply' | 'reject' | 'apply-all' | 'hunks' | 'expand' | 'toggle-view' | 'cancel' | 'other';

/** Parse one raw-mode stdin chunk into a review key. Anything else is ignored. */
export function parseReviewKey(data: string): ReviewKey {
  if (data === 'y' || data === 'Y' || data === '\r' || data === '\n') return 'apply';
  if (data === 'n' || data === 'N') return 'reject';
  if (data === 'a' || data === 'A') return 'apply-all';
  if (data === 'h' || data === 'H') return 'hunks';
  if (data === 'e' || data === 'E') return 'expand';
  if (data === 's' || data === 'S') return 'toggle-view';
  if (data === 'q' || data === 'Q' || data === '\x1b' || data === '\x03') return 'cancel';
  return 'other';
}

/** Keys inside the hunk sub-flow: q stops (keeping the picks), Esc/Ctrl+C cancel outright. */
type HunkKey = 'apply' | 'skip' | 'apply-rest' | 'stop' | 'cancel' | 'other';

function parseHunkKey(data: string): HunkKey {
  if (data === 'y' || data === 'Y' || data === '\r' || data === '\n') return 'apply';
  if (data === 'n' || data === 'N') return 'skip';
  if (data === 'a' || data === 'A') return 'apply-rest';
  if (data === 'q' || data === 'Q') return 'stop';
  if (data === '\x1b' || data === '\x03') return 'cancel';
  return 'other';
}

// ---------------------------------------------------------------------------
// prompt + note strings (pinned — tests assert them)
// ---------------------------------------------------------------------------

const REVIEW_PROMPT =
  '[y] apply  [n] reject  [a] apply all  [h] hunks  [e] expand  [s] split  [q] cancel';
const REASON_PROMPT = 'Reason (optional — sent to the model; empty = none):';
const HUNK_SEPARATOR = '─'.repeat(60);
const CLOSED_NOTE = '· input closed — review cancelled';
const DRY_RUN_NOTE = '(dry-run — nothing will be written)';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

interface RawCapable {
  setRawMode?(mode: boolean): void;
}

function rawCapable(stdin: NodeJS.ReadableStream): boolean {
  const candidate = stdin as unknown as RawCapable;
  return typeof candidate.setRawMode === 'function';
}

/** Write one line per rendered row (the channel owns the newline). */
function emit(io: ReviewIo, lines: readonly string[]): void {
  for (const line of lines) io.write(line);
}

/**
 * The line answer source: either the caller's shared source (the chat REPL —
 * never double-listened) or a readline this module owns for this call. The
 * owned side is the permissions.ts pattern: a queue for lines that arrive
 * before anyone waits, a waiter list, 'close' rejects every pending waiter
 * (prompts fail safe to cancel), and close() when the review settles so an
 * open readline over a TTY can never keep the process alive.
 */
interface LineSource {
  nextLine: () => Promise<string>;
  pauseInput: () => void;
  resumeInput: () => void;
  close: () => void;
}

function createLineSource(io: ReviewIo): LineSource {
  if (io.nextLine !== undefined) {
    const shared = io.nextLine;
    return {
      nextLine: shared,
      pauseInput: io.pauseInput ?? ((): void => undefined),
      resumeInput: io.resumeInput ?? ((): void => undefined),
      close: (): void => undefined,
    };
  }

  const queued: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: () => void }> = [];
  let closed = false;
  const rl = readline.createInterface({ input: io.stdin, terminal: io.isTTY });
  rl.on('line', (line: string) => {
    const w = waiters.shift();
    if (w !== undefined) w.resolve(line);
    else queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!.reject();
  });
  // A stdin that ended BEFORE the readline attached never emits another
  // 'end'/'close' — treat it as closed up front so the prompt fails safe.
  if ((io.stdin as unknown as { readableEnded?: boolean }).readableEnded === true) {
    closed = true;
    rl.close();
  }

  const nextLine = (): Promise<string> => {
    const buffered = queued.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (closed) return Promise.reject(new Error('review input closed'));
    return new Promise<string>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  };

  return {
    nextLine,
    pauseInput:
      io.pauseInput ??
      ((): void => {
        rl.pause();
      }),
    resumeInput:
      io.resumeInput ??
      ((): void => {
        if (!closed) rl.resume();
      }),
    close: (): void => {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}

/** The header block: position, the rendered diff, secret warnings, conflict. */
function printBlock(
  req: ReviewRequest,
  io: ReviewIo,
  theme: Theme,
  renderOpts: RenderOptions,
): void {
  if (req.position !== undefined) {
    io.write(theme.dim(`file ${req.position.index} of ${req.position.total}`));
  }
  emit(io, renderFileDiff(req.diff, theme, renderOpts));
  if (req.secrets !== undefined) {
    for (const finding of req.secrets) {
      io.write(
        theme.warning(
          `⚠ possible secret on line ${finding.line} (${finding.rule}): ${finding.snippet}`,
        ),
      );
    }
  }
  if (req.conflict !== undefined && req.conflict !== '') {
    io.write(theme.warning(`⚠ ${req.conflict}`));
  }
}

/** The reason line after a reject — always in cooked mode, always optional. */
async function askReason(
  io: ReviewIo,
  nextLine: () => Promise<string>,
): Promise<string | undefined> {
  io.write(REASON_PROMPT);
  try {
    const trimmed = (await nextLine()).trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    // input closed mid-reason — a reasonless reject is still an honest reject
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// the TTY raw-mode loop (main prompt + hunk sub-flow in one state machine)
// ---------------------------------------------------------------------------

async function rawReviewLoop(
  req: ReviewRequest,
  io: ReviewIo,
  theme: Theme,
  baseRender: RenderOptions,
  lines: LineSource,
): Promise<ReviewDecision> {
  const stdin = io.stdin as unknown as RawCapable & NodeJS.ReadableStream;
  const diff = req.diff;
  const total = diff.hunks.length;
  let work: RenderOptions = { ...baseRender };
  // 'auto'/absent starts unified; the first [s] flip lands on split.
  let view: 'unified' | 'split' = baseRender.view === 'split' ? 'split' : 'unified';

  // The line editor is paused while we own stdin in raw mode.
  lines.pauseInput();
  try {
    stdin.setRawMode?.(true);
    stdin.resume();
  } catch {
    // best effort — key handling still works without raw mode
  }

  let restored = false;
  let onData: (chunk: Buffer | string) => void;
  let onEnd: () => void;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stdin.removeListener('data', onData);
    stdin.removeListener('end', onEnd);
    try {
      stdin.setRawMode?.(false);
    } catch {
      // best effort — a dead tty must not break the answer path
    }
    lines.resumeInput();
  };

  try {
    return await new Promise<ReviewDecision>((resolve) => {
      let settled = false;
      const finish = (decision: ReviewDecision): void => {
        if (settled) return;
        settled = true;
        resolve(decision); // restore() runs in the finally, before the caller resumes
      };

      interface HunkState {
        index: number;
        accepted: number[];
      }
      let hunkState: HunkState | undefined;

      const printPrompt = (): void => io.write(REVIEW_PROMPT);

      const reprint = (): void => {
        emit(io, renderFileDiff(diff, theme, work));
        printPrompt();
      };

      const presentHunk = (s: HunkState): void => {
        io.write(theme.dim(HUNK_SEPARATOR));
        const hunk = diff.hunks[s.index];
        if (hunk !== undefined) {
          const single: FileDiff = { ...diff, hunks: [hunk] };
          emit(io, renderFileDiff(single, theme, work));
        }
        io.write(`[y] apply hunk ${s.index + 1}/${total}  [n] skip  [a] apply rest  [q] stop`);
      };

      const finishHunks = (accepted: readonly number[]): void => {
        io.write(theme.dim(`· ${accepted.length} of ${total} hunks selected`));
        finish({ action: 'apply-hunks', accepted });
      };

      const advanceHunks = (s: HunkState): void => {
        const next = s.index + 1;
        if (next >= total) {
          finishHunks(s.accepted);
          return;
        }
        hunkState = { index: next, accepted: s.accepted };
        presentHunk(hunkState);
      };

      const onHunkKey = (s: HunkState, data: string): void => {
        switch (parseHunkKey(data)) {
          case 'apply':
            s.accepted.push(s.index);
            advanceHunks(s);
            return;
          case 'skip':
            advanceHunks(s);
            return;
          case 'apply-rest': {
            for (let i = s.index; i < total; i += 1) s.accepted.push(i);
            finishHunks(s.accepted);
            return;
          }
          case 'stop':
            finishHunks(s.accepted);
            return;
          case 'cancel':
            finish({ action: 'cancel' });
            return;
          default:
            return; // unrecognized key — keep waiting
        }
      };

      const onMainKey = (data: string): void => {
        switch (parseReviewKey(data)) {
          case 'apply':
            finish({ action: 'apply' });
            return;
          case 'apply-all':
            finish({ action: 'apply-all' });
            return;
          case 'reject':
            // The reason line is read by the caller AFTER restore (cooked mode).
            finish({ action: 'reject', reason: undefined });
            return;
          case 'cancel':
            finish({ action: 'cancel' });
            return;
          case 'expand':
            work = { ...work, maxLines: 0, expandGenerated: true };
            io.write(theme.dim('· expanded — showing the full diff'));
            reprint();
            return;
          case 'toggle-view':
            view = view === 'split' ? 'unified' : 'split';
            work = { ...work, view };
            io.write(theme.dim(`· ${view} view`));
            reprint();
            return;
          case 'hunks':
            if (total === 0) {
              io.write(theme.dim('· no hunks to review'));
              printPrompt();
              return;
            }
            hunkState = { index: 0, accepted: [] };
            presentHunk(hunkState);
            return;
          default:
            return; // unrecognized key — keep waiting
        }
      };

      onData = (chunk: Buffer | string): void => {
        if (settled) return;
        const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (hunkState !== undefined) onHunkKey(hunkState, data);
        else onMainKey(data);
      };

      onEnd = (): void => {
        if (settled) return;
        io.write(theme.dim(CLOSED_NOTE));
        finish({ action: 'cancel' }); // safe default — never hang on a closed stdin
      };

      printPrompt();
      stdin.on('data', onData);
      stdin.on('end', onEnd);
    });
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// the non-TTY line loop (piped stdin — the honest-degradation path)
// ---------------------------------------------------------------------------

async function lineReviewLoop(
  req: ReviewRequest,
  io: ReviewIo,
  theme: Theme,
  baseRender: RenderOptions,
  lines: LineSource,
): Promise<ReviewDecision> {
  let work: RenderOptions = { ...baseRender };
  const printPrompt = (): void => io.write(REVIEW_PROMPT);
  printPrompt();
  for (;;) {
    let raw: string;
    try {
      raw = await lines.nextLine();
    } catch {
      io.write(theme.dim(CLOSED_NOTE));
      return { action: 'cancel' }; // safe default on EOF
    }
    const a = raw.trim().toLowerCase();
    if (a === 'y' || a === 'yes') return { action: 'apply' };
    if (a === 'n' || a === 'no') return { action: 'reject', reason: undefined };
    if (a === 'a' || a === 'all') return { action: 'apply-all' };
    if (a === 'q' || a === 'quit') return { action: 'cancel' };
    if (a === 'e' || a === 'expand') {
      work = { ...work, maxLines: 0, expandGenerated: true };
      io.write(theme.dim('· expanded — showing the full diff'));
      emit(io, renderFileDiff(req.diff, theme, work));
      printPrompt();
      continue;
    }
    if (a === 's' || a === 'split') {
      io.write(theme.dim('· split needs a TTY — keeping the current view'));
      printPrompt();
      continue;
    }
    if (a === 'h' || a === 'hunks') {
      io.write(theme.dim('· hunk review needs a TTY — answer [y/n/a] for the whole file'));
      printPrompt();
      continue;
    }
    printPrompt(); // unrecognized — re-ask
  }
}

// ---------------------------------------------------------------------------
// the gate itself
// ---------------------------------------------------------------------------

/**
 * Present one FileDiff and collect the user's decision. Renders through
 * renderFileDiff, never writes files. Mode 'auto' applies without asking;
 * 'dry-run' rejects with reason 'dry-run' after printing the diff.
 */
export async function reviewChange(
  req: ReviewRequest,
  io: ReviewIo,
  opts: ReviewOptions,
): Promise<ReviewDecision> {
  const theme = opts.theme;
  const baseRender = opts.render ?? {};
  printBlock(req, io, theme, baseRender);
  if (opts.mode === 'auto') return { action: 'apply' };
  if (opts.mode === 'dry-run') {
    io.write(theme.dim(DRY_RUN_NOTE));
    return { action: 'reject', reason: 'dry-run' };
  }

  const lines = createLineSource(io);
  try {
    const useRaw = io.isTTY && rawCapable(io.stdin);
    const decision = useRaw
      ? await rawReviewLoop(req, io, theme, baseRender, lines)
      : await lineReviewLoop(req, io, theme, baseRender, lines);
    if (decision.action !== 'reject') return decision;
    // Cooked mode by now (the raw loop restored in its finally) — read the
    // optional reason line and attach it to the reject.
    const reason = await askReason(io, lines.nextLine);
    return { action: 'reject', reason };
  } finally {
    lines.close();
  }
}

// ---------------------------------------------------------------------------
// change-set summary (pure)
// ---------------------------------------------------------------------------

/** Max display columns for the path column — longer paths end in '…'. */
const SUMMARY_PATH_WIDTH = 56;

/** Truncate to a DISPLAY width budget, appending '…' when anything was cut. */
function truncateDisplay(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (width + cw > maxWidth - 1) break;
    out += ch;
    width += cw;
  }
  return `${out}…`;
}

function kindIcon(theme: Theme, kind: FileDiff['change']['kind']): string {
  switch (kind) {
    case 'created':
      return theme.success('✚');
    case 'modified':
      return theme.cyan('✎');
    case 'deleted':
      return theme.error('✖');
    case 'renamed':
      return theme.violet('➜');
  }
}

/**
 * A compact table of a change set: one row per file
 * (`2. ✎ src/app.ts  +12 −3`), stats right-aligned, binary files marked
 * `(binary)`, and a totals row (`5 files · +120 −45`). Theme-styled but
 * fully readable at color level 0. Pure — no I/O, never throws.
 */
export function renderChangeSetSummary(diffs: readonly FileDiff[], theme: Theme): string[] {
  const indexWidth = String(Math.max(diffs.length, 1)).length;
  const paths = diffs.map((d) => truncateDisplay(d.change.path, SUMMARY_PATH_WIDTH));
  const pathWidth = diffs.length === 0 ? 0 : Math.max(...paths.map((p) => stringWidth(p)));
  const statsPlain = diffs.map((d) =>
    d.binary !== undefined ? '(binary)' : `+${d.stats.added} −${d.stats.removed}`,
  );
  const statsWidth = diffs.length === 0 ? 0 : Math.max(...statsPlain.map((s) => stringWidth(s)));

  const rows: string[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  diffs.forEach((d, i) => {
    totalAdded += d.stats.added;
    totalRemoved += d.stats.removed;
    const num = theme.dim(`${String(i + 1).padStart(indexWidth)}.`);
    const icon = kindIcon(theme, d.change.kind);
    const path = paths[i]!;
    const pathCell = path + ' '.repeat(Math.max(0, pathWidth - stringWidth(path)));
    const plain = statsPlain[i]!;
    const pad = ' '.repeat(Math.max(0, statsWidth - stringWidth(plain)));
    const statsCell =
      d.binary !== undefined
        ? pad + theme.dim(plain)
        : pad + theme.success(`+${d.stats.added}`) + ' ' + theme.error(`−${d.stats.removed}`);
    rows.push(`${num} ${icon} ${pathCell}  ${statsCell}`);
  });

  const files = `${diffs.length} file${diffs.length === 1 ? '' : 's'}`;
  rows.push(
    theme.bold(files) +
      theme.dim(' · ') +
      theme.success(`+${totalAdded}`) +
      ' ' +
      theme.error(`−${totalRemoved}`),
  );
  return rows;
}
