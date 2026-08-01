/**
 * Integration tests for the two stdio conversations the acceptance harnesses hold with a
 * generated connector — driven against a real child process, not a mock.
 *
 * The fake server below is a genuine `bun` subprocess speaking JSON-RPC over stdin/stdout,
 * so `Bun.spawn`, the pipe, the chunk boundaries and the process teardown are all exercised.
 * What it is NOT is a *generated connector*: producing one of those costs a `bun install`
 * per fixture, which is why runtime-acceptance and standalone-acceptance are deliberately
 * run scripts. Substituting the server is what makes the driver testable at all; everything
 * the driver decides — which frame is the answer, how replies pair with requests, what
 * happens when the server dies — is decided from the frames, not from the server.
 *
 * These rules had never been executed by a test, and each has a silent failure mode:
 * advancing the call index on a log frame pairs every later result with the wrong call and
 * shifts a whole scenario's assertions without failing anything.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTools, toolsListCheck } from "../../scripts/_lib/mcp-driver.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

/**
 * A minimal MCP-ish server. `mode` is baked into the script rather than read from the
 * environment, because toolsListCheck deliberately spawns with no credential variables set —
 * a behaviour worth keeping, not working around.
 */
const fakeServer = (mode: string): string => `const mode = ${JSON.stringify(mode)};
${BODY}`;

const BODY = String.raw`
const say = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

if (mode === "exit") {
  process.stderr.write("fake server: refusing to start\n");
  process.exit(3);
}

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === "") continue;
    const msg = JSON.parse(line);

    if (msg.method === "initialize") {
      if (mode === "noise") say({ jsonrpc: "2.0", method: "notifications/message", params: {} });
      say({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "fake" } } });
      continue;
    }
    if (msg.method === "notifications/initialized") continue;

    if (mode === "hang") continue;

    if (msg.method === "tools/list") {
      const tools =
        mode === "partial" ? [{ name: "a_one" }] : [{ name: "a_one" }, { name: "a_two" }];
      if (mode === "notools") { say({ jsonrpc: "2.0", id: 2, result: {} }); continue; }
      say({ jsonrpc: "2.0", id: 2, result: { tools } });
      continue;
    }

    if (msg.method === "tools/call") {
      // A log frame and a notification between the request and its reply. Both must be
      // ignored: neither is a tools/call result, and treating either as one desynchronises
      // every later call from its result.
      if (mode === "noise") {
        say({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
        say({ jsonrpc: "2.0", id: 7, result: { note: "a server log frame" } });
      }
      if (msg.params.name === "boom") {
        say({
          jsonrpc: "2.0",
          id: msg.id,
          result: { isError: true, content: [{ text: "HTTP 500" }] },
        });
        continue;
      }
      if (msg.params.name === "protocol_error") {
        say({ jsonrpc: "2.0", id: msg.id, error: { message: "no such tool" } });
        continue;
      }
      say({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            {
              text: JSON.stringify({
                id: msg.id,
                tool: msg.params.name,
                args: msg.params.arguments,
                token: process.env.FAKE_TOKEN ?? null,
              }),
            },
          ],
        },
      });
    }
  }
}
`;

/** A package tree whose src/server.ts is the fake server — the shape callTools expects. */
function fakePackage(mode = "ok"): string {
  const dir = tmp.make("cnc-driver-");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "server.ts"), fakeServer(mode), "utf8");
  return dir;
}

/** A directory with the fake server at a named entry path, as toolsListCheck takes it. */
function fakeEntry(name: string, mode = "ok"): { cwd: string; entry: string } {
  const cwd = tmp.make("cnc-driver-entry-");
  writeFileSync(join(cwd, name), fakeServer(mode), "utf8");
  return { cwd, entry: name };
}

describe("callTools", () => {
  it("runs every call, in order, and returns one result each", async () => {
    const results = await callTools(fakePackage(), {}, [
      { name: "first", args: {} },
      { name: "second", args: { x: 1 } },
      { name: "third", args: {} },
    ]);

    expect(results).toHaveLength(3);
    expect(results.map((r) => JSON.parse(r.text).tool)).toEqual(["first", "second", "third"]);
    expect(results.every((r) => !r.isError)).toBe(true);
  });

  it("numbers tools/call requests from 100 upwards, one per call", async () => {
    // The ids are how a reply is recognised as a tool result at all (`id >= 100`). Reusing
    // one, or starting below 100, makes the driver ignore its own answers and hang until the
    // 30s kill.
    const results = await callTools(fakePackage(), {}, [
      { name: "first", args: {} },
      { name: "second", args: {} },
    ]);

    expect(results.map((r) => JSON.parse(r.text).id)).toEqual([100, 101]);
  });

  it("passes the tool's arguments through to the server unchanged", async () => {
    const results = await callTools(fakePackage(), {}, [
      { name: "rt_get", args: { id: "a b/c", flag: false, size: 20 } },
    ]);

    expect(JSON.parse(results[0]!.text).args).toEqual({ id: "a b/c", flag: false, size: 20 });
  });

  it("puts the caller's environment variables into the server's process", async () => {
    // This is how every credential reaches a generated connector under test. If the env
    // never arrived, the auth checks would all report "absent" and read as emitter defects.
    const results = await callTools(fakePackage(), { FAKE_TOKEN: "tok-123" }, [
      { name: "whoami", args: {} },
    ]);

    expect(JSON.parse(results[0]!.text).token).toBe("tok-123");
  });

  it("ignores notifications and low-id log frames instead of counting them as results", async () => {
    // The defect this rule prevents, and the reason it is worth a test: a server log frame
    // counted as a result advances the call index, so call N+1's assertions get run against
    // call N's answer. Nothing fails — the scenario just checks the wrong things.
    const results = await callTools(fakePackage("noise"), {}, [
      { name: "first", args: {} },
      { name: "second", args: {} },
    ]);

    expect(results).toHaveLength(2);
    expect(results.map((r) => JSON.parse(r.text).tool)).toEqual(["first", "second"]);
  });

  it("surfaces a result flagged isError, with its text", async () => {
    const results = await callTools(fakePackage(), {}, [{ name: "boom", args: {} }]);

    expect(results[0]).toEqual({ isError: true, text: "HTTP 500" });
  });

  it("surfaces a protocol-level error frame as a failed result", async () => {
    const results = await callTools(fakePackage(), {}, [{ name: "protocol_error", args: {} }]);

    expect(results[0]).toEqual({ isError: true, text: "no such tool" });
  });

  it("returns immediately, with no results, when asked to make no calls", async () => {
    // The early return after initialize. Without it the driver waits on a server that has
    // been asked nothing, and the scenario stalls until the 30s kill rather than reporting.
    const results = await callTools(fakePackage(), {}, []);

    expect(results).toEqual([]);
  });

  it("returns what it has when the server dies before answering", async () => {
    // Not a throw: the caller is mid-scenario and the checks it has already collected are
    // still worth reporting.
    const results = await callTools(fakePackage("exit"), {}, [{ name: "first", args: {} }]);

    expect(results).toEqual([]);
  });

  it("gives up on a server that accepts a call and never answers", async () => {
    // The timer is the only thing standing between a wedged connector and a run that never
    // finishes. Exercised at 400ms rather than the harness's 30s; the give-up path is the
    // same one.
    const results = await callTools(fakePackage("hang"), {}, [{ name: "first", args: {} }], 0, 400);

    expect(results).toEqual([]);
  });

  it("honours the inter-call gap", async () => {
    // The token-expiry scenario is the only caller that passes one, and it is the entire
    // mechanism by which an expiry is observed rather than argued: the gap has to outlive
    // the token. A gap that was accepted and ignored would make that check pass for the
    // wrong reason, always.
    const start = Date.now();
    await callTools(
      fakePackage(),
      {},
      [
        { name: "first", args: {} },
        { name: "second", args: {} },
        { name: "third", args: {} },
      ],
      120,
    );

    // Two gaps between three calls. Compared against a floor well under 240ms so a slow
    // machine cannot make this flaky in the other direction.
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });
});

describe("toolsListCheck", () => {
  it("passes when the server lists every expected tool", async () => {
    const { cwd, entry } = fakeEntry("server.ts");

    const result = await toolsListCheck(cwd, entry, ["a_one", "a_two"]);

    expect(result).toEqual({ ok: true, output: "tools/list returned a_one, a_two" });
  });

  it("runs the entry path it is given, not a fixed one", async () => {
    // standalone-acceptance calls this twice per fixture — once for src/server.ts and once
    // for the bundled dist/server.js the Gateway actually launches. A hardcoded entry would
    // run the source twice and report the bundle as proven when it was never started.
    const { cwd, entry } = fakeEntry("dist-server.js");

    expect((await toolsListCheck(cwd, entry, ["a_one"])).ok).toBe(true);
  });

  it("fails and names the tools the server did not list", async () => {
    const { cwd, entry } = fakeEntry("server.ts", "partial");

    const result = await toolsListCheck(cwd, entry, ["a_one", "a_two"]);

    expect(result).toEqual({ ok: false, output: "tools/list missing a_two; got a_one" });
  });

  it("fails when the reply carries no tools field at all", async () => {
    // A server that answered but described nothing. Reporting ok here would pass a
    // connector that registered no tools.
    const { cwd, entry } = fakeEntry("server.ts", "notools");

    const result = await toolsListCheck(cwd, entry, ["a_one"]);

    expect(result).toEqual({ ok: false, output: "tools/list missing a_one; got (none)" });
  });

  it("gives up on a server that starts and then goes silent", async () => {
    const { cwd, entry } = fakeEntry("server.ts", "hang");

    const result = await toolsListCheck(cwd, entry, ["a_one"], 400);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("server exited before answering tools/list");
  });

  it("reports a server that exits before answering, and quotes its stderr", async () => {
    // The failure mode a broken bundle produces. It must come back as a FAILED check
    // carrying the diagnosis — the harness is collecting verdicts for five fixtures, and
    // throwing here would abandon the rest of the run.
    const { cwd, entry } = fakeEntry("server.ts", "exit");

    const result = await toolsListCheck(cwd, entry, ["a_one"]);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("server exited before answering tools/list");
    expect(result.output).toContain("fake server: refusing to start");
  });
});
