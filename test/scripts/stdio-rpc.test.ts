/**
 * Unit tests for the shared stdio JSON-RPC line reader.
 *
 * `readJsonLines` is the one piece of the two executing acceptance harnesses
 * (standalone-acceptance.ts drives `tools/list`, runtime-acceptance.ts drives `tools/call`)
 * that can be exercised without spawning anything: it takes a `ReadableStream<Uint8Array>`
 * and returns an async iterator, so a hand-built stream substitutes for a child process's
 * stdout exactly.
 *
 * That matters more than the line count suggests. Both harnesses used to carry their own
 * copy of this buffer-and-split loop, and neither copy was ever tested — a chunk boundary
 * landing mid-frame is invisible on a fast local server and routine under CI load, so the
 * failure mode is a harness that silently reports "server exited before answering" instead
 * of the check it was written to run. Every case below is a chunking or content shape that
 * a real server can produce and that the reader must survive.
 */

import { describe, expect, it } from "bun:test";
import { readJsonLines } from "../../scripts/_lib/stdio-rpc.ts";

/**
 * A stream whose chunk boundaries are exactly the ones written here. Each enqueued chunk is
 * returned by one `reader.read()`, which is what lets a frame be split at a chosen byte —
 * concatenating the inputs and letting the platform chunk it would test nothing.
 */
function streamOf(...chunks: ReadonlyArray<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(...chunks: ReadonlyArray<string | Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const msg of readJsonLines(streamOf(...chunks))) out.push(msg);
  return out;
}

describe("readJsonLines", () => {
  it("yields each newline-terminated frame, parsed, in arrival order", async () => {
    const messages = await collect(
      '{"jsonrpc":"2.0","id":1,"result":{}}\n',
      '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n',
    );

    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
  });

  it("splits several frames that arrive in a single chunk", async () => {
    // A server that writes its initialize reply and a log frame back to back lands both in
    // one read. Yielding the concatenation (or only the first) would strand the harness.
    const messages = await collect('{"id":1}\n{"id":2}\n{"id":3}\n');

    expect(messages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    // The defect this reader exists to prevent: without carrying the trailing fragment
    // forward, `{"id":100,"resu` is unparseable, gets discarded as noise, and the tools/call
    // reply never arrives.
    const messages = await collect('{"id":100,"resu', 'lt":{"isError":false}}', "\n");

    expect(messages).toEqual([{ id: 100, result: { isError: false } }]);
  });

  it("keeps the tail of a chunk that ends mid-frame while still yielding the frames before it", async () => {
    const messages = await collect('{"id":1}\n{"id":2,"par', 'tial":true}\n{"id":3}\n');

    expect(messages).toEqual([{ id: 1 }, { id: 2, partial: true }, { id: 3 }]);
  });

  it("drops an unterminated trailing fragment when the stream ends", async () => {
    // A killed server can leave half a frame in the pipe. That fragment is not a message and
    // must not be parsed or yielded — the caller's loop simply ends, which is what makes
    // standalone-acceptance report "server exited before answering tools/list" rather than
    // throwing on garbage.
    const messages = await collect('{"id":1}\n{"id":2,"trunc');

    expect(messages).toEqual([{ id: 1 }]);
  });

  it("never turns a blank or whitespace-only line into a message", async () => {
    // Doubly defended today — the blank guard short-circuits, and JSON.parse("") would be
    // caught anyway — so this pins the observable contract rather than one branch. It is
    // worth pinning: a reader that passed unparseable text through instead of dropping it
    // would emit `""` as a frame here, and the harnesses treat every yielded value as a
    // JSON-RPC message.
    const messages = await collect('\n{"id":1}\n\n   \n\t\n{"id":2}\n\n');

    expect(messages).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("skips non-JSON output and keeps reading the frames after it", async () => {
    // A connector printing a warning to stdout is untidy, not a protocol error. The frame
    // after the noise is the one the harness is waiting for, so aborting here would turn a
    // cosmetic problem into a failed acceptance run.
    const messages = await collect(
      "warning: something looked odd\n",
      '{"id":1,"result":{}}\n',
      "not json either {\n",
      '{"id":2,"result":{"tools":[{"name":"rt_list"}]}}\n',
    );

    expect(messages).toEqual([
      { id: 1, result: {} },
      { id: 2, result: { tools: [{ name: "rt_list" }] } },
    ]);
  });

  it("decodes a multi-byte character split across a chunk boundary", async () => {
    // "é" is C3 A9. Decoding each chunk independently turns the orphaned lead byte into
    // U+FFFD and silently corrupts the frame's text, so the reader must decode in streaming
    // mode and hold the incomplete sequence until its continuation byte arrives.
    const head = new TextEncoder().encode('{"text":"café"}\n');
    const boundary = head.indexOf(0xc3) + 1;

    const messages = await collect(head.slice(0, boundary), head.slice(boundary));

    expect(messages).toEqual([{ text: "café" }]);
  });
});
