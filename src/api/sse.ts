/**
 * Push-based SSE parser (pure, no I/O): feed it arbitrary string chunks —
 * events may split at ANY byte boundary across pushes — and it buffers,
 * normalizes line endings (\r\n and lone \r → \n), splits on the blank-line
 * event boundary, ignores comment lines (`: …`, e.g. `: keep-alive`),
 * collects `data:` lines (multi-line data joined with \n), and invokes
 * onEvent once per complete event with the joined payload.
 *
 * `data: [DONE]` is delivered like any other event — the caller decides what
 * it means. A trailing event without a final blank line is only emitted when
 * the caller calls flush() (stream end).
 */

export interface SseParser {
  /** Feed one chunk. May deliver zero or more events. */
  (chunk: string): void;
  /** Emit a trailing event that never got its final blank line. */
  flush(): void;
}

export function createSseParser(onEvent: (data: string) => void): SseParser {
  /** Buffer of already-normalized text not yet split into a complete event. */
  let buf = '';
  /** The previous chunk ended with '\r' — it may be half of a '\r\n' pair. */
  let pendingCr = false;

  function normalize(s: string): string {
    return s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s;
  }

  function handleEvent(raw: string): void {
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line === '' || line.startsWith(':')) continue; // blank / comment
      // Only `data:` fields matter to the gateway wire format.
      if (line.startsWith('data:')) {
        const value = line.slice(5);
        // SSE strips ONE optional leading space after the field colon.
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      }
      // Other field names (event:, id:, retry:) are ignored — not on the wire.
    }
    if (dataLines.length === 0) return; // comment-only / field-only event
    onEvent(dataLines.join('\n'));
  }

  function drain(): void {
    for (;;) {
      const idx = buf.indexOf('\n\n');
      if (idx === -1) return;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleEvent(raw);
    }
  }

  const parser = (chunk: string): void => {
    let s = chunk;
    if (pendingCr) {
      // The held '\r' + a leading '\n' is one '\r\n' line ending → one '\n'.
      if (s.startsWith('\n')) {
        buf += '\n';
        s = s.slice(1);
      } else {
        // A lone '\r' is a line ending on its own.
        buf += '\n';
      }
      pendingCr = false;
    }
    if (s.endsWith('\r')) {
      // Hold the '\r' back — the next chunk decides whether it was '\r\n'.
      s = s.slice(0, -1);
      pendingCr = true;
    }
    if (s !== '') buf += normalize(s);
    drain();
  };

  parser.flush = (): void => {
    if (pendingCr) {
      buf += '\n';
      pendingCr = false;
    }
    if (buf === '') return;
    const raw = buf;
    buf = '';
    handleEvent(raw);
  };

  return parser;
}
