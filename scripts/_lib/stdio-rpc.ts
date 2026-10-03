/**
 * Reads newline-delimited JSON messages off a child process's stdout.
 *
 * Shared by the two harnesses that actually execute a generated connector —
 * standalone-acceptance.ts (drives `tools/list`) and runtime-acceptance.ts (drives
 * `tools/call`) — which each carried their own copy of the same buffer-and-split loop.
 * Those are the only checks in this repo that run generated code rather than reading its
 * text, so two subtly different readers was a real hazard: a fix to one (the trailing
 * partial-line fragment, or the non-JSON noise a server may print before the transport takes
 * over) would silently not reach the other.
 *
 * Lifting it out also flattens both callers. A `for (;;)` wrapping a `for (const line ...)`
 * wrapping a `try/catch` wrapping the protocol `if`s put the interesting logic four levels
 * deep in both files; consuming an async iterator puts it one level deep.
 *
 * Non-JSON lines are skipped rather than thrown on: a connector printing a warning to stdout
 * is untidy, not a protocol error, and neither harness should fail on it.
 */
export async function* readJsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  let chunk = await reader.read();
  while (!chunk.done) {
    buffered += decoder.decode(chunk.value, { stream: true });

    const lines = buffered.split("\n");
    buffered = lines.pop() ?? ""; // keep the trailing partial fragment

    for (const line of lines) {
      if (line.trim() === "") continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a warning or other non-JSON output — not a protocol error
      }
      yield msg;
    }

    // One read at a time is what reading a stream is: whether to read again at all is the last
    // read's `done`. `for await` over the stream would say the same thing without an `await` in
    // the loop, but leaving that loop early CANCELS the stream (observed 2026-10-04, Bun 1.3.14),
    // and a caller that returns on the frame it wanted would then cancel the server's stdout under
    // it — a teardown this reader has never done.
    chunk = await reader.read(); // NOSONAR S9382: a stream read — the next read depends on this one's `done`
  }
}
