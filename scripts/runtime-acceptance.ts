/**
 * Executes a generated connector against a real HTTP server and asserts on the requests it
 * actually makes.
 *
 * Everything else in this repo checks emitted output *statically*: string assertions,
 * `tsc`, `biome`, a byte-diff against the corpus, and `tools/list` — which proves the server
 * starts and describes itself, but never invokes a tool. So until this script existed, no
 * generated connector's `fetch` had ever run. Every belief about runtime behaviour was
 * inference from reading the emitted text.
 *
 * Two of those beliefs were load-bearing and had never been observed:
 *
 *   - that an unset optional boolean reaches the URL as `false` and is *absent* from the
 *     JSON body — decided by argument in the Stage C spec §8, never executed;
 *   - that `client-credentials` performs the token exchange before the API call, and reuses
 *     the cached token for the second call rather than exchanging twice.
 *
 * Both are asserted here against recorded wire traffic.
 *
 * Like the other acceptance harnesses this needs the SDK installed, so it is a deliberately
 * run script rather than a CI test. Unlike them it needs no network beyond the SDK install:
 * the "API" is a Bun.serve on an ephemeral loopback port, and the generated connector's base
 * URL is pointed at it.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFiles } from "../src/cli.ts";
import { generate } from "../src/emit/index.ts";
import { formatAll, initFormatter } from "../src/format.ts";
import { parseSdkArgs, resolveSdkRoot } from "../src/golden/sdk-root.ts";
import { parseSpec } from "../src/spec.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const { registry, flag } = parseSdkArgs(process.argv.slice(2));

const sdkPkg = registry
  ? undefined
  : join(
      resolveSdkRoot({
        ...(flag === undefined ? {} : { flag }),
        env: process.env["NIMBUS_SDK_ROOT"],
        scriptDir,
      }),
      "sdks",
      "typescript",
    );

/** One recorded inbound request, kept in arrival order. */
type Recorded = {
  method: string;
  path: string;
  auth: string | undefined;
  apiKey: string | undefined;
  contentType: string | undefined;
  body: string;
};

type Check = { name: string; ok: boolean; output: string };

const checks: Check[] = [];
function check(name: string, ok: boolean, output: string): void {
  checks.push({ name, ok, output });
}

/**
 * The fake API. Records every request, and answers by path:
 *   /items            → 200, a list
 *   /items/<id>       → 200 for GET/PATCH/DELETE
 *   /oauth/token      → 200 with an access token
 *   /boom             → 500, to exercise the emitted error branch
 */
function startApi(recorded: Recorded[]): { server: ReturnType<typeof Bun.serve>; base: string } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
      recorded.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        auth: req.headers.get("authorization") ?? undefined,
        apiKey: req.headers.get("x-api-key") ?? undefined,
        contentType: req.headers.get("content-type") ?? undefined,
        body,
      });
      if (url.pathname === "/oauth/token") {
        // `?short` mints a 2-second token, so the expiry path can be observed rather than
        // reasoned about. The emitted code halves its 60s renewal skew for short-lived
        // tokens, so expires_in: 2 is treated as valid for 1 second.
        const short = url.search.includes("short");
        return Response.json({
          access_token: short ? `short-${recorded.length}` : "exchanged-token-abc",
          expires_in: short ? 2 : 3600,
        });
      }
      if (url.pathname === "/boom") {
        return new Response("upstream exploded", { status: 500 });
      }
      return Response.json({ ok: true, path: url.pathname });
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

/** A bearer-auth connector exercising path interpolation, bodies, booleans and errors. */
function bearerSpec(base: string): unknown {
  return {
    name: "rtbearer",
    displayName: "RtBearer",
    description: "Runtime acceptance connector.",
    serviceLabel: "RtBearer",
    style: "hand-rolled",
    network: ["127.0.0.1"],
    syncInterval: 300,
    minNimbusVersion: "0.2.0",
    env: [{ vars: ["RTBEARER_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
    fetchHelper: { local: "rtGet", base, headers: "headers" },
    tools: [
      {
        name: "rt_list",
        description: "List items.",
        path: "/items?flag=${arg.flag|bool}",
        args: { flag: { type: "boolean", optional: true } },
      },
      {
        name: "rt_get",
        description: "Get one item.",
        path: "/items/${arg.id|enc}",
        args: { id: { type: "string" } },
      },
      {
        name: "rt_create",
        description: "Create an item.",
        path: "/items",
        method: "POST",
        effect: "write",
        args: {
          title: { type: "string" },
          draft: { type: "boolean", optional: true },
          size: { type: "number", optional: true, default: 20 },
        },
      },
      {
        name: "rt_patch",
        description: "Patch an item.",
        path: "/items/${arg.id|enc}",
        method: "PATCH",
        effect: "write",
        args: { id: { type: "string" }, title: { type: "string" } },
      },
      {
        name: "rt_remove",
        description: "Remove an item.",
        path: "/items/${arg.id|enc}",
        method: "DELETE",
        effect: "delete",
        args: { id: { type: "string" } },
      },
      { name: "rt_boom", description: "Trigger a 500.", path: "/boom" },
    ],
  };
}

/** A client-credentials connector, to observe the token exchange and its caching. */
function ccSpec(base: string): unknown {
  return {
    name: "rtcc",
    displayName: "RtCc",
    description: "Runtime acceptance client-credentials connector.",
    serviceLabel: "RtCc",
    style: "hand-rolled",
    network: ["127.0.0.1"],
    syncInterval: 300,
    minNimbusVersion: "0.2.0",
    env: [
      {
        vars: ["RTCC_CLIENT_ID", "RTCC_CLIENT_SECRET"],
        local: "authHeaders",
        auth: "client-credentials",
        tokenUrl: `${base}/oauth/token`,
        credentialsIn: "body",
      },
    ],
    fetchHelper: { local: "ccGet", base, headers: "authHeaders" },
    tools: [{ name: "cc_list", description: "List.", path: "/items" }],
  };
}

/**
 * rest-kit, whose writes take a completely different route: makeRestToolRegistrar in the
 * SDK builds the request from a `buildInit` callback, so none of the hand-rolled fetch
 * helper's code runs. That path had never been executed either.
 */
function restKitSpec(base: string): unknown {
  return {
    name: "rtrest",
    displayName: "RtRest",
    description: "Runtime acceptance rest-kit connector.",
    serviceLabel: "RtRest",
    style: "rest-kit",
    network: ["127.0.0.1"],
    syncInterval: 300,
    minNimbusVersion: "0.2.0",
    env: [{ vars: ["RTREST_TOKEN"], local: "authHeaders", bindings: ["t"], auth: "bearer" }],
    fetchHelper: { local: "rtRestFetch", base },
    tools: [
      { name: "rr_list", description: "List.", path: "/items" },
      {
        name: "rr_create",
        description: "Create.",
        path: "/items",
        method: "POST",
        effect: "write",
        args: { title: { type: "string" }, draft: { type: "boolean", optional: true } },
      },
      {
        name: "rr_patch",
        description: "Patch.",
        path: "/items/${arg.id|enc}",
        method: "PATCH",
        effect: "write",
        args: { id: { type: "string" }, title: { type: "string" } },
      },
    ],
  };
}

/** auth: "headers" — a named header rather than Authorization: Bearer. */
function headersSpec(base: string): unknown {
  return {
    name: "rthdr",
    displayName: "RtHdr",
    description: "Runtime acceptance header-auth connector.",
    serviceLabel: "RtHdr",
    style: "hand-rolled",
    network: ["127.0.0.1"],
    syncInterval: 300,
    minNimbusVersion: "0.2.0",
    env: [
      {
        vars: ["RTHDR_KEY"],
        local: "headers",
        bindings: ["k"],
        auth: "headers",
        headerNames: ["X-Api-Key"],
      },
    ],
    fetchHelper: { local: "hdrGet", base, headers: "headers" },
    tools: [{ name: "hdr_list", description: "List.", path: "/items" }],
  };
}

/** Same as ccSpec, but its token endpoint mints a 2-second token. */
function shortTokenSpec(base: string): unknown {
  const spec = ccSpec(base) as {
    name: string;
    displayName: string;
    serviceLabel: string;
    env: Array<{ tokenUrl: string; local: string }>;
    fetchHelper: { local: string; headers: string };
  };
  return {
    ...spec,
    name: "rtshort",
    displayName: "RtShort",
    serviceLabel: "RtShort",
    // credentialsIn: "basic" here and "body" in ccSpec, so both placements are executed
    // without a fourth install.
    env: [{ ...spec.env[0]!, tokenUrl: `${base}/oauth/token?short`, credentialsIn: "basic" }],
    fetchHelper: { ...spec.fetchHelper, local: "shortGet" },
  };
}

/** Generate a package into `dir`, point its SDK dependency at the right place, install. */
async function materialize(spec: unknown, dir: string): Promise<void> {
  const parsed = parseSpec(spec);
  await writeFiles(formatAll(generate(parsed, { target: "standalone" })), dir);
  if (sdkPkg !== undefined) {
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(await Bun.file(pkgPath).text());
    pkg.dependencies["@nimbus-dev/sdk"] = `file:${sdkPkg.replaceAll("\\", "/")}`;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, undefined, 2)}\n`, "utf8");
  }
  const install = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (install.exitCode !== 0) {
    throw new Error(`bun install failed in ${dir}:\n${install.stderr.toString()}`);
  }
}

/**
 * Drive a generated server over stdio: initialize, then one tools/call per request, in
 * order, returning each result. Sequential by design — the client-credentials cache check
 * depends on the two calls happening in a known order in one process.
 */
async function callTools(
  dir: string,
  env: Record<string, string>,
  calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  /** Pause between calls. Only the expiry scenario needs it — it must outlive a token. */
  gapMs = 0,
): Promise<Array<{ isError: boolean; text: string }>> {
  const proc = Bun.spawn(["bun", join(dir, "src", "server.ts")], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const results: Array<{ isError: boolean; text: string }> = [];
  try {
    const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "runtime-acceptance", version: "0.0.0" },
      },
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let next = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") continue;
        let msg: {
          id?: unknown;
          result?: { isError?: boolean; content?: Array<{ text?: string }> };
          error?: { message?: string };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          const first = calls[0];
          if (first === undefined) return results;
          send({
            jsonrpc: "2.0",
            id: 100,
            method: "tools/call",
            params: { name: first.name, arguments: first.args },
          });
          continue;
        }
        if (typeof msg.id === "number" && msg.id >= 100) {
          results.push({
            isError: msg.result?.isError === true || msg.error !== undefined,
            text:
              msg.result?.content?.map((c) => c.text ?? "").join("") ?? msg.error?.message ?? "",
          });
          next += 1;
          const call = calls[next];
          if (call === undefined) return results;
          if (gapMs > 0) await Bun.sleep(gapMs);
          send({
            jsonrpc: "2.0",
            id: 100 + next,
            method: "tools/call",
            params: { name: call.name, arguments: call.args },
          });
        }
      }
    }
    return results;
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

/**
 * Describes a credential-bearing header WITHOUT reproducing it.
 *
 * CodeQL flagged the original of this file for clear-text logging of sensitive information,
 * and it was right about more than the line it pointed at: six checks echoed bearer tokens,
 * an API key, and a `client_secret=` form body straight to stdout. The values here are
 * synthetic, but a harness whose output is safe only because its inputs are fake is one
 * edit away from not being, and this output lands in CI logs.
 *
 * Every value returned here is a STRING LITERAL selected by a comparison. Nothing is
 * extracted from the credential — no prefix, no length, no regex capture, no parsed key
 * name — because anything derived from the value carries its taint into the log.
 *
 * A first attempt got this wrong in a way worth recording: it returned
 * `${scheme}, unexpected value`, pulling the auth scheme out of the header with a regex.
 * That reads as harmless — a scheme is not a secret — but it is still a value derived from
 * the credential flowing to stdout, and CodeQL re-flagged the file for it. Comparison
 * results are not tainted; substrings of the secret are. Keep the branches, drop the
 * extraction.
 */
function describeAuth(value: string | undefined, expected: string): string {
  if (value === undefined) return "absent";
  return value === expected ? "present, as expected" : "present, unexpected value";
}

/**
 * Whether a token-exchange body carries exactly the expected form fields — reported as a
 * literal, since even the field NAMES are parsed out of a string containing the secret.
 */
function describeFormFields(body: string | undefined, expected: readonly string[]): string {
  if (body === undefined || body === "") return "(empty)";
  const params = new URLSearchParams(body);
  const missing = expected.filter((n) => !params.has(n));
  return missing.length === 0 ? "carries the expected fields" : "missing expected field(s)";
}

const find = (rec: readonly Recorded[], pred: (r: Recorded) => boolean): Recorded | undefined =>
  rec.find(pred);

async function main(): Promise<void> {
  await initFormatter();
  const recorded: Recorded[] = [];
  const { server, base } = startApi(recorded);
  const root = mkdtempSync(join(tmpdir(), "cnc-runtime-"));

  try {
    // ---- bearer connector -------------------------------------------------------------
    const bearerDir = join(root, "rtbearer");
    await materialize(bearerSpec(base), bearerDir);
    const results = await callTools(bearerDir, { RTBEARER_TOKEN: "tok-123" }, [
      { name: "rt_list", args: {} },
      { name: "rt_get", args: { id: "a b/c" } },
      { name: "rt_create", args: { title: "hello", draft: true } },
      { name: "rt_patch", args: { id: "x1", title: "renamed" } },
      { name: "rt_remove", args: { id: "x1" } },
      { name: "rt_boom", args: {} },
    ]);

    const list = find(recorded, (r) => r.path.startsWith("/items?"));
    check(
      "bearer token reaches the wire as an Authorization header",
      list?.auth === "Bearer tok-123",
      `Authorization: ${describeAuth(list?.auth, "Bearer tok-123")}`,
    );

    // Spec §8's decision, finally observed rather than argued.
    check(
      "unset optional boolean renders false in the URL",
      list?.path === "/items?flag=false",
      `GET ${list?.path ?? "(no request)"}`,
    );

    const created = find(recorded, (r) => r.method === "POST");
    const createdBody = created === undefined ? undefined : JSON.parse(created.body);
    check(
      'a boolean in a JSON body is a real boolean, not the string "true"',
      createdBody?.draft === true,
      `POST body: ${created?.body ?? "(none)"}`,
    );
    check(
      "a defaulted arg is sent with its default applied",
      createdBody?.size === 20,
      `POST body: ${created?.body ?? "(none)"}`,
    );
    check(
      "a write sends Content-Type: application/json",
      created?.contentType?.includes("application/json") === true,
      `Content-Type: ${created?.contentType ?? "(none)"}`,
    );

    const got = find(recorded, (r) => r.method === "GET" && r.path.startsWith("/items/"));
    check(
      "path args are percent-encoded at runtime",
      got?.path === "/items/a%20b%2Fc",
      `GET ${got?.path ?? "(no request)"}`,
    );

    const patched = find(recorded, (r) => r.method === "PATCH");
    const patchedBody = patched === undefined ? undefined : JSON.parse(patched.body);
    check(
      "a path arg is excluded from the default write body (D5)",
      patchedBody !== undefined && !("id" in patchedBody) && patchedBody.title === "renamed",
      `PATCH ${patched?.path ?? "?"} body: ${patched?.body ?? "(none)"}`,
    );

    const removed = find(recorded, (r) => r.method === "DELETE");
    check(
      "a DELETE whose only arg is in the path sends no body",
      removed !== undefined && removed.body === "",
      `DELETE ${removed?.path ?? "?"} body: ${JSON.stringify(removed?.body ?? null)}`,
    );

    const boom = results[5];
    check(
      "a non-2xx response surfaces as a tool error naming the status",
      boom?.isError === true && boom.text.includes("500"),
      `rt_boom → ${boom?.text ?? "(no result)"}`,
    );

    // ---- client-credentials connector -------------------------------------------------
    const ccDir = join(root, "rtcc");
    await materialize(ccSpec(base), ccDir);
    const before = recorded.length;
    await callTools(ccDir, { RTCC_CLIENT_ID: "id-1", RTCC_CLIENT_SECRET: "secret-1" }, [
      { name: "cc_list", args: {} },
      { name: "cc_list", args: {} },
    ]);
    const cc = recorded.slice(before);
    const exchanges = cc.filter((r) => r.path.startsWith("/oauth/token"));

    check(
      "the token exchange happens before the API call",
      cc[0]?.path.startsWith("/oauth/token") === true && cc[1]?.path === "/items",
      cc.map((r) => `${r.method} ${r.path}`).join(" → ") || "(no requests)",
    );
    check(
      "credentialsIn: body puts the id and secret in the form body",
      exchanges[0]?.body.includes("client_id=id-1") === true &&
        exchanges[0].body.includes("client_secret=secret-1"),
      `token body: ${describeFormFields(exchanges[0]?.body, ["grant_type", "client_id", "client_secret"])}`,
    );
    check(
      "the exchanged token is used for the API call",
      cc[1]?.auth === "Bearer exchanged-token-abc",
      `Authorization: ${describeAuth(cc[1]?.auth, "Bearer exchanged-token-abc")}`,
    );
    check(
      "the token is cached — two tool calls, one exchange",
      exchanges.length === 1,
      `${exchanges.length} exchange(s) for ${cc.filter((r) => r.path === "/items").length} API call(s)`,
    );
    // ---- rest-kit -----------------------------------------------------------------
    // A different code path end to end: makeRestToolRegistrar builds the request from the
    // emitted `buildInit` callback, so none of the hand-rolled helper above runs.
    const restDir = join(root, "rtrest");
    await materialize(restKitSpec(base), restDir);
    const beforeRest = recorded.length;
    await callTools(restDir, { RTREST_TOKEN: "rest-tok" }, [
      { name: "rr_list", args: {} },
      { name: "rr_create", args: { title: "made", draft: true } },
      { name: "rr_patch", args: { id: "p1", title: "renamed" } },
    ]);
    const rest = recorded.slice(beforeRest);
    const restPost = find(rest, (r) => r.method === "POST");
    const restPostBody = restPost === undefined ? undefined : JSON.parse(restPost.body);
    const restPatch = find(rest, (r) => r.method === "PATCH");
    const restPatchBody = restPatch === undefined ? undefined : JSON.parse(restPatch.body);

    check(
      "rest-kit sends the bearer token the registrar resolves itself",
      find(rest, (r) => r.method === "GET")?.auth === "Bearer rest-tok",
      `Authorization: ${describeAuth(find(rest, (r) => r.method === "GET")?.auth, "Bearer rest-tok")}`,
    );
    check(
      "rest-kit buildInit produces the declared method and a JSON body",
      restPost?.method === "POST" && restPostBody?.title === "made" && restPostBody.draft === true,
      `POST ${restPost?.path ?? "?"} body: ${restPost?.body ?? "(none)"}`,
    );
    check(
      "rest-kit applies the D5 path-arg exclusion too",
      restPatchBody !== undefined && !("id" in restPatchBody) && restPatch?.path === "/items/p1",
      `PATCH ${restPatch?.path ?? "?"} body: ${restPatch?.body ?? "(none)"}`,
    );

    // ---- header auth ----------------------------------------------------------------
    const hdrDir = join(root, "rthdr");
    await materialize(headersSpec(base), hdrDir);
    const beforeHdr = recorded.length;
    await callTools(hdrDir, { RTHDR_KEY: "key-9" }, [{ name: "hdr_list", args: {} }]);
    const hdr = recorded.slice(beforeHdr)[0];
    check(
      'auth: "headers" sends the named header, not Authorization',
      hdr?.apiKey === "key-9" && hdr.auth === undefined,
      `X-Api-Key: ${describeAuth(hdr?.apiKey, "key-9")} / Authorization: ${describeAuth(hdr?.auth, "")}`,
    );

    // ---- token expiry ----------------------------------------------------------------
    // The cache used to be unconditional: `if (cachedToken !== null) return cachedToken`,
    // with expires_in never read. Correct only while connectors stayed short-lived, which
    // is a property of the caller, not of this code. Observed here rather than argued.
    const shortDir = join(root, "rtshort");
    await materialize(shortTokenSpec(base), shortDir);
    const beforeShort = recorded.length;
    await callTools(
      shortDir,
      { RTCC_CLIENT_ID: "id-2", RTCC_CLIENT_SECRET: "secret-2" },
      [
        { name: "cc_list", args: {} },
        { name: "cc_list", args: {} },
        { name: "cc_list", args: {} },
      ],
      // Longer than the 1s the emitted code treats a 2s token as valid for, so at least one
      // gap straddles an expiry. Short enough to keep the harness quick.
      1400,
    );
    const short = recorded.slice(beforeShort);
    const shortExchanges = short.filter((r) => r.path.startsWith("/oauth/token"));
    const apiCalls = short.filter((r) => r.path === "/items");
    check(
      'credentialsIn: "basic" sends the credentials as an Authorization: Basic header',
      shortExchanges[0]?.auth?.startsWith("Basic ") === true &&
        !shortExchanges[0].body.includes("client_secret"),
      `Basic scheme: ${shortExchanges[0]?.auth?.startsWith("Basic ") === true}; ` +
        `secret kept out of the body: ${shortExchanges[0]?.body.includes("client_secret") === false}`,
    );
    check(
      "an expired token is re-exchanged rather than reused",
      shortExchanges.length > 1,
      `${shortExchanges.length} exchange(s) for ${apiCalls.length} API call(s)`,
    );
    check(
      "the API call after re-exchange carries the NEW token",
      apiCalls.at(-1)?.auth !== apiCalls[0]?.auth,
      `first and last Authorization differ: ${apiCalls.at(-1)?.auth !== apiCalls[0]?.auth}`,
    );
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }

  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.output}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} runtime checks passed.`);
  if (failed.length > 0) throw new Error(`${failed.length} runtime check(s) failed.`);
}

if (!existsSync(scriptDir)) throw new Error("unreachable");
await main();
