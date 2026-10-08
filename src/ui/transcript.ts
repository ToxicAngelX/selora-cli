import { sanitizeTerminalText } from './terminal-text.js';

export type TranscriptMessageKind = 'user' | 'assistant' | 'tool' | 'status' | 'error';

export interface TranscriptMessage {
  readonly id: string;
  readonly kind: TranscriptMessageKind;
  text: string;
  complete: boolean;
  rendered: boolean;
}

export type TranscriptEvent =
  | { type: 'append'; id: string; kind: TranscriptMessageKind; text: string }
  | { type: 'replace'; id: string; kind: TranscriptMessageKind; text: string }
  | { type: 'complete'; id: string }
  | { type: 'remove'; id: string };

/**
 * One source of truth for visible transcript messages. Streaming updates replace
 * the same assistant record; completion is idempotent; duplicate event sequence
 * numbers are ignored. The renderer can consume snapshot() without appending
 * the same message a second time.
 */
export class TranscriptStore {
  private readonly messagesById = new Map<string, TranscriptMessage>();
  private readonly order: string[] = [];
  private readonly seenEvents = new Set<string>();

  apply(event: TranscriptEvent, eventKey?: string): TranscriptMessage | undefined {
    if (eventKey !== undefined) {
      if (this.seenEvents.has(eventKey)) return this.messagesById.get(event.id);
      this.seenEvents.add(eventKey);
    }
    if (event.type === 'remove') {
      this.messagesById.delete(event.id);
      const at = this.order.indexOf(event.id);
      if (at !== -1) this.order.splice(at, 1);
      return undefined;
    }

    let message = this.messagesById.get(event.id);
    if (message === undefined) {
      if (event.type === 'complete') return undefined;
      message = {
        id: event.id,
        kind: event.kind,
        text: '',
        complete: false,
        rendered: false,
      };
      this.messagesById.set(event.id, message);
      this.order.push(event.id);
    }

    if (event.type === 'append') message.text += sanitizeTerminalText(event.text);
    else if (event.type === 'replace') message.text = sanitizeTerminalText(event.text);
    else if (event.type === 'complete') message.complete = true;
    return message;
  }

  get(id: string): TranscriptMessage | undefined {
    return this.messagesById.get(id);
  }

  append(id: string, kind: TranscriptMessageKind, text: string, eventKey?: string): string {
    const before = this.messagesById.get(id)?.text.length ?? 0;
    const message = this.apply({ type: 'append', id, kind, text }, eventKey);
    return message?.text.slice(before) ?? '';
  }

  markRendered(id: string): boolean {
    const message = this.messagesById.get(id);
    if (message === undefined || message.rendered) return false;
    message.rendered = true;
    return true;
  }

  snapshot(): TranscriptMessage[] {
    return this.order
      .map((id) => this.messagesById.get(id))
      .filter((message): message is TranscriptMessage => message !== undefined)
      .map((message) => ({ ...message }));
  }
}
