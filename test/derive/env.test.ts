import { beforeAll, describe, expect, it } from "bun:test";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { type EnvEntry, recognizeEnv } from "../../src/derive/server/env.ts";
import { renderEnvAccessor } from "../../src/emit/server/env.ts";
import { EnvSchema } from "../../src/spec.ts";

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
  const { entries, tokenServiceLabels } = recognizeEnv(statements, claims);
  return { entries, tokenServiceLabels, unclaimed: claims.unclaimed(statements) };
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

/**
 * The-honest-histogram's task 1, Finding B: matchSplitBearerReader, matchSplitBearerWrapper,
 * recognizeBasicAuth and recognizeOne previously read a function's body and its name but never
 * its return-type annotation or its async-ness, so a function whose TEXT the emitter cannot write
 * still read as a match — `async function headers(): Promise<number>` read exactly like
 * `function headers(): Record<string, string>`. Each `.replace()` below is preceded by an
 * `expect(...).not.toBe(...)` guard — the same discipline test/derive/search-filter.test.ts's
 * corruption tests use — so a no-op replace (because the emitter stopped writing that text)
 * cannot silently stop testing anything.
 */
describe("recognizeEnv: return-type and async pinning (Finding B)", () => {
  it("refuses a split-bearer reader annotated something other than `: string` — renderSplitBearer always writes `(): string`", () => {
    const corruptedReader = SPLIT_BEARER_READER.replace(
      "function apiToken(): string {",
      "function apiToken(): unknown {",
    );
    expect(corruptedReader).not.toBe(SPLIT_BEARER_READER);
    const source = [corruptedReader, "", SPLIT_BEARER_WRAPPER].join("\n\n");
    const { entries, unclaimed } = run(source);
    // Neither statement is claimed: the reader fails both matchSplitBearerReader's new
    // annotation check (inside the pairing loop) and recognizeOne's identical check (the plain-
    // accessor fallback), and the wrapper is never even offered to the pairing logic once the
    // reader itself is refused there.
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(2);
  });

  it("refuses an async split-bearer wrapper — renderSplitBearer never writes `async` on either half", () => {
    const corruptedWrapper = SPLIT_BEARER_WRAPPER.replace(
      "function authHeader(): Record<string, string> {",
      "async function authHeader(): Promise<Record<string, string>> {",
    );
    expect(corruptedWrapper).not.toBe(SPLIT_BEARER_WRAPPER);
    const source = [SPLIT_BEARER_READER, "", corruptedWrapper].join("\n\n");
    const { entries, unclaimed } = run(source);
    // No tokenLocal-carrying entry forms — matchSplitBearerWrapper refuses the async half, the
    // same "no pair" outcome the hand-written cases in "recognizeEnv: split-bearer pair
    // (tokenLocal)" above cover. The untouched reader is BYTE-IDENTICAL to a plain required
    // accessor (its own docstring), so it still falls back through the plain-accessor branch
    // exactly as "falls back to a plain required entry when no wrapper follows the reader"
    // (above) already establishes; the async wrapper itself now matches neither
    // recognizeBasicAuth nor recognizeOne (both refuse async before reading anything else) and
    // stays unclaimed.
    expect(entries).toEqual([
      { vars: ["MERCURY_TOKEN"], local: "apiToken", bindings: ["t"], required: true },
    ]);
    expect(unclaimed).toHaveLength(1);
  });

  it("refuses a basic accessor annotated something other than `: Record<string, string>` — renderBasic always writes that", () => {
    const pristine = [
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
    const corrupted = pristine.replace(
      "function authHeader(): Record<string, string> {",
      "function authHeader(): unknown {",
    );
    expect(corrupted).not.toBe(pristine);
    const { entries, unclaimed } = run(corrupted);
    // recognizeBasicAuth refuses on the annotation; recognizeOne never competes for this
    // read/guard/read/guard shape at all (its own docstring), so nothing else claims it either.
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("refuses a plain accessor whose annotation contradicts its auth shape — renderEnvAccessor writes `: string` for a bare read and `: Record<string, string>` for an auth one", () => {
    const pristine = [
      "function authHeaders(): Record<string, string> {",
      '  const tok = process.env["GRAFANA_API_TOKEN"]?.trim();',
      '  if (tok === undefined || tok === "") {',
      '    throw new Error("GRAFANA_API_TOKEN is not set");',
      "  }",
      '  return { Authorization: `Bearer ${tok}`, Accept: "application/json" };',
      "}",
    ].join("\n");
    const corrupted = pristine.replace(
      "function authHeaders(): Record<string, string> {",
      "function authHeaders(): string {",
    );
    expect(corrupted).not.toBe(pristine);
    const { entries, unclaimed } = run(corrupted);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });
});

/**
 * The PR-review finding on top of Finding B above, and the SEVENTH instance of this branch's
 * defining defect class: the four matchers Finding B pinned checked `typeAnnotationName(...) ===
 * "Record"`, and `typeAnnotationName` reports a type reference's HEAD NAME only (its own
 * docstring). `Record<string, number>` and `Record<unknown, unknown>` satisfied that check, while
 * `renderEnvAccessor`, `renderSplitBearer`, `renderBasic` and `renderClientCredentials`
 * (src/emit/server/env.ts) write exactly `Record<string, string>` and no other instantiation. Such
 * a module recovers IDENTICAL `EnvEntry` fields and re-emits `Record<string, string>` — different
 * bytes, an unchanged spec, and nothing that could see it: `diff:golden` compares emitted output
 * against the corpus, the round trip emits the annotation going in and coming out, and the
 * totality rule detects statements nobody claimed, not statements claimed wrongly.
 *
 * `hasWriteHelperSignature` (src/derive/server/fetch-helper.ts) already pinned `Promise`'s own
 * type argument for exactly this reason, through the `typeArguments` accessor added for it. One
 * module pinned; its sibling did not. `isStringRecord` is now the single guard both halves of that
 * asymmetry answer to.
 */
describe("recognizeEnv: Record's type arguments, not just its head name", () => {
  const BEARER_ACCESSOR = [
    "function authHeaders(): Record<string, string> {",
    '  const tok = process.env["GRAFANA_API_TOKEN"]?.trim();',
    '  if (tok === undefined || tok === "") {',
    '    throw new Error("GRAFANA_API_TOKEN is not set");',
    "  }",
    '  return { Authorization: `Bearer ${tok}`, Accept: "application/json" };',
    "}",
  ].join("\n");

  const BASIC_ACCESSOR = [
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

  /**
   * Three instantiations, each typechecking and each bytes no spec produces: a wrong VALUE type,
   * a wrong KEY type (which the head-name check missed on the left of the pair as readily as on
   * the right), and the bare reference with no arguments at all — the arity case, which
   * `typeArguments` reports as absent rather than as an empty list.
   */
  const WRONG_RECORDS: ReadonlyArray<readonly [string]> = [
    ["Record<string, number>"],
    ["Record<unknown, unknown>"],
    ["Record"],
  ];

  it.each(WRONG_RECORDS)(
    "refuses a plain auth accessor returning %s — renderEnvAccessor writes Record<string, string>",
    (wrong) => {
      const corrupted = BEARER_ACCESSOR.replace("Record<string, string>", wrong);
      expect(corrupted).not.toBe(BEARER_ACCESSOR);
      const { entries, unclaimed } = run(corrupted);
      expect(entries).toEqual([]);
      expect(unclaimed).toHaveLength(1);
    },
  );

  it.each(WRONG_RECORDS)(
    "refuses a basic accessor returning %s — renderBasic writes Record<string, string>",
    (wrong) => {
      const corrupted = BASIC_ACCESSOR.replace("Record<string, string>", wrong);
      expect(corrupted).not.toBe(BASIC_ACCESSOR);
      const { entries, unclaimed } = run(corrupted);
      expect(entries).toEqual([]);
      expect(unclaimed).toHaveLength(1);
    },
  );

  it.each(WRONG_RECORDS)(
    "refuses a split-bearer wrapper returning %s — renderSplitBearer writes Record<string, string>",
    (wrong) => {
      const corruptedWrapper = SPLIT_BEARER_WRAPPER.replace("Record<string, string>", wrong);
      expect(corruptedWrapper).not.toBe(SPLIT_BEARER_WRAPPER);
      const { entries, unclaimed } = run([SPLIT_BEARER_READER, "", corruptedWrapper].join("\n\n"));
      // The same outcome the async-wrapper row above establishes, and for the same reason: the
      // untouched READER is byte-identical to a plain required accessor, so it still derives
      // through the plain-accessor branch, while the wrapper — matching neither
      // matchSplitBearerWrapper nor recognizeOne — carries no tokenLocal and stays unclaimed.
      expect(entries).toEqual([
        { vars: ["MERCURY_TOKEN"], local: "apiToken", bindings: ["t"], required: true },
      ]);
      expect(unclaimed).toHaveLength(1);
    },
  );
});

/**
 * `auth: "client-credentials"` — the-honest-histogram's task 8, and the largest single construct
 * in this emitter: FOUR module-scope statements (`let cachedToken`, `let tokenExpiresAt`,
 * `async function token()`, `async function <local>()`) claimed as ONE entry, the way the
 * split-bearer PAIR already is.
 *
 * The source under test is `renderEnvAccessor`'s own output rather than text copied into this
 * file, so a change to `renderClientCredentials` that this recognizer does not follow fails here
 * instead of silently testing a shape the emitter stopped writing. Every corruption below is
 * guarded with `expect(corrupted).not.toBe(pristine)` for the same reason.
 *
 * Only SIX of the ~30 lines those two functions emit carry a spec field (the two reads, the
 * guard's own var names, the token URL, the `scope` line, the credential placement, and the
 * wrapper's name). Everything else is a constant, and a module differing in one of them derives a
 * spec that regenerates different bytes while the totality rule stays silent — the statement WAS
 * claimed. Hence a refusal case per constant.
 */
const CC_SPEC = {
  vars: ["ZZWRITE_CLIENT_ID", "ZZWRITE_CLIENT_SECRET"],
  local: "authHeaders",
  bindings: ["id", "secret"],
  auth: "client-credentials",
  tokenUrl: "https://api.zzwrite.test/oauth/token",
  scope: "items:readwrite",
  credentialsIn: "basic",
};

/** `renderEnvAccessor`'s own text for `CC_SPEC`, with fields replaced. */
function emitClientCredentials(overrides: Record<string, unknown> = {}): string {
  return renderEnvAccessor(EnvSchema.parse({ ...CC_SPEC, ...overrides }), "ZZ Write");
}

const CLIENT_CREDENTIALS = emitClientCredentials();

/**
 * The three comment lines `renderTokenFunction` writes above `const ttl`, verbatim — the ONLY
 * comment any emitter in src/emit/ puts into src/server.ts, and therefore the only one a claimed
 * module can contain. A claim is a byte range, so an unpinned comment is claimed with the
 * statements around it and vanishes on re-emission: `ok: true` for a module the spec provably
 * cannot regenerate, invisible to `diff:golden` and to the round trip alike (both emit it going in
 * and coming out).
 */
const TTL_COMMENT = [
  "  // Renew a little early so a token cannot expire mid-flight between this check and the",
  "  // request that uses it. The skew is halved for short-lived tokens, which would",
  "  // otherwise be treated as already expired and re-exchanged on every call.",
].join("\n");

/** What `CLIENT_CREDENTIALS` must derive back to — `CC_SPEC` plus the schema defaults. */
const CC_ENTRY = {
  vars: ["ZZWRITE_CLIENT_ID", "ZZWRITE_CLIENT_SECRET"],
  local: "authHeaders",
  bindings: ["id", "secret"],
  // `needsGuard` is true for any entry with `auth`, whatever `required` says, so the two values
  // regenerate identical bytes — the schema default is recorded, exactly as buildAuthEntry does.
  required: false,
  auth: "client-credentials",
  tokenUrl: "https://api.zzwrite.test/oauth/token",
  scope: "items:readwrite",
  credentialsIn: "basic",
} satisfies EnvEntry;

describe("recognizeEnv: auth: client-credentials", () => {
  it("recovers one entry from four statements, claiming all four (credentialsIn: basic)", () => {
    const { entries, unclaimed, tokenServiceLabels } = run(CLIENT_CREDENTIALS);
    expect(entries).toEqual([CC_ENTRY]);
    expect(unclaimed).toEqual([]);
    // The label is EVIDENCE, not a field of any entry: spec.serviceLabel is recovered from the
    // fetch helper, and deriveSpec holds the two against each other.
    expect(tokenServiceLabels).toEqual(["ZZ Write"]);
  });

  it("recovers credentialsIn: body from the two body.set lines and the header object that loses its Authorization entry", () => {
    const source = emitClientCredentials({ credentialsIn: "body" });
    expect(source).not.toBe(CLIENT_CREDENTIALS);
    expect(run(source).entries).toEqual([{ ...CC_ENTRY, credentialsIn: "body" as const }]);
  });

  it('omits scope when no body.set("scope", …) line exists', () => {
    const source = emitClientCredentials({ scope: undefined });
    expect(source).not.toBe(CLIENT_CREDENTIALS);
    const { scope, ...withoutScope } = CC_ENTRY;
    expect(scope).toBe("items:readwrite");
    expect(run(source).entries).toEqual([withoutScope]);
  });

  it("recovers the camel-cased default bindings when the spec declares none", () => {
    const source = emitClientCredentials({ bindings: undefined });
    expect(source).not.toBe(CLIENT_CREDENTIALS);
    expect(run(source).entries).toEqual([
      { ...CC_ENTRY, bindings: ["zzwriteClientId", "zzwriteClientSecret"] },
    ]);
  });

  it("recovers the defaulted read form, which suppresses the guard entirely", () => {
    // guardLines writes nothing once a `default` is present, whatever `required`/`auth` say —
    // so the group is one statement shorter, and the recognizer must not demand the guard.
    const source = emitClientCredentials({ default: "unset" });
    expect(source).not.toBe(CLIENT_CREDENTIALS);
    expect(run(source).entries).toEqual([{ ...CC_ENTRY, default: "unset" }]);
  });

  it("sorts the group by its FIRST statement's position, not the wrapper's", () => {
    // recognizeEnv re-sorts into declaration order by index, and that order is what
    // renderEnvAccessors regenerates the module's byte order from. A four-statement group keyed
    // on its wrapper (the LAST statement) would sort behind an accessor declared between the
    // `let cachedToken` line and it.
    const source = [OPTIONAL, "", CLIENT_CREDENTIALS, "", REQUIRED].join("\n\n");
    const { entries, unclaimed } = run(source);
    expect(entries.map((e) => e.local)).toEqual(["region", "authHeaders", "apiKey"]);
    expect(unclaimed).toEqual([]);
  });
});

/**
 * Each corruption changes ONE of the constants `renderTokenFunction`/`renderClientCredentials`
 * write, and each must leave all four statements unclaimed. The assertions are identical in every
 * row — no entry, nothing claimed — so only the source and its rationale differ.
 */
const REFUSED_CLIENT_CREDENTIALS: [string, string][] = [
  [
    "cachedToken initialized to something other than null — the cache check compares against null",
    CLIENT_CREDENTIALS.replace(
      "let cachedToken: string | null = null;",
      'let cachedToken: string | null = "";',
    ),
  ],
  [
    "cachedToken annotated something other than `string | null`, which typechecks and is bytes the emitter never writes",
    CLIENT_CREDENTIALS.replace(
      "let cachedToken: string | null = null;",
      "let cachedToken: null | string = null;",
    ),
  ],
  [
    "tokenExpiresAt initialized to something other than 0",
    CLIENT_CREDENTIALS.replace("let tokenExpiresAt = 0;", "let tokenExpiresAt = 1;"),
  ],
  [
    "tokenExpiresAt given an annotation — renderTokenFunction writes it bare, and `: number` re-emits differently",
    CLIENT_CREDENTIALS.replace("let tokenExpiresAt = 0;", "let tokenExpiresAt: number = 0;"),
  ],
  [
    "a skew constant other than 60 — the derived spec carries no field for it, so this re-emits 60",
    CLIENT_CREDENTIALS.replace("Math.min(60,", "Math.min(30,"),
  ],
  [
    "a halving divisor other than 2, the other half of the same arithmetic",
    CLIENT_CREDENTIALS.replace("parsed.expires_in / 2", "parsed.expires_in / 3"),
  ],
  [
    "a TTL unit other than 1000 — seconds is what expires_in is measured in",
    CLIENT_CREDENTIALS.replace("Date.now() + ttl * 1000", "Date.now() + ttl * 60000"),
  ],
  [
    'a body.set("scope", …) naming a non-literal — `scope` is JSON.stringify\'d into the emitted text',
    CLIENT_CREDENTIALS.replace(
      'body.set("scope", "items:readwrite");',
      "body.set(\"scope\", process.env['SCOPE']);",
    ),
  ],
  [
    'credentialsIn: "basic" with the client_id/client_secret body lines ALSO present — renderTokenFunction\'s if/else writes one or the other, never both',
    CLIENT_CREDENTIALS.replace(
      'body.set("scope", "items:readwrite");',
      [
        'body.set("scope", "items:readwrite");',
        '  body.set("client_id", id);',
        '  body.set("client_secret", secret);',
      ].join("\n"),
    ),
  ],
  [
    "neither credential placement — no Authorization header and no body lines, a shape no credentialsIn value produces",
    CLIENT_CREDENTIALS.replace("      Authorization: encodeBasicAuthHeader(id, secret),\n", ""),
  ],
  [
    "a token endpoint that is not a string literal — `tokenUrl` is JSON.stringify'd into the fetch call",
    CLIENT_CREDENTIALS.replace(
      'await fetch("https://api.zzwrite.test/oauth/token", {',
      "await fetch(tokenEndpoint(), {",
    ),
  ],
  [
    "a response-body slice other than 400 characters",
    CLIENT_CREDENTIALS.replace("text.slice(0, 400)", "text.slice(0, 200)"),
  ],
  [
    "two error messages naming DIFFERENT services — one serviceLabel writes both",
    CLIENT_CREDENTIALS.replace(
      '"ZZ Write token response missing access_token"',
      '"Other Service token response missing access_token"',
    ),
  ],
  [
    "a JSON.parse cast that does not declare expires_in — the ttl arithmetic below reads it",
    CLIENT_CREDENTIALS.replace(
      "as { access_token?: unknown; expires_in?: unknown }",
      "as { access_token?: unknown }",
    ),
  ],
  [
    "a cache check that treats an already-expired token as fresh (`<=` for `<`)",
    CLIENT_CREDENTIALS.replace("Date.now() < tokenExpiresAt", "Date.now() <= tokenExpiresAt"),
  ],
  [
    "an unbounded-TTL fallback other than Number.POSITIVE_INFINITY",
    CLIENT_CREDENTIALS.replace("Number.POSITIVE_INFINITY", "Number.MAX_SAFE_INTEGER"),
  ],
  [
    "an empty-token check that accepts the empty string",
    CLIENT_CREDENTIALS.replace(' || parsed.access_token === ""', ""),
  ],
  [
    "an extra statement inside the token function — the claim covers its whole byte range, so anything the walk does not account for rides along",
    CLIENT_CREDENTIALS.replace(
      "  return cachedToken;\n}",
      "  logIt(cachedToken);\n  return cachedToken;\n}",
    ),
  ],
  [
    "a wrapper whose Authorization value is not exactly `Bearer ${await token()}`",
    CLIENT_CREDENTIALS.replace(
      "Authorization: `Bearer ${await token()}`",
      "Authorization: `Token ${await token()}`",
    ),
  ],
  [
    "a wrapper that calls token() WITHOUT awaiting it — token() is async, and the un-awaited form re-emits with the await",
    CLIENT_CREDENTIALS.replace("${await token()}", "${token()}"),
  ],
  [
    "a wrapper calling a function other than token()",
    CLIENT_CREDENTIALS.replace("await token()", "await otherToken()"),
  ],
  [
    // The client-credentials half of the finding the "Record's type arguments" describe above
    // covers for the other three matchers. This one is nested a level deeper —
    // `renderClientCredentials` writes `Promise<Record<string, string>>` — so the outer
    // `Promise` argument was already pinned and only the inner instantiation was not.
    "a wrapper returning Promise<Record<string, number>> — renderClientCredentials writes Promise<Record<string, string>>",
    CLIENT_CREDENTIALS.replace(
      "Promise<Record<string, string>>",
      "Promise<Record<string, number>>",
    ),
  ],
  [
    "a wrapper returning a bare Promise<Record> — the arity case, which `typeArguments` reports as absent rather than empty",
    CLIENT_CREDENTIALS.replace("Promise<Record<string, string>>", "Promise<Record>"),
  ],

  // --- The emitted comment. renderTokenFunction is the only emitter that writes one into
  // src/server.ts, so nothing in this deriver looked for one until this construct existed.
  [
    "a STRIPPED comment above `const ttl` — the module re-emits with it, so `ok: true` here would be a spec that provably cannot regenerate the input",
    CLIENT_CREDENTIALS.replace(`${TTL_COMMENT}\n`, ""),
  ],
  [
    "an ALTERED comment above `const ttl` — presence alone (hasLeadingComment) would accept this and silently restore the original wording",
    CLIENT_CREDENTIALS.replace("Renew a little early", "Refresh a little early"),
  ],
  [
    "a comment block one line SHORTER than the emitted one — the length check, not just the per-line comparison",
    CLIENT_CREDENTIALS.replace(
      "  // otherwise be treated as already expired and re-exchanged on every call.\n",
      "",
    ),
  ],
  [
    "a comment above a statement the emitter writes none above — the claim covers the whole function, so this vanishes on re-emission exactly as a stripped one does",
    CLIENT_CREDENTIALS.replace(
      "  const text = await res.text();",
      "  // fetched above\n  const text = await res.text();",
    ),
  ],
  [
    "a comment inside the wrapper, which renderClientCredentials writes bare",
    CLIENT_CREDENTIALS.replace(
      "  return { Authorization:",
      "  // build the header\n  return { Authorization:",
    ),
  ],
  [
    "a comment above one of the two module-scope `let` bindings",
    CLIENT_CREDENTIALS.replace(
      "let tokenExpiresAt = 0;",
      "// epoch millis\nlet tokenExpiresAt = 0;",
    ),
  ],
];

describe("recognizeEnv: auth: client-credentials refusals", () => {
  for (const [reason, corrupted] of REFUSED_CLIENT_CREDENTIALS) {
    it(`refuses ${reason}`, () => {
      expect(corrupted).not.toBe(CLIENT_CREDENTIALS);
      const { entries, unclaimed, tokenServiceLabels } = run(corrupted);
      expect(entries).toEqual([]);
      expect(tokenServiceLabels).toEqual([]);
      // All four statements stay unclaimed — including the WRAPPER, which is what stops the
      // plain-accessor pass from picking it up as an env entry the module never declared. That
      // guard is recognizeOne's async/return-type pin (task 1); this is what stops a later
      // change from removing it silently.
      expect(unclaimed).toHaveLength(4);
    });
  }
});
