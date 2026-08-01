/**
 * Constructing and interpreting the MCP JSON-RPC frames the two executing harnesses drive a
 * generated connector with.
 *
 * scripts/_lib/stdio-rpc.ts already owns the transport half — turning a child process's
 * stdout into a stream of parsed frames. This is the other half: what the harnesses send,
 * and how they read a reply. It lives here for the same two reasons stdio-rpc.ts does.
 *
 * One is duplication: standalone-acceptance drives `tools/list` and runtime-acceptance drives
 * `tools/call`, but both have to decide "is this frame the answer I am waiting for, and what
 * does it say", and both got that wrong in the same way once already.
 *
 * The other is testability, and it is measured rather than aesthetic. bunfig.toml enforces
 * `coverageThreshold` PER FILE and Bun only reports a file something imports, so a test that
 * reached into runtime-acceptance.ts to call `toResult` pulled the whole harness — five
 * scenario functions that each run `bun install` and spawn a server — into the report, where
 * it cannot clear the 78% line floor. The pure frame logic being here and the subprocess
 * orchestration being there is exactly the line that floor is drawing.
 */

/** One decoded JSON-RPC frame, in the only shapes these harnesses look at. */
export type RpcMessage = {
  id?: unknown;
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
  error?: { message?: string };
};

export type ToolCall = { name: string; args: Record<string, unknown> };

/** tools/call request ids start at 100, so `id >= 100` identifies a tool reply. */
export const toolCallRequest = (id: number, call: ToolCall): unknown => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: call.name, arguments: call.args },
});

/**
 * A tools/call reply flattened to the pair the runtime checks assert on.
 *
 * `isError` is true for BOTH shapes a failure can arrive in: a protocol-level `error` frame,
 * and a successful response whose result carries `isError: true` — which is how the MCP SDK
 * reports a tool that threw. Reading only one of them makes "a non-2xx response surfaces as
 * a tool error" pass vacuously.
 */
export function toResult(msg: RpcMessage): { isError: boolean; text: string } {
  return {
    isError: msg.result?.isError === true || msg.error !== undefined,
    text: msg.result?.content?.map((c) => c.text ?? "").join("") ?? msg.error?.message ?? "",
  };
}

/** The `tools/list` reply reduced to the verdict, plus a line naming what it did return. */
export function describeToolsList(
  tools: ReadonlyArray<{ name?: string }> | undefined,
  expected: readonly string[],
): { ok: boolean; output: string } {
  const names = (tools ?? []).map((t) => t.name);
  const missing = expected.filter((n) => !names.includes(n));
  return {
    ok: missing.length === 0,
    output:
      missing.length === 0
        ? `tools/list returned ${names.join(", ")}`
        : `tools/list missing ${missing.join(", ")}; got ${names.join(", ") || "(none)"}`,
  };
}
