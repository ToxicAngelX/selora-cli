import { TerminalTextSanitizer } from './terminal-text.js';

export type TranscriptMessageKind = 'user' | 'assistant' | 'tool' | 'status' | 'error';

export interface TranscriptMessage {
  readonly id: string;
  readonly kind: TranscriptMessageKind;
  readonly text: string;
  readonly complete: boolean;
  readonly rendered: boolean;
}

export type TranscriptEvent =
  | { type: 'append'; id: string; kind: TranscriptMessageKind; text: string }
  | { type: 'replace'; id: string; kind: TranscriptMessageKind; text: string }
  | { type: 'complete'; id: string }
  | { type: 'remove'; id: string };

interface MutableTranscriptMessage {
  id: string;
  kind: TranscriptMessageKind;
  text: string;
  complete: boolean;
  rendered: boolean;
  sanitizer: TerminalTextSanitizer;
  events: Set<string>;
  eventOrder: string[];
}

const MAX_EVENTS_PER_MESSAGE = 2048;

function snapshot(message: MutableTranscriptMessage): TranscriptMessage {
  return Object.freeze({
    id: message.id,
    kind: message.kind,
    text: message.text,
    complete: message.complete,
    rendered: message.rendered,
  });
}

/**
 * One source of truth for visible transcript messages. Streaming updates replace
 * the same assistant record; completion is idempotent and closes the record.
 * Every message owns its incremental sanitizer and bounded event-id namespace.
 */
export class TranscriptStore {
  private readonly messagesById = new Map<string, MutableTranscriptMessage>();
  private readonly order: string[] = [];

  apply(event: TranscriptEvent, eventKey?: string): TranscriptMessage | undefined {
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
        sanitizer: new TerminalTextSanitizer(),
        events: new Set<string>(),
        eventOrder: [],
      };
      this.messagesById.set(event.id, message);
      this.order.push(event.id);
    }

    if (event.type === 'complete') {
      if (!message.complete) {
        message.text += message.sanitizer.flush();
        message.complete = true;
      }
      return snapshot(message);
    }
    if (message.complete) return snapshot(message);

    if (eventKey !== undefined) {
      if (message.events.has(eventKey)) return snapshot(message);
      message.events.add(eventKey);
      message.eventOrder.push(eventKey);
      if (message.eventOrder.length > MAX_EVENTS_PER_MESSAGE) {
        const evicted = message.eventOrder.shift();
        if (evicted !== undefined) message.events.delete(evicted);
      }
    }

    if (event.type === 'append') {
      message.text += message.sanitizer.push(event.text);
    } else {
      message.sanitizer.reset();
      message.text = message.sanitizer.push(event.text) + message.sanitizer.flush();
      message.events.clear();
      message.eventOrder.length = 0;
    }
    return snapshot(message);
  }

  get(id: string): TranscriptMessage | undefined {
    const message = this.messagesById.get(id);
    return message === undefined ? undefined : snapshot(message);
  }

  /** Append through the same per-message sanitizer used by apply(). */
  append(id: string, kind: TranscriptMessageKind, text: string, eventKey?: string): string {
    const before = this.messagesById.get(id)?.text.length ?? 0;
    const message = this.apply({ type: 'append', id, kind, text }, eventKey);
    return message?.text.slice(before) ?? '';
  }

  /** Flush a message's pending CR/control parser state without completing it. */
  flush(id: string): string {
    const message = this.messagesById.get(id);
    if (message === undefined || message.complete) return '';
    const tail = message.sanitizer.flush();
    message.text += tail;
    return tail;
  }

  markRendered(id: string): boolean {
    const message = this.messagesById.get(id);
    if (message === undefined || message.rendered) return false;
    message.rendered = true;
    return true;
  }

  clear(): void {
    this.messagesById.clear();
    this.order.length = 0;
  }

  snapshot(): TranscriptMessage[] {
    return this.order
      .map((id) => this.messagesById.get(id))
      .filter((message): message is MutableTranscriptMessage => message !== undefined)
      .map(snapshot);
  }
}
