/**
 * Image attachments (v0.6): `@<path>` tokens in a chat/run prompt attach local
 * images to the message as OpenAI `image_url` data-URL parts.
 *
 * The rules, honestly:
 *  - A token counts as an image reference ONLY when it starts with `@` and the
 *    path ends in a known image extension (png/jpg/jpeg/webp/gif,
 *    case-insensitive). `@channel`-style mentions and `@foo.txt` stay literal
 *    text — chat would be unusable otherwise.
 *  - Dragged paths with spaces work two ways: `@"C:\my dir\a.png"` (quoted,
 *    what Windows terminals drop) and `@/tmp/my\ shot.png` (backslash-escaped,
 *    what POSIX terminals drop). A backslash is an escape ONLY before a space,
 *    a quote, a backslash, or an `@` — everywhere else it is literal, so
 *    `@C:\shots\a.png` survives intact. `\@` types a literal `@`.
 *  - The file must exist, be a regular file, and be at most 4 MB — the
 *    gateway's request limit would 413 anything bigger, so we refuse BEFORE
 *    encoding instead of building a doomed request.
 *  - At most 4 images per message (a hard error above that; nothing is sent).
 *  - Base64 never prints: the transcript shows `[image: name, 12.4 KB]`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { ChatUserContentPart } from './api/endpoints/chat.js';

/** Extensions the gateway accepts as image_url parts (verified live). */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Size guard: refuse before encoding rather than building a request that 413s. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Per-message attachment cap. */
export const MAX_IMAGES_PER_MESSAGE = 4;

export interface ImageAttachment {
  /** Basename — for the `[image: name, …]` transcript marker. */
  name: string;
  /** The resolved absolute path the bytes came from. */
  path: string;
  /** File size in bytes (before base64). */
  bytes: number;
  /** `data:<mime>;base64,…` — the image_url payload. */
  dataUrl: string;
}

export interface ExtractedImages {
  /**
   * The prompt with image tokens removed. When nothing matched, this is the
   * input VERBATIM (no whitespace normalization) — the parser only rewrites
   * text it actually attached something from.
   */
  text: string;
  /** The paths with quotes/escapes resolved (no `@` prefix), in order. */
  paths: string[];
}

interface Token {
  text: string;
  /** True when the token started with an unescaped `@` (the marker). */
  marked: boolean;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
/** Backslash escapes exactly these; before anything else it stays literal. */
const ESCAPABLE = new Set([' ', '\t', '\n', '\r', '\\', '"', '@']);

/** Split input into tokens on unescaped whitespace, resolving quotes/escapes. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && WHITESPACE.has(input[i]!)) i += 1;
    if (i >= n) break;
    let text = '';
    let marked = false;
    if (input[i] === '@') {
      marked = true;
      i += 1;
    }
    // A quoted path right after the marker: verbatim until the closing quote
    // — the drag-and-drop shape on Windows terminals (`@"C:\my dir\a.png"`).
    if (marked && i < n && input[i] === '"') {
      i += 1;
      while (i < n && input[i] !== '"') {
        text += input[i];
        i += 1;
      }
      if (i < n) i += 1; // the closing quote
      tokens.push({ text, marked });
      continue;
    }
    while (i < n && !WHITESPACE.has(input[i]!)) {
      const ch = input[i]!;
      if (ch === '\\' && i + 1 < n && ESCAPABLE.has(input[i + 1]!)) {
        text += input[i + 1];
        i += 2;
        continue;
      }
      text += ch;
      i += 1;
    }
    tokens.push({ text, marked });
  }
  return tokens;
}

/** True when the token text ends in a known image extension. */
function hasImageExtension(token: string): boolean {
  return MIME_BY_EXT[extname(token).toLowerCase()] !== undefined;
}

/**
 * Pull the image references out of a prompt. Everything that is not an
 * image reference is literal text (`\@foo.png` and `@channel` included).
 */
export function extractImageTokens(input: string): ExtractedImages {
  const tokens = tokenize(input);
  const paths: string[] = [];
  const kept: string[] = [];
  for (const t of tokens) {
    if (t.marked && t.text !== '' && hasImageExtension(t.text)) {
      paths.push(t.text);
    } else {
      kept.push(t.marked ? `@${t.text}` : t.text);
    }
  }
  if (paths.length === 0) return { text: input, paths };
  return { text: kept.join(' '), paths };
}

export type ImageLoadResult =
  { ok: true; attachment: ImageAttachment } | { ok: false; error: string };

/** Validate + encode one image file. Never throws; every failure is a message. */
export function loadImageAttachment(rawPath: string, cwd: string): ImageLoadResult {
  const abs = resolve(cwd, rawPath);
  const name = basename(abs);
  const mime = MIME_BY_EXT[extname(abs).toLowerCase()];
  if (mime === undefined) {
    return {
      ok: false,
      error: `unsupported image type for ${name} — use png, jpg, jpeg, webp, or gif`,
    };
  }
  if (!existsSync(abs)) {
    return { ok: false, error: `image not found: ${rawPath}` };
  }
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { ok: false, error: `not a file: ${rawPath}` };
    size = st.size;
  } catch {
    return { ok: false, error: `cannot read image: ${rawPath}` };
  }
  if (size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `image too large: ${name} (${formatImageSize(size)} — the limit is ${formatImageSize(MAX_IMAGE_BYTES)})`,
    };
  }
  let data: Buffer;
  try {
    data = readFileSync(abs);
  } catch {
    return { ok: false, error: `cannot read image: ${rawPath}` };
  }
  return {
    ok: true,
    attachment: {
      name,
      path: abs,
      bytes: size,
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
    },
  };
}

export type ParseImageInputResult =
  { ok: true; text: string; images: ImageAttachment[] } | { ok: false; error: string };

/**
 * Full parse: extract the image tokens, then validate and encode each file.
 * The first failure wins and nothing is sent — the user fixes and retypes.
 */
export function parseImageInput(input: string, cwd: string): ParseImageInputResult {
  const { text, paths } = extractImageTokens(input);
  if (paths.length > MAX_IMAGES_PER_MESSAGE) {
    return {
      ok: false,
      error: `too many images: ${paths.length} attached — the limit is ${MAX_IMAGES_PER_MESSAGE} per message`,
    };
  }
  const images: ImageAttachment[] = [];
  for (const p of paths) {
    const r = loadImageAttachment(p, cwd);
    if (!r.ok) return r;
    images.push(r.attachment);
  }
  return { ok: true, text, images };
}

/**
 * The wire content for a user message: the plain string when there are no
 * images, otherwise the multimodal parts (text first when non-empty — some
 * providers reject an empty text part, so images-only messages carry none).
 */
export function userMessageContent(
  text: string,
  images: readonly ImageAttachment[],
): string | ChatUserContentPart[] {
  if (images.length === 0) return text;
  const parts: ChatUserContentPart[] = [];
  if (text !== '') parts.push({ type: 'text', text });
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  }
  return parts;
}

/** The transcript marker — the ONLY place an attachment is displayed. */
export function imageMarker(img: ImageAttachment): string {
  return `[image: ${img.name}, ${formatImageSize(img.bytes)}]`;
}

/** 512 → "512 B", 2048 → "2 KB", 12700 → "12.4 KB", 2.5 MB → "2.5 MB". */
export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) {
    const rounded = Math.round(kb * 10) / 10;
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  const rounded = Math.round(mb * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} MB`;
}
