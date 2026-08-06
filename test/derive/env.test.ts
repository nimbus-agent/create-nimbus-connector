import { beforeAll, describe, expect, it } from "bun:test";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { recognizeEnv } from "../../src/derive/server/env.ts";

beforeAll(async () => {
  await initParser();
});

const REQUIRED = [
  "function apiKey(): string {",
  '  const k = process.env["NEW_RELIC_API_KEY"]?.trim();',
  '  if (k === undefined || k === "") {',
  '    throw new Error("NEW_RELIC_API_KEY is not set");',
  "  }",
  "  return k;",
  "}",
].join("\n");

const OPTIONAL = [
  "function region(): string {",
  '  const r = process.env["REGION"]?.trim();',
  "  return r;",
  "}",
].join("\n");

function run(source: string) {
  const statements = parseModule(source);
  const claims = createClaimSet();
  const entries = recognizeEnv(statements, claims);
  return { entries, unclaimed: claims.unclaimed(statements) };
}

// Every source the recognizer must refuse, each with the reason it exists. One row per case:
// the assertions are identical in all of them — no entry recovered, and the function left
// unclaimed for the totality rule to fail on — so only the source and its rationale differ.
const REFUSED_SOURCES = [
  [
    "does not claim a multi-var accessor without auth, which no spec field can produce",
    [
      "function creds(): string {",
      '  const a = process.env["A"]?.trim();',
      '  const b = process.env["B"]?.trim();',
      "  return a + b;",
      "}",
    ].join("\n"),
  ],

  // --- Step A: the recognizer must reject rather than approximate a return it doesn't model.
  // These are the shapes the pre-fix recognizer over-claimed (it looked only at whether the
  // last statement was a ReturnStatement, never at what it returned).

  [
    "rejects a return that matches no modeled shape at all",
    [
      "function weird(): string {",
      '  const u = process.env["V"]?.trim();',
      '  return u + "!";',
      "}",
    ].join("\n"),
  ],
  // Distinct from the BinaryExpression case above: this is a CallExpression on the binding
  // itself (matchTransformExpr's MemberExpression branch), just not the one transform this
  // recognizer models. `.replace` with the wrong pattern would be the same kind of near miss;
  // a different method name entirely is the more obviously-real-world one.
  [
    'rejects a method call on the binding that is not .replace(/\\/$/, "") — a wrong callee, not a wrong expression shape',
    [
      "function weird(): string {",
      '  const b = process.env["V"]?.trim();',
      "  return b.toUpperCase();",
      "}",
    ].join("\n"),
  ],

  // --- Further rejection cases, exercising the "reject rather than guess" rule directly.

  [
    "rejects a guard whose message does not match the emitted form",
    [
      "function apiKey(): string {",
      '  const k = process.env["NEW_RELIC_API_KEY"]?.trim();',
      '  if (k === undefined || k === "") {',
      '    throw new Error("something else entirely");',
      "  }",
      "  return k;",
      "}",
    ].join("\n"),
  ],
  [
    "rejects an auth-shaped return with no guard and no default (not producible by the emitter)",
    [
      "function authHeaders(): Record<string, string> {",
      '  const tok = process.env["TOKEN"]?.trim();',
      '  return { Authorization: `Bearer ${tok}`, Accept: "application/json" };',
      "}",
    ].join("\n"),
  ],
  [
    "rejects a headers-auth return missing the trailing Accept property",
    [
      "function headers(): Record<string, string> {",
      '  const ak = process.env["DD_API_KEY"]?.trim();',
      '  if (ak === undefined || ak === "") {',
      '    throw new Error("DD_API_KEY is not set");',
      "  }",
      '  return { "DD-API-KEY": ak };',
      "}",
    ].join("\n"),
  ],
  [
    "rejects an auth return containing a spread rather than treating it as headers",
    [
      "function headers(): Record<string, string> {",
      '  const ak = process.env["DD_API_KEY"]?.trim();',
      '  if (ak === undefined || ak === "") {',
      '    throw new Error("DD_API_KEY is not set");',
      "  }",
      '  return { ...common, "DD-API-KEY": ak, Accept: "application/json" };',
      "}",
    ].join("\n"),
  ],
  [
    "rejects reads with an inconsistent default across vars",
    [
      "function headers(): Record<string, string> {",
      '  const ak = process.env["DD_API_KEY"]?.trim() || "x";',
      '  const app = process.env["DD_APP_KEY"]?.trim();',
      '  return { "DD-API-KEY": ak, "DD-APPLICATION-KEY": app, Accept: "application/json" };',
      "}",
    ].join("\n"),
  ],
  [
    "rejects a default co-occurring with a guard, which the emitter never produces",
    [
      "function siteHost(): string {",
      '  const s = process.env["DD_SITE"]?.trim() || "datadoghq.com";',
      '  if (s === undefined || s === "") {',
      '    throw new Error("DD_SITE is not set");',
      "  }",
      "  return s;",
      "}",
    ].join("\n"),
  ],

  // --- Computed-member sweep: same hazard as server/index.ts's isConnect, elsewhere in this
  // file's read chain. A computed member has an Identifier `property` too — the KEY variable's
  // name, not a property name — so each of these must be rejected rather than read as the
  // literal `.trim`/`.env`/`.replace` access.

  [
    "rejects a computed x[trim]() instead of establishing x.trim()",
    [
      "function region(): string {",
      '  const r = process.env["REGION"]?.[trim]();',
      "  return r;",
      "}",
    ].join("\n"),
  ],
  [
    'rejects a computed process[env]["VAR"] instead of establishing process.env',
    [
      "function region(): string {",
      '  const r = process[env]["REGION"]?.trim();',
      "  return r;",
      "}",
    ].join("\n"),
  ],
  [
    "rejects a computed u[replace](...) instead of establishing u.replace(...)",
    [
      "function baseUrl(): string {",
      '  const u = process.env["GRAFANA_URL"]?.trim();',
      '  if (u === undefined || u === "") {',
      '    throw new Error("GRAFANA_URL is not set");',
      "  }",
      '  return u[replace](/\\/$/, "");',
      "}",
    ].join("\n"),
  ],
];

describe("recognizeEnv", () => {
  it("recovers the var, the local, the binding name and required from the guard", () => {
    const { entries, unclaimed } = run(REQUIRED);
    expect(entries).toEqual([
      { vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("reads an accessor with no guard as required: false", () => {
    expect(run(OPTIONAL).entries[0]).toEqual({
      vars: ["REGION"],
      local: "region",
      bindings: ["r"],
      required: false,
    });
  });

  it("leaves an unrelated function unclaimed rather than guessing", () => {
    const { entries, unclaimed } = run("function tagNames(row) { return []; }");
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  // --- Step B: model every real emitted shape.

  it("recovers transform: stripTrailingSlash with no prefix/suffix", () => {
    const source = [
      "function baseUrl(): string {",
      '  const u = process.env["GRAFANA_URL"]?.trim();',
      '  if (u === undefined || u === "") {',
      '    throw new Error("GRAFANA_URL is not set");',
      "  }",
      '  return u.replace(/\\/$/, "");',
      "}",
    ].join("\n");
    expect(run(source).entries).toEqual([
      {
        vars: ["GRAFANA_URL"],
        local: "baseUrl",
        bindings: ["u"],
        required: true,
        transform: "stripTrailingSlash",
      },
    ]);
  });

  it("recovers transform: trimTrailingSlashFn", () => {
    const source = [
      "function baseUrl(): string {",
      '  const u = process.env["AIRFLOW_URL"]?.trim();',
      "  return trimTrailingSlash(u);",
      "}",
    ].join("\n");
    expect(run(source).entries).toEqual([
      {
        vars: ["AIRFLOW_URL"],
        local: "baseUrl",
        bindings: ["u"],
        required: false,
        transform: "trimTrailingSlashFn",
      },
    ]);
  });

  it("recovers default and prefix together (datadog siteHost)", () => {
    const source = [
      "function siteHost(): string {",
      '  const s = process.env["DD_SITE"]?.trim() || "datadoghq.com";',
      "  return `api.${s}`;",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([
      {
        vars: ["DD_SITE"],
        local: "siteHost",
        bindings: ["s"],
        required: false,
        default: "datadoghq.com",
        prefix: "api.",
        suffix: "",
      },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("recovers default, transform and suffix together (sentry apiRoot)", () => {
    const source = [
      "function apiRoot(): string {",
      '  const u = process.env["SENTRY_URL"]?.trim() || "https://sentry.io";',
      '  return `${u.replace(/\\/$/, "")}/api/0`;',
      "}",
    ].join("\n");
    expect(run(source).entries).toEqual([
      {
        vars: ["SENTRY_URL"],
        local: "apiRoot",
        bindings: ["u"],
        required: false,
        default: "https://sentry.io",
        transform: "stripTrailingSlash",
        prefix: "",
        suffix: "/api/0",
      },
    ]);
  });

  it("recovers auth: bearer (grafana authHeaders)", () => {
    const source = [
      "function authHeaders(): Record<string, string> {",
      '  const tok = process.env["GRAFANA_API_TOKEN"]?.trim();',
      '  if (tok === undefined || tok === "") {',
      '    throw new Error("GRAFANA_API_TOKEN is not set");',
      "  }",
      '  return { Authorization: `Bearer ${tok}`, Accept: "application/json" };',
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([
      {
        vars: ["GRAFANA_API_TOKEN"],
        local: "authHeaders",
        bindings: ["tok"],
        required: false,
        auth: "bearer",
      },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("recovers auth: headers with headerNames (datadog headers)", () => {
    const source = [
      "function headers(): Record<string, string> {",
      '  const ak = process.env["DD_API_KEY"]?.trim();',
      '  const app = process.env["DD_APP_KEY"]?.trim();',
      '  if (ak === undefined || ak === "" || app === undefined || app === "") {',
      '    throw new Error("DD_API_KEY and DD_APP_KEY must be set");',
      "  }",
      "  return {",
      '    "DD-API-KEY": ak,',
      '    "DD-APPLICATION-KEY": app,',
      '    Accept: "application/json",',
      "  };",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([
      {
        vars: ["DD_API_KEY", "DD_APP_KEY"],
        local: "headers",
        bindings: ["ak", "app"],
        required: false,
        auth: "headers",
        headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"],
      },
    ]);
    expect(unclaimed).toEqual([]);
  });

  // Every REFUSED_SOURCES row: no entry recovered, and the statement left unclaimed. See that
  // table for each case's own rationale.
  it.each(REFUSED_SOURCES)("%s", (_name, source) => {
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });
});

// --- Task 4: the split-bearer pair, exact bytes from mercury's own emitted output.
const SPLIT_BEARER_READER = [
  "function apiToken(): string {",
  '  const t = process.env["MERCURY_TOKEN"]?.trim();',
  '  if (t === undefined || t === "") {',
  '    throw new Error("MERCURY_TOKEN is not set");',
  "  }",
  "  return t;",
  "}",
].join("\n");

const SPLIT_BEARER_WRAPPER = [
  "function authHeader(): Record<string, string> {",
  '  return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };',
  "}",
].join("\n");

describe("recognizeEnv: split-bearer pair (tokenLocal)", () => {
  it("recovers exactly ONE entry carrying tokenLocal from the reader+wrapper pair", () => {
    // The regression this guards: a recognizer that claims the pair as one entry but ALSO lets
    // the plain-accessor branch independently claim the reader would still pass a totality
    // check (both statements end up covered, just by two different claims) while leaving a
    // spurious second entry sitting beside the correct one — `entries).toHaveLength(1)` is the
    // assertion `unclaimed).toEqual([])` alone cannot make.
    const source = [SPLIT_BEARER_READER, "", SPLIT_BEARER_WRAPPER].join("\n\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toHaveLength(1);
    expect(entries).toEqual([
      {
        vars: ["MERCURY_TOKEN"],
        local: "authHeader",
        tokenLocal: "apiToken",
        bindings: ["t"],
        required: false,
        auth: "bearer",
      },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("falls back to a plain required entry when no wrapper follows the reader", () => {
    // matchSplitBearerReader's shape is byte-identical to a plain "required" accessor — see its
    // own docstring. With no matching wrapper immediately after it, the reader is legitimately
    // just that: recognizeEnv must still claim it via the plain-accessor branch, not leave it
    // unclaimed only because it once WAS a candidate for a pair.
    const source = [SPLIT_BEARER_READER, "", "function unrelated(row) { return []; }"].join("\n\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([
      { vars: ["MERCURY_TOKEN"], local: "apiToken", bindings: ["t"], required: true },
    ]);
    expect(unclaimed).toHaveLength(1);
  });

  it("does not form a pair when the wrapper calls a different function than the reader", () => {
    const wrongCallee = [
      "function authHeader(): Record<string, string> {",
      '  return { Authorization: `Bearer ${otherToken()}`, Accept: "application/json" };',
      "}",
    ].join("\n");
    const source = [SPLIT_BEARER_READER, "", wrongCallee].join("\n\n");
    const { entries, unclaimed } = run(source);
    // The reader still stands alone as a plain required entry; the wrapper matches nothing.
    expect(entries).toEqual([
      { vars: ["MERCURY_TOKEN"], local: "apiToken", bindings: ["t"], required: true },
    ]);
    expect(unclaimed).toHaveLength(1);
  });

  it("does not form a pair when the reader carries no guard (criterion 5: always required)", () => {
    const unguardedReader = [
      "function apiToken(): string {",
      '  const t = process.env["MERCURY_TOKEN"]?.trim();',
      "  return t;",
      "}",
    ].join("\n");
    const source = [unguardedReader, "", SPLIT_BEARER_WRAPPER].join("\n\n");
    const { entries, unclaimed } = run(source);
    // The reader is recognized as a plain optional accessor; the wrapper still matches nothing.
    expect(entries).toEqual([
      { vars: ["MERCURY_TOKEN"], local: "apiToken", bindings: ["t"], required: false },
    ]);
    expect(unclaimed).toHaveLength(1);
  });

  it("does not form a pair when the wrapper carries a THIRD header (intercom, named OUT by renderSplitBearer's own docstring)", () => {
    // Criterion 3 of renderSplitBearer's docstring: "with exactly two keys, Authorization then
    // Accept — a third header cannot be emitted (intercom adds "Intercom-Version": "2.11": OUT)".
    // This is the one exclusion the brief names by name that had no pinning test before this
    // fix round — the emitter itself can never produce this shape (renderSplitBearer's own
    // template writes exactly two properties), so this is hand-written, the same way
    // REFUSED_SOURCES hand-writes every other shape the emitter cannot produce.
    //
    // Authorization and Accept deliberately stay FIRST and SECOND, with the extra header
    // LAST: matchSplitBearerWrapper destructures only the first two properties, so an extra
    // property placed BEFORE Accept would incidentally also fail the (unrelated) "acceptProp.key
    // must be Accept" check — masking whether the `properties?.length !== 2` guard itself is
    // what is doing the work. Placing it last isolates that guard, so this test genuinely goes
    // red if THAT check alone regresses (see the fix report for the loosen/RED/restore proof).
    const threeHeaderWrapper = [
      "function authHeader(): Record<string, string> {",
      "  return {",
      "    Authorization: `Bearer ${apiToken()}`,",
      '    Accept: "application/json",',
      '    "Intercom-Version": "2.11",',
      "  };",
      "}",
    ].join("\n");
    const source = [SPLIT_BEARER_READER, "", threeHeaderWrapper].join("\n\n");
    const { entries, unclaimed } = run(source);
    // No tokenLocal entry forms. The reader still stands alone as a plain required entry (the
    // same fallback the other "no pair" cases above exercise); the three-header wrapper matches
    // nothing at all and stays unclaimed.
    expect(entries).toEqual([
      { vars: ["MERCURY_TOKEN"], local: "apiToken", bindings: ["t"], required: true },
    ]);
    expect(unclaimed).toHaveLength(1);
  });
});

describe("recognizeEnv: auth: basic", () => {
  it("recovers auth: basic with a decorated username (zendesk authHeader)", () => {
    const source = [
      "function authHeader(): Record<string, string> {",
      '  const email = process.env["ZENDESK_EMAIL"]?.trim();',
      '  if (email === undefined || email === "") {',
      '    throw new Error("ZENDESK_EMAIL is not set");',
      "  }",
      '  const token = process.env["ZENDESK_API_TOKEN"]?.trim();',
      '  if (token === undefined || token === "") {',
      '    throw new Error("ZENDESK_API_TOKEN is not set");',
      "  }",
      "  return {",
      "    Authorization: encodeBasicAuthHeader(`${email}/token`, token),",
      '    Accept: "application/json",',
      "  };",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([
      {
        vars: ["ZENDESK_EMAIL", "ZENDESK_API_TOKEN"],
        local: "authHeader",
        bindings: ["email", "token"],
        required: false,
        auth: "basic",
        prefix: "",
        suffix: "/token",
      },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("recovers auth: basic with a bare username (airflow shape, no prefix/suffix)", () => {
    const source = [
      "function authHeader(): Record<string, string> {",
      '  const user = process.env["AIRFLOW_USER"]?.trim();',
      '  if (user === undefined || user === "") {',
      '    throw new Error("AIRFLOW_USER is not set");',
      "  }",
      '  const pass = process.env["AIRFLOW_PASSWORD"]?.trim();',
      '  if (pass === undefined || pass === "") {',
      '    throw new Error("AIRFLOW_PASSWORD is not set");',
      "  }",
      "  return {",
      "    Authorization: encodeBasicAuthHeader(user, pass),",
      '    Accept: "application/json",',
      "  };",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([
      {
        vars: ["AIRFLOW_USER", "AIRFLOW_PASSWORD"],
        local: "authHeader",
        bindings: ["user", "pass"],
        required: false,
        auth: "basic",
      },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("rejects a combined (auth: headers style) guard rather than treating it as basic", () => {
    // renderBasic's own docstring: "Deliberately NOT the combined `a === "" || b === ""` guard
    // guardLines builds for auth: 'headers'". A connector writing that combined guard AROUND an
    // encodeBasicAuthHeader() call is not a shape either recognizer models.
    const source = [
      "function authHeader(): Record<string, string> {",
      '  const email = process.env["ZENDESK_EMAIL"]?.trim();',
      '  const token = process.env["ZENDESK_API_TOKEN"]?.trim();',
      '  if (email === undefined || email === "" || token === undefined || token === "") {',
      '    throw new Error("ZENDESK_EMAIL and ZENDESK_API_TOKEN must be set");',
      "  }",
      "  return {",
      "    Authorization: encodeBasicAuthHeader(email, token),",
      '    Accept: "application/json",',
      "  };",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("rejects a callee other than encodeBasicAuthHeader", () => {
    const source = [
      "function authHeader(): Record<string, string> {",
      '  const email = process.env["X_EMAIL"]?.trim();',
      '  if (email === undefined || email === "") {',
      '    throw new Error("X_EMAIL is not set");',
      "  }",
      '  const token = process.env["X_TOKEN"]?.trim();',
      '  if (token === undefined || token === "") {',
      '    throw new Error("X_TOKEN is not set");',
      "  }",
      "  return {",
      "    Authorization: someOtherHelper(email, token),",
      '    Accept: "application/json",',
      "  };",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("does not recover auth: basic from a ONE-var accessor (lever, excluded by renderBasic's two-var requirement)", () => {
    // lever is out of scope, but NOT via renderSplitBearer's docstring — that docstring's
    // membership list is scoped to the split-bearer (tokenLocal) shape alone and names
    // mendeley, intercom, readwise, dagster and pipedrive; "lever" has never appeared in
    // src/emit/server/env.ts at all (confirmed: `git log -S"lever" -- src/emit/server/env.ts`
    // returns no commit). It is excluded by a different mechanism entirely: renderBasic requires
    // exactly two vars — a username and a password — enforced by EnvSchema's own refine
    // ('auth: "basic" requires exactly two "vars"', src/spec.ts) and mirrored by
    // recognizeBasicAuth's own `reads.length !== 2` check below. Lever's real source reads ONE
    // var and passes a literal empty string as the second encodeBasicAuthHeader argument — a
    // shape the emitter can never produce (renderBasic always reads and guards every var in
    // e.vars, never fewer than two), so it is hand-written here the same way REFUSED_SOURCES
    // hand-writes every other shape the emitter cannot produce.
    const source = [
      "function authHeader(): Record<string, string> {",
      '  const key = process.env["LEVER_API_KEY"]?.trim();',
      '  if (key === undefined || key === "") {',
      '    throw new Error("LEVER_API_KEY is not set");',
      "  }",
      "  return {",
      '    Authorization: encodeBasicAuthHeader(key, ""),',
      '    Accept: "application/json",',
      "  };",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });
});

describe("recognizeEnv: the shared trimTrailingSlash helper", () => {
  const HELPER = [
    "function trimTrailingSlash(s: string): string {",
    '  return s.endsWith("/") ? s.slice(0, -1) : s;',
    "}",
  ].join("\n");

  const CALLS_HELPER = [
    "function baseUrl(): string {",
    '  const v = process.env["ZENDESK_URL"]?.trim();',
    '  if (v === undefined || v === "") {',
    '    throw new Error("ZENDESK_URL is not set");',
    "  }",
    "  return trimTrailingSlash(v);",
    "}",
  ].join("\n");

  it("claims the helper when an entry actually calls it (zendesk baseUrl)", () => {
    const source = [HELPER, "", CALLS_HELPER].join("\n\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([
      {
        vars: ["ZENDESK_URL"],
        local: "baseUrl",
        bindings: ["v"],
        required: true,
        transform: "trimTrailingSlashFn",
      },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("leaves the helper unclaimed when no entry calls it", () => {
    const source = [HELPER, "", OPTIONAL].join("\n\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toHaveLength(1);
    // Only the helper itself is left over — nothing claims a trimTrailingSlash declaration that
    // no recovered entry's transform justifies, regardless of whether the function EXISTS.
    expect(unclaimed).toHaveLength(1);
  });

  it("leaves a same-named helper with a different body unclaimed, matching bytes not names", () => {
    // The gate gets fed a real trimTrailingSlashFn transform (from CALLS_HELPER, which matches
    // on the callee's NAME the same way matchTransformExpr always has — that part is unchanged
    // by this task). What must NOT happen is claiming the module's actual `trimTrailingSlash`
    // statement when its own body is the OTHER inlined form (`.replace(/\/$/, "")`) rather than
    // src/emit/server/env.ts's `TRIM_TRAILING_SLASH_FN` text.
    const wrongBodyHelper = [
      "function trimTrailingSlash(s: string): string {",
      '  return s.replace(/\\/$/, "");',
      "}",
    ].join("\n");
    const source = [wrongBodyHelper, "", CALLS_HELPER].join("\n\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([
      {
        vars: ["ZENDESK_URL"],
        local: "baseUrl",
        bindings: ["v"],
        required: true,
        transform: "trimTrailingSlashFn",
      },
    ]);
    expect(unclaimed).toHaveLength(1);
  });
});
