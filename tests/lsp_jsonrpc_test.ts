import { assert, assertEquals } from "@std/assert";
import {
  classifyMessage,
  encodeMessage,
  ErrorCodes,
  errorResponse,
  FrameDecoder,
  type FrameError,
  MAX_HEADER_BYTES,
  notificationMessage,
  successResponse,
} from "../src/lsp/jsonrpc.ts";
import type { Result } from "../src/core/source.ts";

const encoder = new TextEncoder();

function frame(body: string, extraHeaders = ""): Uint8Array {
  const bytes = encoder.encode(body);
  return encoder.encode(
    `Content-Length: ${bytes.length}\r\n${extraHeaders}\r\n${body}`,
  );
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function values(results: Result<unknown, FrameError>[]): unknown[] {
  return results.map((r) => (r.ok ? r.value : r.error));
}

const SAMPLE = '{"jsonrpc":"2.0","id":1,"method":"shutdown"}';
const SAMPLE_VALUE = { jsonrpc: "2.0", id: 1, method: "shutdown" };

Deno.test("decoder: one whole frame", () => {
  assertEquals(
    values(new FrameDecoder().push(frame(SAMPLE))),
    [SAMPLE_VALUE],
  );
});

Deno.test("decoder: a frame split at every byte boundary", () => {
  const bytes = frame(SAMPLE);
  for (let cut = 0; cut <= bytes.length; cut++) {
    const decoder = new FrameDecoder();
    const first = decoder.push(bytes.subarray(0, cut));
    const second = decoder.push(bytes.subarray(cut));
    assertEquals(
      values([...first, ...second]),
      [SAMPLE_VALUE],
      `cut at ${cut}`,
    );
  }
});

Deno.test("decoder: one byte at a time", () => {
  const decoder = new FrameDecoder();
  const out: Result<unknown, FrameError>[] = [];
  for (const byte of frame(SAMPLE)) {
    out.push(...decoder.push(Uint8Array.of(byte)));
  }
  assertEquals(values(out), [SAMPLE_VALUE]);
});

Deno.test("decoder: several frames in one chunk, with a partial third", () => {
  const decoder = new FrameDecoder();
  const third = frame('{"c":3}');
  const chunk = join(frame('{"a":1}'), frame('{"b":2}'), third.subarray(0, 10));
  assertEquals(values(decoder.push(chunk)), [{ a: 1 }, { b: 2 }]);
  assertEquals(values(decoder.push(third.subarray(10))), [{ c: 3 }]);
});

Deno.test("decoder: Content-Length counts UTF-8 bytes", () => {
  const body = '{"text":"é😀日本"}';
  const bytes = frame(body);
  assert(encoder.encode(body).length > body.length);
  // Split inside the 4-byte emoji.
  const emoji = bytes.length - encoder.encode('日本"}').length - 2;
  const decoder = new FrameDecoder();
  const out = [
    ...decoder.push(bytes.subarray(0, emoji)),
    ...decoder.push(bytes.subarray(emoji)),
  ];
  assertEquals(values(out), [{ text: "é😀日本" }]);
});

Deno.test("decoder: Content-Type is allowed, unknown headers are ignored, names ignore case", () => {
  const body = '{"x":1}';
  const bytes = encoder.encode(
    `content-type: application/vscode-jsonrpc; charset=utf-8\r\nX-Other: y\r\nCONTENT-LENGTH:${body.length}\r\n\r\n${body}`,
  );
  assertEquals(values(new FrameDecoder().push(bytes)), [{ x: 1 }]);
});

Deno.test("decoder: a body that is not JSON is an error and the next frame still decodes", () => {
  const out = new FrameDecoder().push(
    join(frame("not json"), frame('{"ok":true}')),
  );
  assertEquals(out.length, 2);
  const [bad, good] = out;
  assert(!bad.ok && bad.error.tag === "bad-json");
  assertEquals(good, { ok: true, value: { ok: true } });
});

Deno.test("decoder: a body with invalid UTF-8 is a bad-json error", () => {
  const header = encoder.encode("Content-Length: 2\r\n\r\n");
  const out = new FrameDecoder().push(join(header, Uint8Array.of(0xff, 0xfe)));
  assert(out.length === 1 && !out[0].ok && out[0].error.tag === "bad-json");
});

Deno.test("decoder: a header line without a colon is a bad-header error", () => {
  const out = new FrameDecoder().push(
    encoder.encode("Garbage\r\n\r\n{}"),
  );
  assert(out.length === 1 && !out[0].ok && out[0].error.tag === "bad-header");
});

Deno.test("decoder: a missing, non-numeric, or oversized Content-Length is a bad-header error", () => {
  for (
    const head of [
      "Content-Type: x\r\n\r\n",
      "Content-Length: abc\r\n\r\n",
      "Content-Length: -3\r\n\r\n",
      "Content-Length: 99999999999\r\n\r\n",
    ]
  ) {
    const out = new FrameDecoder().push(encoder.encode(head));
    assert(
      out.length === 1 && !out[0].ok && out[0].error.tag === "bad-header",
      head,
    );
  }
});

Deno.test("decoder recovery: drops bytes up to the next Content-Length and decodes that frame", () => {
  const decoder = new FrameDecoder();
  const out = decoder.push(
    join(encoder.encode("Garbage\r\n\r\njunk bytes "), frame('{"after":1}')),
  );
  assertEquals(out.length, 2);
  assert(!out[0].ok && out[0].error.tag === "bad-header");
  assertEquals(out[1], { ok: true, value: { after: 1 } });
});

Deno.test("decoder recovery: a good Content-Length line after a bad line in the same block", () => {
  const out = new FrameDecoder().push(
    join(encoder.encode("Foo\r\n"), frame('{"a":1}')),
  );
  assertEquals(out.length, 2);
  assert(!out[0].ok);
  assertEquals(out[1], { ok: true, value: { a: 1 } });
});

Deno.test("decoder recovery: skips across chunks and finds a split Content-Length", () => {
  const decoder = new FrameDecoder();
  const first = decoder.push(
    encoder.encode("Garbage\r\n\r\nmore junk Content-Le"),
  );
  assertEquals(first.length, 1);
  assert(!first[0].ok);
  // The previous chunk ended with "Content-Le"; continue the same header.
  const tail = encoder.encode(`ngth: 7\r\n\r\n{"z":9}`);
  assertEquals(values(decoder.push(tail)), [{ z: 9 }]);
});

Deno.test("decoder recovery: junk with no Content-Length gives one error, then a good frame decodes", () => {
  const decoder = new FrameDecoder();
  const first = decoder.push(encoder.encode("Garbage\r\n\r\n"));
  assertEquals(first.length, 1);
  assertEquals(decoder.push(encoder.encode("still junk, no header here")), []);
  assertEquals(values(decoder.push(frame('{"k":1}'))), [{ k: 1 }]);
});

Deno.test("decoder recovery: a header block that never ends is an error", () => {
  const decoder = new FrameDecoder();
  const out = decoder.push(encoder.encode("x".repeat(MAX_HEADER_BYTES + 1)));
  assertEquals(out.length, 1);
  assert(!out[0].ok && out[0].error.tag === "bad-header");
  assertEquals(values(decoder.push(frame('{"k":2}'))), [{ k: 2 }]);
});

Deno.test("decoder: the header limit includes CRLFCRLF and ignores chunk boundaries", () => {
  const prefix = "Content-Length: 2\r\nX-Padding: ";
  const suffix = "\r\n\r\n";
  for (
    const size of [
      MAX_HEADER_BYTES - 1,
      MAX_HEADER_BYTES,
      MAX_HEADER_BYTES + 1,
      MAX_HEADER_BYTES + 17,
    ]
  ) {
    const header = prefix + "x".repeat(size - prefix.length - suffix.length) +
      suffix;
    const bytes = join(encoder.encode(`${header}{}`), frame(SAMPLE));
    // Split inside the terminator, beyond the limit, and inside the next frame.
    for (
      const cut of [
        0,
        size - 4,
        size - 1,
        size,
        size + 1,
        size + 10,
        bytes.length,
      ]
    ) {
      const decoder = new FrameDecoder();
      const out = [
        ...decoder.push(bytes.subarray(0, cut)),
        ...decoder.push(bytes.subarray(cut)),
      ];
      assertEquals(out.length, 2, `header ${size}, cut ${cut}`);
      if (size <= MAX_HEADER_BYTES) {
        assertEquals(out[0], { ok: true, value: {} });
      } else {
        assert(!out[0].ok && out[0].error.tag === "bad-header");
      }
      assertEquals(out[1], { ok: true, value: SAMPLE_VALUE });
    }
  }
});

Deno.test("decoder recovery: an oversized block can resume at its later Content-Length", () => {
  const prefix = encoder.encode(
    `X-Padding: ${"x".repeat(MAX_HEADER_BYTES)}\r\n`,
  );
  const bytes = join(prefix, frame(SAMPLE));
  for (
    const cut of [0, MAX_HEADER_BYTES + 1, prefix.length + 5, bytes.length]
  ) {
    const decoder = new FrameDecoder();
    const out = [
      ...decoder.push(bytes.subarray(0, cut)),
      ...decoder.push(bytes.subarray(cut)),
    ];
    assertEquals(out.length, 2, `cut ${cut}`);
    assert(!out[0].ok && out[0].error.tag === "bad-header");
    assertEquals(out[1], { ok: true, value: SAMPLE_VALUE });
  }
});

Deno.test("encoder: header counts UTF-8 bytes and the decoder reads it back", () => {
  const message = notificationMessage("window/logMessage", {
    message: "é😀",
  });
  const bytes = encodeMessage(message);
  const text = new TextDecoder().decode(bytes);
  const split = text.indexOf("\r\n\r\n");
  const body = encoder.encode(text.slice(split + 4));
  assertEquals(text.slice(0, split), `Content-Length: ${body.length}`);
  assertEquals(values(new FrameDecoder().push(bytes)), [message]);
});

Deno.test("encoder: responses round trip", () => {
  const ok = successResponse(7, { value: [1, 2] });
  const err = errorResponse(null, ErrorCodes.parseError, "bad");
  const out = new FrameDecoder().push(
    join(encodeMessage(ok), encodeMessage(err)),
  );
  assertEquals(values(out), [ok, err]);
});

Deno.test("error codes match the plan", () => {
  assertEquals(ErrorCodes, {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    serverNotInitialized: -32002,
    internalError: -32603,
  });
});

Deno.test("classify: request, notification, and responses", () => {
  assertEquals(
    classifyMessage({ jsonrpc: "2.0", id: 1, method: "m", params: [1] }),
    {
      tag: "request",
      message: { jsonrpc: "2.0", id: 1, method: "m", params: [1] },
    },
  );
  assertEquals(
    classifyMessage({ jsonrpc: "2.0", id: "a", method: "m" }).tag,
    "request",
  );
  assertEquals(
    classifyMessage({ jsonrpc: "2.0", method: "n", params: { a: 1 } }),
    {
      tag: "notification",
      message: { jsonrpc: "2.0", method: "n", params: { a: 1 } },
    },
  );
  assertEquals(
    classifyMessage({ jsonrpc: "2.0", id: 3, result: null }),
    { tag: "response", message: { jsonrpc: "2.0", id: 3, result: null } },
  );
  assertEquals(
    classifyMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse" },
    }),
    {
      tag: "response",
      message: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse", data: undefined },
      },
    },
  );
});

Deno.test("classify: invalid values", () => {
  const cases: unknown[] = [
    null,
    42,
    "text",
    [],
    [{ jsonrpc: "2.0", method: "m" }],
    {},
    { method: "m" },
    { jsonrpc: "1.0", method: "m" },
    { jsonrpc: "2.0", method: 5 },
    { jsonrpc: "2.0", id: {}, method: "m" },
    { jsonrpc: "2.0", id: null, method: "m" },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "m" } },
    { jsonrpc: "2.0", id: 1, error: { code: "x", message: "m" } },
    { jsonrpc: "2.0", id: 1, error: "oops" },
    { jsonrpc: "2.0", result: 1 },
  ];
  for (const value of cases) {
    assertEquals(classifyMessage(value).tag, "invalid", JSON.stringify(value));
  }
});

Deno.test("classify: an invalid request keeps its id for the -32600 response", () => {
  assertEquals(classifyMessage({ jsonrpc: "1.0", id: 9, method: "m" }), {
    tag: "invalid",
    id: 9,
    reason: 'jsonrpc must be "2.0"',
  });
  const noId = classifyMessage(42);
  assert(noId.tag === "invalid" && noId.id === null);
});
