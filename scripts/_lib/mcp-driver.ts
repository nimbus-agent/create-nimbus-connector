/**
 * Driving a generated connector's stdio MCP server: the two conversations the acceptance
 * harnesses hold with it.
 *
 * Both spawn `bun <entry>`, send `initialize`, wait for the reply, send
 * `notifications/initialized`, and then ask their question — `tools/list` for
 * standalone-acceptance, a sequence of `tools/call` for runtime-acceptance. Everything up to
 * "and then ask their question" was written twice, and the frame-filtering rules that decide
 * WHICH reply is the answer are the subtle part of both.
 *
 * They live here rather than in their harnesses because they are drivable by a test — point
 * either at a script that speaks JSON-RPC on stdio and the whole conversation runs, no npm
 * install and no generated package required — whereas the scenario code around them is not.
 * bunfig.toml's per-file `coverageThreshold` makes that distinction structural: a test that
 * reached into runtime-acceptance.ts pulled five `bun install`-running scenarios into the
 * coverage report with it, where the file cannot clear the 78% floor.
 *
 * Both are deliberately sequential and single-process. runtime-acceptance's "two tool calls,
 * one token exchange" check is a statement about one server's cache across one conversation;
 * running the calls concurrently, or in separate processes, would make it assert nothing.
 */

import { join } from "node:path";
import {
  describeToolsList,
  type RpcMessage,
  type ToolCall,
  toolCallRequest,
  toResult,
} from "./mcp-frames.ts";
import { readJsonLines } from "./stdio-rpc.ts";

/** The initialize frame both harnesses open with; `clientInfo.name` is the only difference. */
function initializeRequest(clientName: string): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "0.0.0" },
    },
  };
}

/**
 * Drive a generated server over stdio: initialize, then one tools/call per request, in
 * order, returning each result.
 *
 * @param dir     the generated package; its src/server.ts is what gets run
 * @param env     credential variables to add to the server's environment
 * @param calls   the tool calls to make, in order
 * @param gapMs   pause between calls. Only the token-expiry scenario needs it — that gap
 *                must outlive a token, which is the only way an expiry can be observed
 *                rather than argued.
 * @param timeoutMs kill the server after this long. A parameter with the harness's own
 *                value as its default, so the give-up path can be executed by a test rather
 *                than assumed: a server that accepts a call and never answers must end the
 *                conversation, not hang the run.
 */
export async function callTools(
  dir: string,
  env: Record<string, string>,
  calls: readonly ToolCall[],
  gapMs = 0,
  timeoutMs = 30_000,
): Promise<Array<{ isError: boolean; text: string }>> {
  const proc = Bun.spawn(["bun", join(dir, "src", "server.ts")], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const results: Array<{ isError: boolean; text: string }> = [];
  try {
    const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
    send(initializeRequest("runtime-acceptance"));

    let next = 0;

    for await (const raw of readJsonLines(proc.stdout)) {
      const msg = raw as RpcMessage;

      if (msg.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const first = calls[0];
        if (first === undefined) return results;
        send(toolCallRequest(100, first));
        continue;
      }

      // Anything that is not a tools/call reply — a notification, a server log frame — is
      // not a result and must not advance `next`. Advancing on one would pair every later
      // result with the wrong call and silently shift the whole scenario's assertions.
      if (typeof msg.id !== "number" || msg.id < 100) continue;

      results.push(toResult(msg));
      next += 1;
      const call = calls[next];
      if (call === undefined) return results;
      if (gapMs > 0) await Bun.sleep(gapMs);
      send(toolCallRequest(100 + next, call));
    }
    return results;
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

/**
 * Start a generated server and ask it to describe itself.
 *
 * No credential env vars are set on purpose: accessors are only called inside tool handlers,
 * so a clean `tools/list` proves the server starts and describes itself without secrets.
 *
 * A server that dies before answering is a FAILED check carrying its stderr, not a throw —
 * the caller is collecting verdicts for several fixtures and must report this one rather
 * than abandoning the rest.
 */
export async function toolsListCheck(
  cwd: string,
  entryPath: string,
  expected: readonly string[],
  /** As in callTools: the harness's own value, as a default a test can lower. */
  timeoutMs = 10_000,
): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bun", entryPath], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
    send(initializeRequest("standalone-acceptance"));

    let sawInitialized = false;

    // Read until the tools/list response (id 2) arrives, the process exits, or the timeout
    // kills it.
    for await (const raw of readJsonLines(proc.stdout)) {
      const msg = raw as { id?: unknown; result?: { tools?: Array<{ name?: string }> } };

      if (msg.id === 1 && !sawInitialized) {
        sawInitialized = true;
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        continue;
      }

      if (msg.id === 2) return describeToolsList(msg.result?.tools, expected);
    }

    const stderr = await new Response(proc.stderr).text();
    return { ok: false, output: `server exited before answering tools/list.\n${stderr.trim()}` };
  } finally {
    clearTimeout(timer);
    proc.kill();
    // kill() only signals. Without awaiting exit, this returns while the server is still
    // running, and the caller's `rmSync(outDir)` races it — on Windows, removing a
    // directory whose files a live process still holds open fails outright. Four servers
    // are spawned per fixture now that both entry points are exercised.
    await proc.exited;
  }
}
