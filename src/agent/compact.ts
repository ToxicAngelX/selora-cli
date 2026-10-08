/**
 * Auto-compaction (v1.2): when the estimated context crosses the threshold
 * (90% of the budget), the OLDEST turns are summarized by a cheap model call
 * into ONE compact "memory" message, and the conversation continues with
 * fresh headroom. What is kept verbatim, what is folded, and what the
 * summary must preserve are all decided here — the loop only calls in.
 *
 * Rules:
 *  - NEVER compact away the last `KEEP_RECENT` messages (the live working set:
 *    tool calls must keep their results adjacent in the wire shape).
 *  - The compacted block replaces a CONTIGUOUS PREFIX of the history — wire
 *    validity (tool_call_id pairing) is preserved by folding whole turns.
 *  - The summary message is role 'user' with a clear marker (the gateway
 *    accepts system, but 'user' with the marker is portable across rails).
 *  - Fails soft: when the summarizer call errors, compaction is skipped and
 *    the history is returned unchanged (a failed summary must NEVER eat the
 *    conversation).
 */

import type { ChatMessage } from '../api/endpoints/chat.js';
import { SeloraClient } from '../api/client.js';
import { streamChat } from '../api/endpoints/chat.js';
import { estimateTokensHistory } from './contextmeter.js';
import { SeloraApiError } from '../api/errors.js';
import { throwIfCancelled } from './tool.js';

/** Messages always kept verbatim at the tail (never folded away). */
export const KEEP_RECENT = 6;
/** Folded prefix must be at least this big — compacting 2 tiny messages is noise. */
export const MIN_FOLD_MESSAGES = 8;
export interface CompactOptions {
  /** Budget in tokens — the threshold is 90% of this. */
  tokens: number;
  /** Threshold ratio (default 0.9). */
  threshold?: number;
  /** The cheap model used to summarize (default: same model — caller decides). */
  compactModel?: string;
  /** Injectable summarizer for tests. */
  summarize?: (messages: readonly ChatMessage[], signal?: AbortSignal) => Promise<string>;
  /** Abort compaction and propagate canonical cancellation. */
  signal?: AbortSignal | undefined;
}

export interface CompactResult {
  /** True when a compaction happened. */
  compacted: boolean;
  /** The new history (original when not compacted). */
  messages: ChatMessage[];
  /** How many messages were folded into the summary. */
  folded: number;
  /** Estimated tokens before → after. */
  tokensBefore: number;
  tokensAfter: number;
  /** The summary text (empty when not compacted). */
  summary: string;
}

/**
 * Fold whole turns: an assistant message WITH tool_calls plus its trailing
 * tool-result messages form one unit — never split (the wire shape would
 * break). Everything before the fold line that is a bare user/assistant
 * exchange folds as-is.
 */
function foldBoundary(messages: readonly ChatMessage[], keepRecent: number): number {
  // candidate cut: messages.length - keepRecent, but snap FORWARD past any
  // trailing tool results of the last folded assistant tool-call message.
  let cut = messages.length - keepRecent;
  if (cut < MIN_FOLD_MESSAGES - keepRecent) return -1; // not enough to fold
  // snap forward: while the message at `cut` is a tool result (would orphan
  // its assistant tool_calls message behind the cut), move the cut back to
  // include the assistant message in the FOLDED region instead... no: moving
  // back means the assistant tool_call message FOLDS while its results stay
  // — worse. Move the cut FORWARD past the tool results: the pair stays
  // together in the KEPT region.
  while (cut < messages.length && messages[cut]!.role === 'tool') {
    cut += 1;
  }
  // after snapping, the kept region may have shrunk below keepRecent — fine,
  // the pairing invariant matters more.
  if (cut >= messages.length) return -1;
  return cut;
}

/** Render messages for the summarizer prompt (compact transcript form). */
function renderForSummary(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      lines.push(`USER: ${text.slice(0, 2000)}`);
    } else if (m.role === 'assistant') {
      if (m.content !== null && m.content !== '') {
        lines.push(`ASSISTANT: ${m.content.slice(0, 2000)}`);
      }
      for (const c of m.tool_calls ?? []) {
        lines.push(`TOOL_CALL ${c.function.name}: ${c.function.arguments.slice(0, 400)}`);
      }
    } else if (m.role === 'tool') {
      lines.push(`TOOL_RESULT: ${m.content.slice(0, 1200)}`);
    }
  }
  return lines.join('\n');
}

const SUMMARY_PROMPT = `You are a session summarizer. Compress the conversation
below into a dense factual memory for a coding agent continuing the same task.
Rules:
- Keep: user goals and constraints, decisions made, file paths touched, commands
  run and their outcomes, errors hit and how they were resolved, anything still
  pending or promised.
- Drop: pleasantries, restated context, tool-output bulk.
- Max ~150 words. Plain text, no preamble, no markdown headers.`;

/** Default summarizer: one non-streaming-style call on the cheap model. */
async function summarizeWith(
  client: SeloraClient,
  model: string,
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let text = '';
  const transcript = renderForSummary(messages);
  await streamChat(
    client,
    {
      model,
      messages: [{ role: 'user', content: `${SUMMARY_PROMPT}\n\n---\n${transcript}\n---` }],
      signal,
    },
    {
      onDelta: (t: string) => {
        text += t;
      },
    },
  );
  return text.trim();
}

/**
 * Maybe-compact: returns messages unchanged unless the estimated tokens cross
 * the threshold AND there is a foldable prefix. Ordinary summary failures
 * return the original history; cancellation propagates to the caller.
 */
export async function maybeCompact(
  history: readonly ChatMessage[],
  client: SeloraClient,
  opts: CompactOptions,
): Promise<CompactResult> {
  const threshold = opts.threshold ?? 0.9;
  throwIfCancelled(opts.signal);
  const before = estimateTokensHistory(history);
  const tokensBefore = before;
  const no = (messages: ChatMessage[]): CompactResult => ({
    compacted: false,
    messages,
    folded: 0,
    tokensBefore,
    tokensAfter: tokensBefore,
    summary: '',
  });

  if (before < opts.tokens * threshold) return no([...history]);

  const cut = foldBoundary(history, KEEP_RECENT);
  if (cut < MIN_FOLD_MESSAGES) return no([...history]);

  const toFold = history.slice(0, cut);
  const kept = history.slice(cut);

  let summary: string;
  try {
    summary =
      opts.summarize !== undefined
        ? await opts.summarize(toFold, opts.signal)
        : await summarizeWith(client, opts.compactModel ?? '', toFold, opts.signal);
  } catch (err) {
    throwIfCancelled(opts.signal);
    if (err instanceof SeloraApiError && err.kind === 'cancelled') throw err;
    return no([...history]);
  }
  throwIfCancelled(opts.signal);
  if (summary === '') return no([...history]);

  const marker: ChatMessage = {
    role: 'user',
    content: `[earlier conversation compacted — summary of the folded turns]\n${summary}\n[end of compacted summary; the messages above this line were auto-summarized to reclaim context. Treat the summary as ground truth for what happened.]`,
  };

  const messages: ChatMessage[] = [marker, ...kept];
  return {
    compacted: true,
    messages,
    folded: toFold.length,
    tokensBefore,
    tokensAfter: estimateTokensHistory(messages),
    summary,
  };
}
