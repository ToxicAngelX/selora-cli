import { StringDecoder } from 'node:string_decoder';
import { PromptBuffer, layoutPromptValue } from './promptbar.js';
import {
  MenuModel,
  computeMenuTrigger,
  filterHistoryItems,
  filterSlashCommands,
  listPathMenu,
  renderMenuRows,
  slashCommandItem,
} from './promptmenu.js';
import type { SlashCommand } from './promptmenu.js';
import type { TerminalSurface } from './terminal-surface.js';
import type { Theme } from './theme.js';

export interface PromptInputDeps {
  stdin: NodeJS.ReadableStream;
  surface: TerminalSurface;
  theme: () => Theme;
  cols: () => number;
  rows: () => number;
  footer: () => readonly string[];
  commands: () => readonly SlashCommand[];
  /** Newest first, matching the promptmenu history helpers. */
  history: () => readonly string[];
  cwd: string;
  onSubmit: (line: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
  onMode: () => void;
}

interface RawInput extends NodeJS.ReadableStream {
  setRawMode?: (raw: boolean) => void;
  isRaw?: boolean;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** A single raw stdin owner. No readline echo and no hidden paste placeholders. */
export class PromptInput {
  private readonly buffer = new PromptBuffer();
  private readonly menu = new MenuModel();
  private decoder = new StringDecoder('utf8');
  private attached = false;
  private pausedFlag = false;
  private active = false;
  private rawOwned = false;
  private previousRaw = false;
  private pending = '';
  private paste: string | undefined;
  private hold: NodeJS.Timeout | undefined;
  private explicitSelection = false;
  private menuLatched = false;
  private historyIndex = -1;
  private historyDraft: { value: string; cursor: number } | undefined;
  private searchDraft: { value: string; cursor: number } | undefined;
  private searchPool: readonly string[] = [];
  private lastWasCR = false;

  constructor(private readonly deps: PromptInputDeps) {}

  get line(): string { return this.buffer.state().value; }
  get cursor(): number { return this.buffer.state().cursor; }
  get paused(): boolean { return this.pausedFlag; }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.deps.stdin.on('data', this.onData);
    if (!this.pausedFlag) this.acquire();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.deps.stdin.removeListener('data', this.onData);
    this.release();
    this.resetDecoder();
    this.hide();
    this.deps.stdin.pause();
  }

  prompt(): void {
    this.active = true;
    this.refresh();
  }

  hide(): void {
    this.active = false;
    this.closeMenu(true);
    this.deps.surface.setPrompt(undefined);
  }

  pause(): void {
    if (this.pausedFlag) return;
    this.pausedFlag = true;
    this.release();
    this.resetDecoder();
    this.deps.surface.setPrompt(undefined);
  }

  resume(): void {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    if (this.attached) this.acquire();
    this.refresh();
  }

  setValue(text: string): void {
    this.closeMenu(false);
    this.buffer.setValue(text);
    this.menuLatched = false;
    this.historyIndex = -1;
    this.historyDraft = undefined;
    this.refresh();
  }

  refresh(): void {
    if (!this.active || this.pausedFlag) return;
    this.updateMenu();
    const theme = this.deps.theme();
    const width = Math.max(1, Math.floor(this.deps.cols()) - 1);
    const maxRows = Math.max(0, Math.floor(this.deps.rows()) - 2);
    if (maxRows === 0) {
      this.deps.surface.setPrompt(undefined);
      return;
    }
    const boxed = width >= 8 && maxRows >= 3;
    const contentWidth = Math.max(1, width - (boxed ? 6 : 2));
    const layout = layoutPromptValue(this.line, contentWidth, this.cursor);
    const footer = this.deps.footer().flatMap((line) => line.split('\n'));
    const footerCount = Math.min(footer.length, Math.max(0, maxRows - (boxed ? 3 : 1)));
    const borderCount = boxed ? 2 : 0;
    // Input keeps at least one row; menus get a bounded viewport around selection.
    const menuBudget = Math.min(10, Math.max(0, maxRows - borderCount - footerCount - 1));
    const renderedMenu = renderMenuRows(this.menu, theme, width);
    const menuStart = Math.max(0, this.menu.selection + (this.menu.menuKind === 'history' ? 1 : 0) - menuBudget + 1);
    const menuRows = menuBudget === 0 ? [] : renderedMenu.slice(menuStart, menuStart + menuBudget);
    // The legacy renderer's slash hint says Tab runs: never display that in this editor.
    if (this.menu.menuKind === 'slash' && menuRows.length > 0 && menuRows.at(-1)?.includes('Tab/Enter run')) {
      menuRows[menuRows.length - 1] = theme.dim('  Tab complete · Enter confirm · Esc close');
    }
    const inputBudget = Math.max(1, maxRows - borderCount - footerCount - menuRows.length);
    const start = Math.max(0, Math.min(layout.cursor.row - inputBudget + 1, layout.lines.length - inputBudget));
    const visible = layout.lines.slice(start, start + inputBudget);
    const lines: string[] = [];
    if (boxed) lines.push(theme.dim(`╭${'─'.repeat(width - 2)}╮`));
    for (let i = 0; i < visible.length; i += 1) {
      const line = visible[i]!;
      const logicalRow = start + i;
      const marker = logicalRow === 0 ? theme.gradient('❯') : theme.dim('·');
      if (boxed) {
        const rowWidth = layoutPromptValue(line, Number.MAX_SAFE_INTEGER).cursor.col;
        lines.push(`${theme.dim('│')} ${marker} ${line}${' '.repeat(Math.max(0, contentWidth - rowWidth))}${theme.dim(' │')}`);
      } else {
        lines.push(`${marker} ${line}`);
      }
    }
    if (boxed) lines.push(theme.dim(`╰${'─'.repeat(width - 2)}╯`));
    lines.push(...menuRows, ...footer.slice(0, footerCount).map((line) => theme.dim(line)));
    this.deps.surface.setPrompt({
      lines,
      cursor: {
        row: (boxed ? 1 : 0) + layout.cursor.row - start,
        col: (boxed ? 4 : 2) + layout.cursor.col,
      },
    });
  }

  private acquire(): void {
    if (this.rawOwned) return;
    const stdin = this.deps.stdin as RawInput;
    this.previousRaw = stdin.isRaw === true;
    stdin.setRawMode?.(true);
    this.rawOwned = true;
    this.deps.surface.writeControl('\x1b[?2004h');
    stdin.resume();
  }

  private release(): void {
    if (!this.rawOwned) return;
    this.deps.surface.writeControl('\x1b[?2004l');
    (this.deps.stdin as RawInput).setRawMode?.(this.previousRaw);
    this.rawOwned = false;
  }

  private resetDecoder(): void {
    this.clearHold();
    this.pending = '';
    this.paste = undefined;
    this.decoder = new StringDecoder('utf8');
    this.lastWasCR = false;
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (!this.attached || this.pausedFlag) return;
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.clearHold();
    this.drain();
    this.refresh();
  };

  private drain(): void {
    while (this.pending !== '' && this.attached && !this.pausedFlag) {
      if (this.paste !== undefined) {
        const end = this.pending.indexOf(PASTE_END);
        if (end !== -1) {
          this.paste += this.pending.slice(0, end);
          this.pending = this.pending.slice(end + PASTE_END.length);
          this.buffer.insert(this.paste);
          this.paste = undefined;
          this.edited();
          continue;
        }
        // Retain only a possible split end delimiter, not the entire pasted body.
        let keep = 0;
        for (let i = 1; i < PASTE_END.length; i += 1) {
          if (this.pending.endsWith(PASTE_END.slice(0, i))) keep = i;
        }
        this.paste += this.pending.slice(0, this.pending.length - keep);
        this.pending = keep === 0 ? '' : this.pending.slice(-keep);
        return;
      }
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.paste = '';
        this.lastWasCR = false;
        continue;
      }
      if (this.pending[0] === '\x1b') {
        const csi = new RegExp(`^${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`).exec(this.pending);
        const ss3 = new RegExp(`^${String.fromCharCode(27)}O[ -~]`).exec(this.pending);
        const sequence = csi?.[0] ?? ss3?.[0];
        if (sequence !== undefined) {
          this.pending = this.pending.slice(sequence.length);
          this.lastWasCR = false;
          this.escapeSequence(sequence);
          continue;
        }
        if (this.pending === String.fromCharCode(27) || new RegExp(`^${String.fromCharCode(27)}(?:\\[[0-?]*[ -/]*|O)$`).test(this.pending)) {
          this.armHold();
          return;
        }
        const meta = this.pending[1];
        this.pending = this.pending.slice(2);
        if (meta === 'b') this.buffer.moveWordLeft();
        else if (meta === 'f') this.buffer.moveWordRight();
        else if (meta === '\x7f' || meta === '\b') this.buffer.deleteWordBackward();
        else if (meta === 'd') this.buffer.deleteWordForward();
        else if (meta === '\r' || meta === '\n') this.insertNewline();
        else this.escape();
        continue;
      }
      const ch = this.pending[0]!;
      this.pending = this.pending.slice(1);
      const precedingCR = this.lastWasCR;
      this.lastWasCR = ch === '\r';
      if (ch === '\r') this.enter();
      else if (ch === '\n') { if (!precedingCR) this.insertNewline(); }
      else if (ch === '\x03') { this.closeMenu(true); this.deps.onInterrupt(); }
      else if (ch === '\x04') { if (this.line === '') this.deps.onExit(); else { this.buffer.deleteForward(); this.edited(); } }
      else if (ch === '\t') this.complete();
      else if (ch === '\x12') this.searchHistory();
      else if (ch === '\x7f' || ch === '\b') { this.buffer.backspace(); this.edited(); }
      else if (ch === '\x01') this.buffer.moveHome();
      else if (ch === '\x05') this.buffer.moveEnd();
      else if (ch === '\x02') this.buffer.moveLeft();
      else if (ch === '\x06') this.buffer.moveRight();
      else if (ch === '\x17') { this.buffer.deleteWordBackward(); this.edited(); }
      else if (ch === '\x15') { this.buffer.deleteToHome(); this.edited(); }
      else if (ch === '\x0b') { this.buffer.deleteToEnd(); this.edited(); }
      else if (ch >= ' ') {
        // Keep the ordinary Unicode run together, including surrogate pairs.
        const match = new RegExp(`^[^${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`).exec(ch + this.pending);
        const text = match?.[0] ?? ch;
        this.pending = this.pending.slice(text.length - 1);
        this.buffer.insert(text);
        this.edited();
      }
      this.updateMenu();
    }
  }

  private escapeSequence(seq: string): void {
    if (new RegExp(`^${String.fromCharCode(27)}\\[(?:13;2(?::[123])?u|13;2~|27;2;13~)$`).test(seq)) this.insertNewline();
    else if (seq === '\x1b[A' || seq === '\x1bOA') this.navigate(-1);
    else if (seq === '\x1b[B' || seq === '\x1bOB') this.navigate(1);
    else if (seq === '\x1b[D' || seq === '\x1bOD') this.buffer.moveLeft();
    else if (seq === '\x1b[C' || seq === '\x1bOC') this.buffer.moveRight();
    else if (new RegExp(`^${String.fromCharCode(27)}\\[1;[35]D$`).test(seq)) this.buffer.moveWordLeft();
    else if (new RegExp(`^${String.fromCharCode(27)}\\[1;[35]C$`).test(seq)) this.buffer.moveWordRight();
    else if (['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~'].includes(seq)) this.buffer.moveHome();
    else if (['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~'].includes(seq)) this.buffer.moveEnd();
    else if (seq === '\x1b[3~') { this.buffer.deleteForward(); this.edited(); }
    else if (seq === '\x1b[3;5~') { this.buffer.deleteWordForward(); this.edited(); }
    else if (seq === '\x1b[Z') { if (this.menu.isOpen) { this.menu.move(-1); this.explicitSelection = true; } else this.deps.onMode(); }
    else if (seq === '\x1b[13u') this.enter();
    // Unknown terminal reports are consumed, never inserted into the draft.
    this.updateMenu();
  }

  private armHold(): void {
    this.hold = setTimeout(() => {
      this.hold = undefined;
      const lone = this.pending === '\x1b';
      this.pending = '';
      if (lone) this.escape();
      this.refresh();
    }, 50);
    this.hold.unref?.();
  }

  private clearHold(): void {
    if (this.hold !== undefined) clearTimeout(this.hold);
    this.hold = undefined;
  }

  private escape(): void {
    if (this.menu.isOpen) {
      this.closeMenu(true);
      this.menuLatched = true;
    } else this.deps.onInterrupt();
  }

  private edited(): void {
    this.explicitSelection = false;
    this.menuLatched = false;
    this.historyIndex = -1;
    this.historyDraft = undefined;
  }

  private insertNewline(): void {
    this.buffer.insert('\n');
    this.edited();
  }

  private enter(): void {
    if (this.line.slice(0, this.cursor).endsWith('\\')) {
      this.buffer.backspace();
      this.insertNewline();
      return;
    }
    if (this.menu.isOpen) {
      if (this.menu.menuKind === 'history' || this.menu.menuKind === 'path') {
        this.complete();
        return;
      }
      const item = this.menu.current;
      if (item !== undefined && this.line !== item.insert) {
        const confirmed = this.explicitSelection;
        this.complete();
        if (!confirmed) return;
      }
    }
    this.closeMenu(false);
    this.menuLatched = false;
    this.historyIndex = -1;
    this.historyDraft = undefined;
    // Clear FIRST: a synchronous onSubmit may reprompt, pause, or set a draft.
    const line = this.buffer.submit();
    this.refresh();
    this.deps.onSubmit(line);
  }

  private navigate(delta: -1 | 1): void {
    if (this.menu.isOpen) {
      this.menu.move(delta);
      this.explicitSelection = true;
      return;
    }
    if (this.buffer.moveVertical(delta)) return;
    const history = this.deps.history();
    if (history.length === 0) return;
    if (this.historyIndex === -1) {
      if (delta === 1) return;
      this.historyDraft = this.buffer.state();
    }
    this.historyIndex = Math.max(-1, Math.min(history.length - 1, this.historyIndex - delta));
    if (this.historyIndex === -1) {
      if (this.historyDraft !== undefined) this.buffer.setValue(this.historyDraft.value, this.historyDraft.cursor);
      this.historyDraft = undefined;
    } else {
      const text = history[this.historyIndex]!;
      this.buffer.setValue(text, delta === -1 ? 0 : text.length);
    }
  }

  private searchHistory(): void {
    if (this.searchDraft !== undefined) return;
    const pool = this.deps.history();
    if (pool.length === 0) return;
    this.closeMenu(false);
    this.searchDraft = this.buffer.state();
    this.searchPool = [...pool];
    this.buffer.setValue('');
    const listing = filterHistoryItems(this.searchPool, '');
    this.menu.open('history', listing.items, listing.total, 0);
    this.menuLatched = false;
  }

  private complete(): void {
    this.updateMenu();
    const item = this.menu.current;
    if (item === undefined) return;
    const start = this.menu.token;
    const kind = this.menu.menuKind;
    this.searchDraft = undefined;
    this.closeMenu(false);
    this.buffer.setValue(kind === 'path' ? this.line.slice(0, start) + item.insert : item.insert);
    this.edited();
    // Exact slash commands can submit on the NEXT Enter. Tab itself never runs.
    this.menuLatched = kind === 'history' || (kind === 'path' && item.kind !== 'dir');
    this.updateMenu();
  }

  private closeMenu(restoreSearch: boolean): void {
    if (restoreSearch && this.searchDraft !== undefined) {
      this.buffer.setValue(this.searchDraft.value, this.searchDraft.cursor);
    }
    this.searchDraft = undefined;
    this.menu.close();
    this.explicitSelection = false;
  }

  private updateMenu(): void {
    if (this.searchDraft !== undefined) {
      const listing = filterHistoryItems(this.searchPool, this.line);
      this.menu.update(listing.items, listing.total, 0);
      return;
    }
    if (this.menuLatched) return;
    const trigger = computeMenuTrigger(this.line, this.cursor);
    if (trigger === null) {
      this.closeMenu(false);
      return;
    }
    const listing = trigger.kind === 'slash'
      ? (() => { const items = filterSlashCommands(this.deps.commands(), trigger.filter).map(slashCommandItem); return { items, total: items.length }; })()
      : listPathMenu(this.deps.cwd, trigger.filter);
    if (listing.items.length === 0) {
      this.closeMenu(false);
      return;
    }
    const only = listing.items.length === 1 ? listing.items[0] : undefined;
    if (trigger.kind === 'path' && only?.kind !== 'dir' && only?.insert === this.line.slice(trigger.tokenStart)) {
      this.closeMenu(false);
      return;
    }
    if (this.menu.isOpen && this.menu.menuKind === trigger.kind) this.menu.update(listing.items, listing.total, trigger.tokenStart);
    else {
      this.menu.open(trigger.kind, listing.items, listing.total, trigger.tokenStart);
      this.explicitSelection = false;
    }
  }
}
