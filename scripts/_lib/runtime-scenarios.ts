/**
 * The scenarios scripts/runtime-acceptance.ts drives a generated connector through, and the
 * checks that judge the requests each one made.
 *
 * Every other piece of that harness was lifted into scripts/_lib/ already — the fake API
 * (fake-api.ts), the stdio driver (mcp-driver.ts), the frame reader (stdio-rpc.ts), the
 * redaction helpers (redact.ts), the SDK resolution (sdk-pkg.ts) — each for the reason
 * mcp-frames.ts's header gives: bunfig.toml enforces `coverageThreshold` PER FILE, and a test that
 * reached into the driver pulled its `bun install`-running scenarios into the report with it. What
 * stayed behind was the part the harness exists for: the checks themselves. A check is a statement
 * about recorded traffic — "the token is cached", "the base's path segment is not duplicated" —
 * and a check that cannot fail is a false green with the harness's whole authority behind it.
 * None of them had ever been shown to fail on the traffic of a connector that gets it wrong.
 *
 * So the split falls exactly where it does in the other modules: everything decidable from its
 * arguments is here, and the driver keeps the two things a unit test cannot run — `bun install`
 * into a generated package, and a live server answering `tools/call`.
 *
 * **Each judge reads only its own scenario's traffic.** The driver slices the shared request log
 * at the moment a scenario starts and hands the judge that slice, so "two tool calls, one
 * exchange" is a statement about one connector rather than about the whole run, and no judge
 * depends on which scenario ran before it.
 *
 * **Outputs never carry a credential.** Every value a check prints that came off the wire through
 * a credential-bearing header or form body goes through scripts/_lib/redact.ts — see its header
 * for why CodeQL was right to flag the version that did not.
 */

import type { Check } from "./checks.ts";
import type { Recorded } from "./fake-api.ts";
import type { ToolCall } from "./mcp-frames.ts";
import { describeAuth, describeFormFields } from "./redact.ts";

/** One `tools/call` result, in call order — what scripts/_lib/mcp-driver.ts's `callTools` returns. */
export type ToolResult = { isError: boolean; text: string };

/** One connector the harness generates, installs, drives, and judges. */
export type RuntimeScenario = {
  /** The connector's name, which is also its package directory under the run's temp root. */
  readonly name: string;
  /** The connector's spec, pointed at the fake API's base URL. */
  readonly spec: (base: string) => unknown;
  /** Credential variables the generated server is started with. */
  readonly env: Readonly<Record<string, string>>;
  /** The tool calls to make, in order, over one server's lifetime. */
  readonly calls: readonly ToolCall[];
  /** Pause between calls. Only the token-expiry scenario sets one. */
  readonly gapMs?: number;
  /** The checks, decided from THIS scenario's requests and tool results alone. */
  readonly judge: (traffic: readonly Recorded[], results: readonly ToolResult[]) => Check[];
};

/**
 * A request body parsed as a JSON object, or `undefined` when there is none or it is not one.
 *
 * Total on purpose: a judge that threw on a malformed body would abort the run with a stack trace
 * instead of reporting the one check that body fails, which hides every verdict after it.
 */
function jsonObject(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/* ------------------------------------------------------------------------------------------ *
 * Specs
 * ------------------------------------------------------------------------------------------ */

/** A bearer-auth connector exercising path interpolation, bodies, booleans and errors. */
export function bearerSpec(base: string): unknown {
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
export function ccSpec(base: string): unknown {
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
export function restKitSpec(base: string): unknown {
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

/**
 * A hand-rolled connector with one query-declaring GET tool, whose base has a path
 * component (`/v2`) — the shape every source-level check (compile, string assertion,
 * byte-diff) could pass while the actual request still doubled that path component onto
 * itself. Only a request actually made can prove it does not: buildPath/the handler return
 * an ABSOLUTE URL (`` `${u}` ``, tools-hand.ts/tools-rest.ts) to avoid the base being
 * prepended twice, and the fetch helper has to recognise and pass that absolute form
 * through untouched (fetch-helper.ts's `hasQueryTool` gate) rather than treating it as a
 * bare path and prepending the base again.
 */
export function querySpec(base: string): unknown {
  return {
    name: "rtquery",
    displayName: "RtQuery",
    description: "Runtime acceptance query-parameter connector.",
    serviceLabel: "RtQuery",
    style: "hand-rolled",
    network: ["127.0.0.1"],
    syncInterval: 300,
    minNimbusVersion: "0.2.0",
    env: [{ vars: ["RTQUERY_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
    // The path component ("/v2") is the whole point: a base with no path (api.github.com)
    // cannot distinguish "doubled" from "correct" — the doubling has nothing to duplicate.
    fetchHelper: { local: "rtqGet", base: `${base}/v2`, headers: "headers" },
    tools: [
      {
        name: "rtq_list",
        description: "List items, filtered.",
        path: "/items",
        args: {
          limit: { type: "number", optional: true, default: 10 },
          after: { type: "string", optional: true },
        },
        query: [
          { name: "limit", arg: "limit" },
          { name: "after", arg: "after", omitWhen: "empty" },
        ],
      },
    ],
  };
}

/** auth: "headers" — a named header rather than Authorization: Bearer. */
export function headersSpec(base: string): unknown {
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
export function shortTokenSpec(base: string): unknown {
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

/* ------------------------------------------------------------------------------------------ *
 * Judges
 * ------------------------------------------------------------------------------------------ */

const BEARER_CALLS: readonly ToolCall[] = [
  { name: "rt_list", args: {} },
  { name: "rt_get", args: { id: "a b/c" } },
  { name: "rt_create", args: { title: "hello", draft: true } },
  { name: "rt_patch", args: { id: "x1", title: "renamed" } },
  { name: "rt_remove", args: { id: "x1" } },
  { name: "rt_boom", args: {} },
];

/**
 * The bearer connector: auth, the URL and body halves of the optional-boolean asymmetry README.md
 * explains, defaults, path encoding, the D5 path-arg exclusion, and the error branch.
 *
 * The `rt_boom` result is found by the call's NAME, not its position, so reordering
 * `BEARER_CALLS` cannot quietly point this check at a different tool's result.
 */
export function bearerChecks(
  traffic: readonly Recorded[],
  results: readonly ToolResult[],
): Check[] {
  const list = traffic.find((r) => r.path.startsWith("/items?"));
  const created = traffic.find((r) => r.method === "POST");
  const createdBody = jsonObject(created?.body);
  const got = traffic.find((r) => r.method === "GET" && r.path.startsWith("/items/"));
  const patched = traffic.find((r) => r.method === "PATCH");
  const patchedBody = jsonObject(patched?.body);
  const removed = traffic.find((r) => r.method === "DELETE");
  const boom = results[BEARER_CALLS.findIndex((c) => c.name === "rt_boom")];

  return [
    {
      name: "bearer token reaches the wire as an Authorization header",
      ok: list?.auth === "Bearer tok-123",
      output: `Authorization: ${describeAuth(list?.auth, "Bearer tok-123")}`,
    },
    // The URL half of the asymmetry, observed rather than argued.
    {
      name: "unset optional boolean renders false in the URL",
      ok: list?.path === "/items?flag=false",
      output: `GET ${list?.path ?? "(no request)"}`,
    },
    {
      name: 'a boolean in a JSON body is a real boolean, not the string "true"',
      ok: createdBody?.draft === true,
      output: `POST body: ${created?.body ?? "(none)"}`,
    },
    {
      name: "a defaulted arg is sent with its default applied",
      ok: createdBody?.size === 20,
      output: `POST body: ${created?.body ?? "(none)"}`,
    },
    {
      name: "a write sends Content-Type: application/json",
      ok: created?.contentType?.includes("application/json") === true,
      output: `Content-Type: ${created?.contentType ?? "(none)"}`,
    },
    {
      name: "path args are percent-encoded at runtime",
      ok: got?.path === "/items/a%20b%2Fc",
      output: `GET ${got?.path ?? "(no request)"}`,
    },
    {
      name: "a path arg is excluded from the default write body (D5)",
      ok: patchedBody !== undefined && !("id" in patchedBody) && patchedBody.title === "renamed",
      output: `PATCH ${patched?.path ?? "?"} body: ${patched?.body ?? "(none)"}`,
    },
    {
      name: "a DELETE whose only arg is in the path sends no body",
      ok: removed?.body === "",
      output: `DELETE ${removed?.path ?? "?"} body: ${JSON.stringify(removed?.body ?? null)}`,
    },
    {
      name: "a non-2xx response surfaces as a tool error naming the status",
      ok: boom?.isError === true && boom.text.includes("500"),
      output: `rt_boom → ${boom?.text ?? "(no result)"}`,
    },
  ];
}

const CC_CALLS: readonly ToolCall[] = [
  { name: "cc_list", args: {} },
  { name: "cc_list", args: {} },
];

/**
 * client-credentials: the exchange precedes the API call, carries the credentials where
 * `credentialsIn: "body"` says, and is cached.
 *
 * The caching check requires BOTH calls to have reached the API, not only one exchange. Counting
 * exchanges alone passed a connector whose second call never made a request at all — one
 * exchange, one API call, and a green "two tool calls, one exchange" over a run that never asked
 * the cache anything.
 */
export function clientCredentialsChecks(traffic: readonly Recorded[]): Check[] {
  const exchanges = traffic.filter((r) => r.path.startsWith("/oauth/token"));
  const apiCalls = traffic.filter((r) => r.path === "/items");

  return [
    {
      name: "the token exchange happens before the API call",
      ok: traffic[0]?.path.startsWith("/oauth/token") === true && traffic[1]?.path === "/items",
      output: traffic.map((r) => `${r.method} ${r.path}`).join(" → ") || "(no requests)",
    },
    {
      name: "credentialsIn: body puts the id and secret in the form body",
      ok:
        exchanges[0]?.body.includes("client_id=id-1") === true &&
        exchanges[0].body.includes("client_secret=secret-1"),
      output: `token body: ${describeFormFields(exchanges[0]?.body, ["grant_type", "client_id", "client_secret"])}`,
    },
    {
      name: "the exchanged token is used for the API call",
      ok: traffic[1]?.auth === "Bearer exchanged-token-abc",
      output: `Authorization: ${describeAuth(traffic[1]?.auth, "Bearer exchanged-token-abc")}`,
    },
    {
      name: "the token is cached — two tool calls, one exchange",
      ok: exchanges.length === 1 && apiCalls.length === CC_CALLS.length,
      output: `${exchanges.length} exchange(s) for ${apiCalls.length} API call(s)`,
    },
  ];
}

/**
 * rest-kit: a different code path end to end. makeRestToolRegistrar builds the request from
 * the emitted `buildInit` callback, so none of the hand-rolled fetch helper runs.
 */
export function restKitChecks(traffic: readonly Recorded[]): Check[] {
  const listed = traffic.find((r) => r.method === "GET");
  const posted = traffic.find((r) => r.method === "POST");
  const postedBody = jsonObject(posted?.body);
  const patched = traffic.find((r) => r.method === "PATCH");
  const patchedBody = jsonObject(patched?.body);

  return [
    {
      name: "rest-kit sends the bearer token the registrar resolves itself",
      ok: listed?.auth === "Bearer rest-tok",
      output: `Authorization: ${describeAuth(listed?.auth, "Bearer rest-tok")}`,
    },
    {
      name: "rest-kit buildInit produces the declared method and a JSON body",
      ok: posted?.method === "POST" && postedBody?.title === "made" && postedBody.draft === true,
      output: `POST ${posted?.path ?? "?"} body: ${posted?.body ?? "(none)"}`,
    },
    {
      name: "rest-kit applies the D5 path-arg exclusion too",
      ok: patchedBody !== undefined && !("id" in patchedBody) && patched?.path === "/items/p1",
      output: `PATCH ${patched?.path ?? "?"} body: ${patched?.body ?? "(none)"}`,
    },
  ];
}

/**
 * The check Critical 1 of Task 4's round-1 review asked for: every other gate in this repo
 * looks at emitted SOURCE (a shape check, a string assertion, a byte-diff), and none of them
 * observed the actual REQUEST — which is exactly how a doubled base URL survived a green
 * board. `querySpec`'s base carries a path component precisely so this can fail: if the
 * request lands at "/v2/v2/items" the assertion below catches it directly, rather than
 * inferring correctness from the emitted text.
 */
export function queryChecks(traffic: readonly Recorded[]): Check[] {
  const list = traffic[0];
  return [
    {
      name: "a query tool's request path carries the base's path component exactly once",
      ok: list?.path === "/v2/items?limit=10&after=abc",
      output: `GET ${list?.path ?? "(no request)"}`,
    },
    {
      name: "the base's own path segment is not duplicated in the request",
      ok: (list?.path.match(/\/v2/g) ?? []).length === 1,
      output: `GET ${list?.path ?? "(no request)"}`,
    },
  ];
}

/** auth: "headers" sends the header the spec names, and nothing in Authorization. */
export function headerAuthChecks(traffic: readonly Recorded[]): Check[] {
  const hdr = traffic[0];
  return [
    {
      name: 'auth: "headers" sends the named header, not Authorization',
      ok: hdr?.apiKey === "key-9" && hdr.auth === undefined,
      output: `X-Api-Key: ${describeAuth(hdr?.apiKey, "key-9")} / Authorization: ${describeAuth(hdr?.auth, "")}`,
    },
  ];
}

/**
 * Token expiry. The cache used to be unconditional: `if (cachedToken !== null) return
 * cachedToken`, with expires_in never read — correct only while connectors stayed
 * short-lived, which is a property of the caller, not of this code. Observed here rather
 * than argued.
 *
 * "Carries the NEW token" requires the last call to carry one at all. Comparing the first and
 * last Authorization alone passed a connector that dropped the header after re-exchanging, since
 * an absent header differs from every token.
 */
export function tokenExpiryChecks(traffic: readonly Recorded[]): Check[] {
  const exchanges = traffic.filter((r) => r.path.startsWith("/oauth/token"));
  const apiCalls = traffic.filter((r) => r.path === "/items");
  const first = apiCalls[0];
  const last = apiCalls.at(-1);

  return [
    {
      name: 'credentialsIn: "basic" sends the credentials as an Authorization: Basic header',
      ok:
        exchanges[0]?.auth?.startsWith("Basic ") === true &&
        !exchanges[0].body.includes("client_secret"),
      output:
        `Basic scheme: ${exchanges[0]?.auth?.startsWith("Basic ") === true}; ` +
        `secret kept out of the body: ${exchanges[0]?.body.includes("client_secret") === false}`,
    },
    {
      name: "an expired token is re-exchanged rather than reused",
      ok: exchanges.length > 1,
      output: `${exchanges.length} exchange(s) for ${apiCalls.length} API call(s)`,
    },
    {
      name: "the API call after re-exchange carries the NEW token",
      ok: last?.auth !== undefined && last.auth !== first?.auth,
      output:
        `last call carries Authorization: ${last?.auth !== undefined}; ` +
        `first and last Authorization differ: ${last?.auth !== first?.auth}`,
    },
  ];
}

/* ------------------------------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------------------------------ */

/**
 * Every scenario, in the order the harness runs them.
 *
 * Sequential, one server at a time against the one fake API: "two tool calls, one exchange" is a
 * statement about one server's cache across one conversation, so the calls inside a scenario
 * must not be split across processes. Across scenarios the order no longer matters to any judge,
 * since each reads its own slice of the log; it is kept so the report reads the same every run.
 */
export const RUNTIME_SCENARIOS: readonly RuntimeScenario[] = [
  {
    name: "rtbearer",
    spec: bearerSpec,
    env: { RTBEARER_TOKEN: "tok-123" },
    calls: BEARER_CALLS,
    judge: bearerChecks,
  },
  {
    name: "rtcc",
    spec: ccSpec,
    env: { RTCC_CLIENT_ID: "id-1", RTCC_CLIENT_SECRET: "secret-1" },
    calls: CC_CALLS,
    judge: clientCredentialsChecks,
  },
  {
    name: "rtrest",
    spec: restKitSpec,
    env: { RTREST_TOKEN: "rest-tok" },
    calls: [
      { name: "rr_list", args: {} },
      { name: "rr_create", args: { title: "made", draft: true } },
      { name: "rr_patch", args: { id: "p1", title: "renamed" } },
    ],
    judge: restKitChecks,
  },
  {
    name: "rtquery",
    spec: querySpec,
    env: { RTQUERY_TOKEN: "tok-q" },
    calls: [{ name: "rtq_list", args: { after: "abc" } }],
    judge: queryChecks,
  },
  {
    name: "rthdr",
    spec: headersSpec,
    env: { RTHDR_KEY: "key-9" },
    calls: [{ name: "hdr_list", args: {} }],
    judge: headerAuthChecks,
  },
  {
    name: "rtshort",
    spec: shortTokenSpec,
    env: { RTCC_CLIENT_ID: "id-2", RTCC_CLIENT_SECRET: "secret-2" },
    calls: [
      { name: "cc_list", args: {} },
      { name: "cc_list", args: {} },
      { name: "cc_list", args: {} },
    ],
    // Longer than the 1s the emitted code treats a 2s token as valid for, so at least one
    // gap straddles an expiry. Short enough to keep the harness quick.
    gapMs: 1400,
    judge: tokenExpiryChecks,
  },
];

/**
 * The report lines, and — when the run did not pass — the message the harness exits with.
 *
 * Every check prints its output, passes included — unlike formatCheckLines, which shows output only
 * for a failure. Here the output IS the evidence (the request line, the redacted header verdict),
 * and a reader checking a green run wants to see what was observed, not take the label on trust.
 *
 * An empty check list does not pass. "0/0 runtime checks passed" is the vacuous success every
 * selector in this repo refuses (selectFixtures, selectConnectors); a run that judged nothing must
 * not exit as though it judged everything.
 */
export function runtimeReport(checks: readonly Check[]): {
  lines: string[];
  failure: string | undefined;
} {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`, `        ${c.output}`);
  }
  if (checks.length === 0) {
    return {
      lines,
      failure: "No runtime checks ran. Refusing to report a pass with nothing checked.",
    };
  }
  const failed = checks.filter((c) => !c.ok).length;
  lines.push("", `${checks.length - failed}/${checks.length} runtime checks passed.`);
  return { lines, failure: failed === 0 ? undefined : `${failed} runtime check(s) failed.` };
}
