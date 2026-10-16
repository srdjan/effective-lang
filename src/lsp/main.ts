// The stdio entry of the language server (plan 5.4 and 5.12). It reads frames
// from stdin, feeds them to the server, and writes each reply with a blocking
// write. Log text goes to stderr and never to stdout. The end of stdin ends the
// process: code 0 after `shutdown`, else 1.

import { denoFs } from "../cli/deno_io.ts";
import {
  encodeMessage,
  FrameDecoder,
  type OutgoingMessage,
} from "./jsonrpc.ts";
import { LanguageServer } from "./server.ts";

const textEncoder = new TextEncoder();

/** Writes every byte. `writeSync` can return a short count on a pipe. */
function writeAll(
  stream: { writeSync(bytes: Uint8Array): number },
  bytes: Uint8Array,
): void {
  let written = 0;
  while (written < bytes.length) {
    written += stream.writeSync(bytes.subarray(written));
  }
}

const server = new LanguageServer({
  send: (message: OutgoingMessage) => {
    writeAll(Deno.stdout, encodeMessage(message));
  },
  fs: denoFs,
  schedule: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
  exit: (code) => Deno.exit(code),
  memory: () => {
    const { rss, heapUsed } = Deno.memoryUsage();
    return { rss, heapUsed };
  },
  stderr: (text) => {
    writeAll(Deno.stderr, textEncoder.encode(text));
  },
});

const decoder = new FrameDecoder();
for await (const chunk of Deno.stdin.readable) {
  for (const frame of decoder.push(chunk)) server.handle(frame);
  server.afterBatch();
}
Deno.exit(server.shutdownSeen ? 0 : 1);
