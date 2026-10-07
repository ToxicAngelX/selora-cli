/**
 * The workspace trust screen (v0.8) — the Claude-Code-style one-time folder
 * check shown before the chat REPL when the cwd is not yet trusted:
 *
 *   Accessing workspace:
 *
 *    ~/project
 *
 *    Quick safety check: is this a folder you created or one you trust? Selora
 *    will be able to read, edit, and run commands here.
 *
 *   ❯ 1. Yes, I trust this folder
 *     2. No, exit
 *
 *   Enter to confirm · Esc to cancel
 *
 * The menu REUSES the v0.7 picker engine (promptmenu.pickFromList): arrow
 * keys move, Enter confirms, Esc (or Ctrl+C) cancels. Option 1 persists the
 * folder (trusted.json, 0600 — asked ONCE per folder) and chat continues;
 * option 2 / Esc prints one short line and exits 0.
 *
 * The gate is deliberately strict: non-TTY stdin, --json, --yes, NO_COLOR,
 * TERM=dumb, and raw-incapable stdin NEVER show the screen — pipelines must
 * not block. (--yes already is the stronger commitment: it implies trust for
 * the session and persists nothing.) The raw-mode requirement mirrors the
 * permission menu's: without per-key delivery the arrow-key UI would be a
 * degraded prompt, and the sandbox never depended on this screen — the
 * permission system remains the enforcement layer.
 */

import type { Theme } from './theme.js';
import { pickFromList } from './promptmenu.js';
import { canonicalDir, homeAbbrev, trustDir } from '../config/trust.js';

/** The one place the trust-screen gate is decided (pure — unit-testable). */
export function trustScreenCapable(opts: {
  isTTY: boolean;
  json: boolean;
  yes: boolean;
  stdinRawCapable: boolean;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (!opts.isTTY) return false;
  if (opts.json) return false;
  if (opts.yes) return false;
  if (!opts.stdinRawCapable) return false;
  if (opts.env['NO_COLOR'] !== undefined) return false;
  if ((opts.env['TERM'] ?? '') === 'dumb') return false;
  return true;
}

export interface TrustScreenIo {
  /** The REAL stdin (raw-mode capable — the gate already verified that). */
  stdin: NodeJS.ReadableStream;
  /** Raw stderr write — the screen draws on the UI channel, like the menus. */
  write: (s: string) => void;
}

/**
 * Show the trust screen for `cwd` (already known to be untrusted). Resolves
 * true when the user trusted the folder (persisted); false on "No, exit" /
 * Esc / Ctrl+C / closed stdin — the caller exits 0 without starting the REPL.
 */
export async function runTrustScreen(opts: {
  cwd: string;
  theme: Theme;
  io: TrustScreenIo;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const env = opts.env ?? process.env;
  const theme = opts.theme;
  // The screen runs before the REPL: chat's sandbox root always exists, but
  // stay honest if a test seam hands in something odd.
  const real = canonicalDir(opts.cwd) ?? opts.cwd;
  const shown = homeAbbrev(real, env);

  const title = [
    'Accessing workspace:',
    '',
    ` ${shown}`,
    '',
    ' Quick safety check: is this a folder you created or one you trust? Selora will be able to',
    ' read, edit, and run commands here.',
    '',
  ].join('\n');

  const picked = await pickFromList(
    title,
    [{ label: '1. Yes, I trust this folder' }, { label: '2. No, exit' }],
    0,
    {
      stdin: opts.io.stdin,
      write: opts.io.write,
      pauseInput: () => {},
      resumeInput: () => {},
      theme,
      footer: '\nEnter to confirm · Esc to cancel',
    },
  );

  // The picker leaves raw mode ON (the REPL's readline wants it anyway) —
  // restore cooked mode on the exit path or the shell comes back broken.
  const restoreCooked = (): void => {
    try {
      (opts.io.stdin as { setRawMode?(mode: boolean): void }).setRawMode?.(false);
    } catch {
      // best effort
    }
  };

  if (picked !== 0) {
    restoreCooked();
    opts.io.write(`${theme.dim('· not trusted — exiting')}\n`);
    return false;
  }
  trustDir(real, env);
  opts.io.write(`${theme.dim(`· trusted ${shown} — selora won't ask about this folder again`)}\n`);
  return true;
}
