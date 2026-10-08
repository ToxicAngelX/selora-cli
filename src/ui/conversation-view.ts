import type { AgentEvent, AgentUsageTotals } from '../agent/loop.js';
import type { DiffPaletteName } from '../diff/types.js';
import { formatCount } from '../format.js';
import { MarkdownStream } from './markdown.js';
import { markdownStyleFor, renderToolResult, renderToolStart } from './chatui.js';
import { TranscriptStore } from './transcript.js';
import type { TerminalSurface } from './terminal-surface.js';
import type { Theme } from './theme.js';
import { sanitizeTerminalText } from './terminal-text.js';

export interface ConversationViewOptions {
  /** Diff palette for file-change tool results (diff config). */
  diffPalette?: DiffPaletteName | undefined;
}

/**
 * Presents identified agent events; never interprets model text as a tool call.
 *
 * Tool headers follow the Claude Code lifecycle on the append-only surface:
 * while a tool runs its `● Name(args)` header sits DIM in the live region
 * (with the phase line); when the result arrives the header commits above the
 * live region with the ● colored by the outcome, followed by the ⎿ result
 * line and — for file changes — the flat numbered diff body. A result whose
 * diff was elided is remembered as the ctrl+r toggle target.
 */
export class ConversationView {
  private readonly transcript = new TranscriptStore();
  private readonly renderedEvents = new Set<string>();
  private readonly pendingTools = new Map<string, { name: string; label: string }>();
  private markdown: MarkdownStream | undefined;
  private assistantId: string | undefined;
  private partial = '';
  private phase = 'Thinking…';
  private started = 0;
  private generated = 0;
  private outputTokens: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sequence = 0;
  /** The most recent elided file-change render — ctrl+r toggles its view. */
  private lastChange: { expanded: boolean; render(expanded: boolean): string[] } | undefined;

  constructor(
    private readonly surface: TerminalSurface,
    private readonly theme: () => Theme,
    private readonly width: () => number,
    private readonly opts: ConversationViewOptions = {},
  ) {}

  user(text: string): void {
    const id = `user:${++this.sequence}`;
    this.transcript.apply({ type: 'replace', id, kind: 'user', text });
    if (this.transcript.markRendered(id)) {
      const rows = sanitizeTerminalText(text).split('\n');
      this.surface.writeOutput(rows.map((row, i) => `${this.theme().gradient(i === 0 ? '❯' : '·')} ${row}`).join('\n'));
    }
  }

  thinking(phase = 'Thinking…'): void {
    this.phase = phase;
    if (this.timer === undefined) {
      this.started = Date.now();
      this.generated = 0;
      this.outputTokens = undefined;
      this.timer = setInterval(() => this.redraw(), 250);
      this.timer.unref?.();
    }
    this.redraw();
  }

  event(event: AgentEvent): void {
    if (event.type === 'assistant-start') {
      this.finishAssistant();
      this.assistantId = event.id;
      this.markdown = new MarkdownStream(markdownStyleFor(this.theme(), this.width()));
      this.transcript.apply({ type: 'replace', id: event.id, kind: 'assistant', text: '' });
      this.thinking();
      return;
    }
    if (event.type === 'assistant-delta') {
      const text = this.transcript.append(event.id, 'assistant', event.text, String(event.sequence));
      if (text === '') return;
      this.generated += text.length;
      this.phase = 'Responding…';
      const rendered = this.markdown?.push(text) ?? text;
      if (rendered !== '') this.surface.writeOutput(rendered);
      this.partial += text;
      const newline = this.partial.lastIndexOf('\n');
      if (newline !== -1) this.partial = this.partial.slice(newline + 1);
      this.redraw();
      return;
    }
    if (event.type === 'assistant-complete') {
      this.finishAssistant();
      return;
    }
    const key = `${event.id}:${event.type}`;
    if (this.renderedEvents.has(key)) return;
    this.renderedEvents.add(key);
    if (event.type === 'tool-start') {
      this.phase = 'Running tools…';
      this.transcript.apply({ type: 'replace', id: event.id, kind: 'tool', text: event.label });
      // The header shows DIM in the live region while the tool runs; the
      // committed (outcome-colored) header lands with the result.
      this.pendingTools.set(event.id, { name: event.name, label: event.label });
    } else if (event.type === 'tool-result') {
      this.transcript.apply({ type: 'replace', id: event.id, kind: 'tool', text: event.summary });
      this.transcript.apply({ type: 'complete', id: event.id });
      const pending = this.pendingTools.get(event.id);
      this.pendingTools.delete(event.id);
      const theme = this.theme();
      const header = renderToolStart(
        pending?.name ?? event.name,
        pending?.label ?? event.label,
        theme,
        event.ok ? 'ok' : 'error',
      );
      const rendered = renderToolResult(event, theme, {
        width: this.width(),
        expandHint: true,
        palette: this.opts.diffPalette,
      });
      this.surface.writeOutput([header, ...rendered.lines].join('\n'));
      // Only the latest elided file change is the ctrl+r target.
      this.lastChange = rendered.fileChange;
      this.phase = 'Thinking…';
    } else {
      this.transcript.apply({ type: 'replace', id: event.id, kind: 'status', text: event.text });
      this.surface.writeOutput(this.theme().dim(sanitizeTerminalText(event.text)));
    }
    this.redraw();
  }

  /**
   * ctrl+r: toggle the most recent elided file-change diff between its
   * collapsed and full view. The surface is append-only, so the alternate
   * view commits as a fresh block below. Returns false when there is nothing
   * to expand (the caller then falls back to history search).
   */
  toggleLastChange(): boolean {
    const change = this.lastChange;
    if (change === undefined) return false;
    change.expanded = !change.expanded;
    const rows = change.render(change.expanded);
    if (rows.length === 0) return false;
    this.surface.writeOutput(rows.join('\n'));
    return true;
  }

  usage(totals: AgentUsageTotals): void {
    this.outputTokens = totals.totalCompletionTokens;
    this.redraw();
  }

  finish(): void {
    this.finishAssistant();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.pendingTools.clear();
    this.surface.setLive([]);
  }

  dispose(): void {
    this.finish();
    this.transcript.clear();
    this.renderedEvents.clear();
  }

  private finishAssistant(): void {
    if (this.assistantId !== undefined) {
      const trailing = this.transcript.flush(this.assistantId);
      if (trailing !== '') this.markdown?.push(trailing);
      const text = this.markdown?.flush() ?? '';
      this.partial = '';
      this.surface.setLive([]);
      if (text !== '') this.surface.writeOutput(text);
      this.transcript.apply({ type: 'complete', id: this.assistantId });
    }
    this.markdown = undefined;
    this.assistantId = undefined;
    this.partial = '';
  }

  private redraw(): void {
    if (this.timer === undefined) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - this.started) / 1000));
    const tokens = this.outputTokens ?? Math.ceil(this.generated / 4);
    const count = tokens > 0 ? ` · ↓ ${this.outputTokens === undefined ? '≈' : ''}${formatCount(BigInt(tokens))} tokens` : '';
    const theme = this.theme();
    const rows: string[] = [];
    for (const pending of this.pendingTools.values()) {
      rows.push(renderToolStart(pending.name, pending.label, theme, 'running'));
    }
    if (this.partial !== '') rows.push(theme.star(this.partial));
    rows.push(theme.violet(`✽ ${this.phase}`) + theme.dim(` (${elapsed}s${count})`));
    rows.push(theme.dim('  ⎿ Tip: Esc stops this turn · type your next prompt below'));
    this.surface.setLive(rows);
  }
}
