// JSON-RPC 2.0 over Content-Length framing. The decoder takes byte chunks and
// returns the complete messages. A bad frame is an error value, never an
// exception. The module has no I/O.
//
// Recovery rule: after a malformed header block, or a header block that grows
// past MAX_HEADER_BYTES without its end, the decoder drops bytes up to the
// next `Content-Length:` (ASCII case-insensitive) that starts after the first
// byte of the bad block. If the buffer holds no such text, the decoder keeps
// only a short tail and keeps skipping on the next chunk. Each bad region gives
// one error. A body that is not valid UTF-8 JSON consumes its whole frame.

import type { Result } from "../core/source.ts";

export type RequestId = string | number;

export interface RequestMessage {
  readonly jsonrpc: "2.0";
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface NotificationMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface ResponseError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type ResponseMessage =
  | {
    readonly jsonrpc: "2.0";
    readonly id: RequestId | null;
    readonly result: unknown;
  }
  | {
    readonly jsonrpc: "2.0";
    readonly id: RequestId | null;
    readonly error: ResponseError;
  };

export type OutgoingMessage =
  | RequestMessage
  | NotificationMessage
  | ResponseMessage;

/** JSON-RPC and LSP error codes used by the server. */
export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  serverNotInitialized: -32002,
} as const;

export type FrameError =
  | { readonly tag: "bad-header"; readonly message: string }
  | { readonly tag: "bad-json"; readonly message: string };

/** A header block larger than this is malformed. */
export const MAX_HEADER_BYTES = 8192;
/** A body larger than this is refused as a malformed header. */
export const MAX_BODY_BYTES = 256 * 1024 * 1024;

const HEADER_END = Uint8Array.of(13, 10, 13, 10);
const LENGTH_NAME = "content-length:";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const latin1Decoder = new TextDecoder("latin1");
const textEncoder = new TextEncoder();

function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function lowerAscii(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

/** Index of `Content-Length:` in any ASCII case at or after `from`, or -1. */
function indexOfLengthName(haystack: Uint8Array, from: number): number {
  const last = haystack.length - LENGTH_NAME.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < LENGTH_NAME.length; j++) {
      if (lowerAscii(haystack[i + j]) !== LENGTH_NAME.charCodeAt(j)) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

/** Reads the header block. Returns the body length in bytes. */
function parseHeader(block: Uint8Array): Result<number, FrameError> {
  const bad = (message: string): Result<number, FrameError> => ({
    ok: false,
    error: { tag: "bad-header", message },
  });
  let length: number | undefined;
  for (const line of latin1Decoder.decode(block).split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      return bad(`malformed header line: ${JSON.stringify(line)}`);
    }
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") {
      continue; // Content-Type and unknown headers are ignored.
    }
    const value = line.slice(colon + 1).trim();
    if (!/^[0-9]{1,15}$/.test(value)) {
      return bad(`Content-Length is not a number: ${JSON.stringify(value)}`);
    }
    length = Number(value);
    if (length > MAX_BODY_BYTES) {
      return bad(
        `Content-Length ${length} is over the limit ${MAX_BODY_BYTES}`,
      );
    }
  }
  return length === undefined
    ? bad("the header block has no Content-Length")
    : { ok: true, value: length };
}

function decodeBody(body: Uint8Array): Result<unknown, FrameError> {
  try {
    return { ok: true, value: JSON.parse(textDecoder.decode(body)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { tag: "bad-json", message } };
  }
}

/** Splits a byte stream into messages. Holds the bytes of a partial frame. */
export class FrameDecoder {
  #buffer: Uint8Array = new Uint8Array(0);
  #skipping = false;

  /** Adds a chunk. Returns the messages that the chunk completed, in order. */
  push(chunk: Uint8Array): Result<unknown, FrameError>[] {
    this.#buffer = concat(this.#buffer, chunk);
    const out: Result<unknown, FrameError>[] = [];
    for (;;) {
      if (this.#skipping) {
        const at = indexOfLengthName(this.#buffer, 0);
        if (at < 0) {
          this.#keepTail();
          return out;
        }
        this.#buffer = this.#buffer.subarray(at);
        this.#skipping = false;
      }
      if (this.#buffer.length === 0) return out;
      const end = indexOfBytes(this.#buffer, HEADER_END, 0);
      if (end < 0) {
        if (this.#buffer.length <= MAX_HEADER_BYTES) return out;
        out.push({
          ok: false,
          error: {
            tag: "bad-header",
            message: `no end of header within ${MAX_HEADER_BYTES} bytes`,
          },
        });
        this.#recover();
        continue;
      }
      const header = parseHeader(this.#buffer.subarray(0, end));
      if (!header.ok) {
        out.push(header);
        this.#recover();
        continue;
      }
      const bodyStart = end + HEADER_END.length;
      const frameEnd = bodyStart + header.value;
      if (this.#buffer.length < frameEnd) return out;
      const body = this.#buffer.subarray(bodyStart, frameEnd);
      this.#buffer = this.#buffer.subarray(frameEnd);
      out.push(decodeBody(body));
    }
  }

  /** Drops the bad block. The next frame starts at a later `Content-Length:`. */
  #recover(): void {
    const at = indexOfLengthName(this.#buffer, 1);
    if (at >= 0) {
      this.#buffer = this.#buffer.subarray(at);
      return;
    }
    this.#skipping = true;
    this.#keepTail();
  }

  /** Keeps the bytes that could start a split `Content-Length:`. */
  #keepTail(): void {
    const keep = LENGTH_NAME.length - 1;
    this.#buffer = this.#buffer.length > keep
      ? this.#buffer.slice(this.#buffer.length - keep)
      : this.#buffer;
  }
}

/** The bytes of one frame: header block, empty line, and the UTF-8 JSON body. */
export function encodeMessage(message: OutgoingMessage): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(message));
  const header = textEncoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header, 0);
  frame.set(body, header.length);
  return frame;
}

export function successResponse(
  id: RequestId | null,
  result: unknown,
): ResponseMessage {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: RequestId | null,
  code: number,
  message: string,
): ResponseMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function notificationMessage(
  method: string,
  params?: unknown,
): NotificationMessage {
  return { jsonrpc: "2.0", method, params };
}

export type IncomingMessage =
  | { readonly tag: "request"; readonly message: RequestMessage }
  | { readonly tag: "notification"; readonly message: NotificationMessage }
  | { readonly tag: "response"; readonly message: ResponseMessage }
  /** `id` is the request id when the value has a usable one, else null. */
  | {
    readonly tag: "invalid";
    readonly id: RequestId | null;
    readonly reason: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is RequestId {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}

/** Sorts a decoded JSON value into a request, notification, response, or invalid. */
export function classifyMessage(value: unknown): IncomingMessage {
  if (!isRecord(value)) {
    return { tag: "invalid", id: null, reason: "the message is not an object" };
  }
  const id = isId(value.id) ? value.id : null;
  const invalid = (reason: string): IncomingMessage => ({
    tag: "invalid",
    id,
    reason,
  });
  if (value.jsonrpc !== "2.0") return invalid('jsonrpc must be "2.0"');
  if ("method" in value) {
    const method = value.method;
    if (typeof method !== "string") return invalid("method must be a string");
    if (!("id" in value)) {
      return {
        tag: "notification",
        message: { jsonrpc: "2.0", method, params: value.params },
      };
    }
    if (!isId(value.id)) {
      return invalid("a request id must be a string or a number");
    }
    return {
      tag: "request",
      message: { jsonrpc: "2.0", id: value.id, method, params: value.params },
    };
  }
  if (!("id" in value)) return invalid("the message has no method and no id");
  if (value.id !== null && !isId(value.id)) {
    return invalid("a response id must be a string, a number, or null");
  }
  const responseId: RequestId | null = value.id;
  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (hasResult === hasError) {
    return invalid("a response has exactly one of result and error");
  }
  if (hasResult) {
    return {
      tag: "response",
      message: { jsonrpc: "2.0", id: responseId, result: value.result },
    };
  }
  const error = value.error;
  if (
    !isRecord(error) || typeof error.code !== "number" ||
    typeof error.message !== "string"
  ) {
    return invalid("error must hold a numeric code and a string message");
  }
  return {
    tag: "response",
    message: {
      jsonrpc: "2.0",
      id: responseId,
      error: { code: error.code, message: error.message, data: error.data },
    },
  };
}
