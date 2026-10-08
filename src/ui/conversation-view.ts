import type { AgentEvent, AgentUsageTotals } from '../agent/loop.js';
import { formatCount } from '../format.js';
import { MarkdownStream } from './markdown.js';
import { markdownStyleFor, renderToolResult, renderToolStart } from './chatui.js';
import { TranscriptStore } from './transcript.js';
import type { TerminalSurface } from './terminal-surface.js';
import type { Theme } from './theme.js';
import { sanitizeTerminalText } from './terminal-text.js';

/** Presents identified agent events; never interprets model text as a tool call. */
export class ConversationView {
  private readonly transcript = new TranscriptStore();
  private readonly renderedEvents = new Set<string>();
  private markdown: MarkdownStream | undefined;
  private assistantId: string | undefined;
  private partial = '';
  private phase = 'Thinking…';
  private started = 0;
  private generated = 0;
  private outputTokens: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sequence = 0;

  constructor(
    private readonly surface: TerminalSurface,
    private readonly theme: () => Theme,
    private readonly width: () => number,
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
      this.surface.writeOutput(renderToolStart(event.name, event.label, this.theme()));
    } else if (event.type === 'tool-result') {
      this.transcript.apply({ type: 'replace', id: event.id, kind: 'tool', text: event.summary });
      this.transcript.apply({ type: 'complete', id: event.id });
      this.surface.writeOutput(renderToolResult(event, this.theme()).join('\n'));
      this.phase = 'Thinking…';
    } else {
      this.transcript.apply({ type: 'replace', id: event.id, kind: 'status', text: event.text });
      this.surface.writeOutput(this.theme().dim(sanitizeTerminalText(event.text)));
    }
    this.redraw();
  }

  usage(totals: AgentUsageTotals): void {
    this.outputTokens = totals.totalCompletionTokens;
    this.redraw();
  }

  finish(): void {
    this.finishAssistant();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
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
    const rows = this.partial === '' ? [] : [theme.star(this.partial)];
    rows.push(theme.violet(`✽ ${this.phase}`) + theme.dim(` (${elapsed}s${count})`));
    rows.push(theme.dim('  ⎿ Tip: Esc stops this turn · type your next prompt below'));
    this.surface.setLive(rows);
  }
}
