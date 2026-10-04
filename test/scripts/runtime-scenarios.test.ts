/**
 * Unit tests for runtime-acceptance's scenarios and the checks that judge them.
 *
 * Those checks are the harness's verdict on what a generated connector actually SENDS — the only
 * place in this repository that observes a request rather than inferring it from emitted text —
 * and until they moved to scripts/_lib/runtime-scenarios.ts none of them had ever been shown to
 * fail. A judge that passes on wrong traffic is the worst kind of false green this repo has: it
 * carries the authority of "observed on the wire". So every judge below is held against two kinds
 * of traffic, both written out by hand: what a correct connector records, where every check must
 * pass, and what a connector with one specific defect records, where exactly the check named for
 * that defect must fail — and the rest must not, or a single defect would read as several.
 *
 * Two of these tests were written against the judges as they first moved and FAILED: a connector
 * whose second call never reached the API passed "two tool calls, one exchange", and one that
 * dropped its Authorization header after re-exchanging passed "carries the NEW token". Both
 * judges were tightened to say what their names claim; the two tests are the record of why.
 *
 * The scenario table is checked against the spec language as well, because the harness only runs
 * in acceptance.yml: a renamed tool, a renamed argument or a mistyped credential variable would
 * otherwise surface as a red scheduled run rather than in the pull request that caused it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { Check } from "../../scripts/_lib/checks.ts";
import type { Recorded } from "../../scripts/_lib/fake-api.ts";
import {
  bearerChecks,
  clientCredentialsChecks,
  headerAuthChecks,
  queryChecks,
  RUNTIME_SCENARIOS,
  restKitChecks,
  runtimeReport,
  type ToolResult,
  tokenExpiryChecks,
} from "../../scripts/_lib/runtime-scenarios.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

beforeAll(async () => {
  await initFormatter();
});

/** The fake API's base, as the driver would hand it over. Never contacted here. */
const BASE = "http://127.0.0.1:59999";

/** One recorded request; every field not given is what the fake API records for its absence. */
function req(method: string, path: string, extra: Partial<Recorded> = {}): Recorded {
  return {
    method,
    path,
    auth: undefined,
    apiKey: undefined,
    contentType: undefined,
    body: "",
    ...extra,
  };
}

const okResult = (path: string): ToolResult => ({
  isError: false,
  text: JSON.stringify({ ok: true, path }),
});

/** The verdicts by check name, so a test can say which check moved and which did not. */
function verdicts(checks: readonly Check[]): Record<string, boolean> {
  return Object.fromEntries(checks.map((c) => [c.name, c.ok]));
}

/** The names of the checks that failed — the whole claim a defect test makes. */
function failing(checks: readonly Check[]): string[] {
  return checks.filter((c) => !c.ok).map((c) => c.name);
}

function output(checks: readonly Check[], name: string): string {
  const c = checks.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no check named "${name}"`);
  return c.output;
}

describe("the scenario table", () => {
  it("names each scenario once, so no two packages share a temp directory", () => {
    const names = RUNTIME_SCENARIOS.map((s) => s.name);
    expect(names).toEqual(["rtbearer", "rtcc", "rtrest", "rtquery", "rthdr", "rtshort"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names every scenario after the connector its spec declares", () => {
    for (const s of RUNTIME_SCENARIOS) {
      expect(parseSpec(s.spec(BASE)).name).toBe(s.name);
    }
  });

  it("generates a standalone package from every spec, so the harness fails on a request, not on generation", () => {
    for (const s of RUNTIME_SCENARIOS) {
      const files = formatAll(generate(parseSpec(s.spec(BASE)), { target: "standalone" }));
      const paths = files.map((f) => displayPath(f.path));
      expect(paths).toContain("src/server.ts");
      expect(paths).toContain("package.json");
    }
  });

  it("calls only tools the spec declares, with only arguments that tool declares", () => {
    for (const s of RUNTIME_SCENARIOS) {
      const tools = new Map(parseSpec(s.spec(BASE)).tools.map((t) => [t.name, t]));
      expect(s.calls.length).toBeGreaterThan(0);
      for (const call of s.calls) {
        const tool = tools.get(call.name);
        expect(tool, `${s.name} calls ${call.name}, which its spec does not declare`).toBeDefined();
        const declared = Object.keys(tool?.args ?? {});
        for (const arg of Object.keys(call.args)) {
          expect(declared, `${s.name}'s ${call.name} is called with ${arg}`).toContain(arg);
        }
      }
    }
  });

  it("supplies exactly the credential variables each spec reads — no typo, and nothing unread", () => {
    for (const s of RUNTIME_SCENARIOS) {
      const declared = parseSpec(s.spec(BASE))
        .env.flatMap((e) => e.vars)
        .sort();
      expect(Object.keys(s.env).sort(), s.name).toEqual(declared);
    }
  });

  it("points every request a spec can make at the fake API it is handed", () => {
    for (const s of RUNTIME_SCENARIOS) {
      const spec = parseSpec(s.spec(BASE));
      expect(spec.fetchHelper?.base.startsWith(BASE), s.name).toBe(true);
      for (const e of spec.env) {
        if (e.tokenUrl !== undefined) expect(e.tokenUrl.startsWith(BASE), s.name).toBe(true);
      }
    }
  });

  it("gives only the token-expiry scenario a gap, and one longer than the 1s a 2s token lives", () => {
    // fake-api.ts mints a 2-second token for `?short`, which the emitted code treats as valid for
    // half that. A gap at or under 1s could let every call land inside one token's life, and the
    // re-exchange this scenario exists to observe would never happen.
    const gapped = RUNTIME_SCENARIOS.filter((s) => s.gapMs !== undefined);
    expect(gapped.map((s) => s.name)).toEqual(["rtshort"]);
    expect(gapped[0]?.gapMs).toBeGreaterThan(1000);
  });

  it("wires each scenario to the judge written for it", () => {
    expect(RUNTIME_SCENARIOS.map((s) => s.judge)).toEqual([
      bearerChecks,
      clientCredentialsChecks,
      restKitChecks,
      queryChecks,
      headerAuthChecks,
      tokenExpiryChecks,
    ]);
  });
});

describe("bearerChecks", () => {
  const AUTH = "Bearer tok-123";
  /** The request each override replaces fields of — named, so a mistyped key is a type error. */
  type Overrides = Partial<
    Record<"list" | "get" | "create" | "patch" | "remove", Partial<Recorded>>
  >;
  const traffic = (overrides: Overrides = {}): Recorded[] => [
    req("GET", "/items?flag=false", { auth: AUTH, ...overrides.list }),
    req("GET", "/items/a%20b%2Fc", { auth: AUTH, ...overrides.get }),
    req("POST", "/items", {
      auth: AUTH,
      contentType: "application/json",
      body: '{"title":"hello","draft":true,"size":20}',
      ...overrides.create,
    }),
    req("PATCH", "/items/x1", {
      auth: AUTH,
      contentType: "application/json",
      body: '{"title":"renamed"}',
      ...overrides.patch,
    }),
    req("DELETE", "/items/x1", { auth: AUTH, ...overrides.remove }),
    req("GET", "/boom", { auth: AUTH }),
  ];
  const results = (
    boom: ToolResult = { isError: true, text: "RtBearer 500: upstream exploded" },
  ) => [
    okResult("/items"),
    okResult("/items/a b/c"),
    okResult("/items"),
    okResult("/items/x1"),
    okResult("/items/x1"),
    boom,
  ];

  it("passes every check, in a fixed order, on a correct connector's traffic", () => {
    const checks = bearerChecks(traffic(), results());
    expect(checks.map((c) => c.name)).toEqual([
      "bearer token reaches the wire as an Authorization header",
      "unset optional boolean renders false in the URL",
      'a boolean in a JSON body is a real boolean, not the string "true"',
      "a defaulted arg is sent with its default applied",
      "a write sends Content-Type: application/json",
      "path args are percent-encoded at runtime",
      "a path arg is excluded from the default write body (D5)",
      "a DELETE whose only arg is in the path sends no body",
      "a non-2xx response surfaces as a tool error naming the status",
    ]);
    expect(failing(checks)).toEqual([]);
    expect(output(checks, "unset optional boolean renders false in the URL")).toBe(
      "GET /items?flag=false",
    );
    expect(output(checks, "a DELETE whose only arg is in the path sends no body")).toBe(
      'DELETE /items/x1 body: ""',
    );
  });

  it('fails the boolean check, and only it, when draft arrives as the string "true"', () => {
    const checks = bearerChecks(
      traffic({ create: { body: '{"title":"hello","draft":"true","size":20}' } }),
      results(),
    );
    expect(failing(checks)).toEqual([
      'a boolean in a JSON body is a real boolean, not the string "true"',
    ]);
  });

  it("fails the default check when the defaulted arg is left out of the body", () => {
    const checks = bearerChecks(
      traffic({ create: { body: '{"title":"hello","draft":true}' } }),
      results(),
    );
    expect(failing(checks)).toEqual(["a defaulted arg is sent with its default applied"]);
  });

  it("fails both body checks — rather than throwing — when the POST body is not JSON at all", () => {
    const checks = bearerChecks(traffic({ create: { body: "title=hello&draft=true" } }), results());
    expect(failing(checks)).toEqual([
      'a boolean in a JSON body is a real boolean, not the string "true"',
      "a defaulted arg is sent with its default applied",
    ]);
    expect(output(checks, "a defaulted arg is sent with its default applied")).toBe(
      "POST body: title=hello&draft=true",
    );
  });

  it("fails the URL check when the unset boolean is dropped from the query rather than sent as false", () => {
    const checks = bearerChecks(traffic({ list: { path: "/items?flag=" } }), results());
    expect(failing(checks)).toEqual(["unset optional boolean renders false in the URL"]);
  });

  it("fails the encoding check when a path arg reaches the wire unencoded", () => {
    const checks = bearerChecks(traffic({ get: { path: "/items/a b/c" } }), results());
    expect(failing(checks)).toEqual(["path args are percent-encoded at runtime"]);
  });

  it("fails the content-type check when a write is not sent as JSON", () => {
    const checks = bearerChecks(traffic({ create: { contentType: "text/plain" } }), results());
    expect(failing(checks)).toEqual(["a write sends Content-Type: application/json"]);
  });

  it("fails the D5 check when the path arg is repeated in the PATCH body", () => {
    const checks = bearerChecks(
      traffic({ patch: { body: '{"id":"x1","title":"renamed"}' } }),
      results(),
    );
    expect(failing(checks)).toEqual(["a path arg is excluded from the default write body (D5)"]);
  });

  it("fails the DELETE check when a body is sent anyway", () => {
    const checks = bearerChecks(traffic({ remove: { body: '{"id":"x1"}' } }), results());
    expect(failing(checks)).toEqual(["a DELETE whose only arg is in the path sends no body"]);
    expect(output(checks, "a DELETE whose only arg is in the path sends no body")).toBe(
      'DELETE /items/x1 body: "{\\"id\\":\\"x1\\"}"',
    );
  });

  it("fails the error check when a 500 comes back as a successful tool result", () => {
    const checks = bearerChecks(traffic(), results({ isError: false, text: "upstream exploded" }));
    expect(failing(checks)).toEqual([
      "a non-2xx response surfaces as a tool error naming the status",
    ]);
  });

  it("fails the error check when the tool error does not name the status", () => {
    const checks = bearerChecks(traffic(), results({ isError: true, text: "something broke" }));
    expect(failing(checks)).toEqual([
      "a non-2xx response surfaces as a tool error naming the status",
    ]);
  });

  it("reads the error result by the rt_boom call, so a missing result fails rather than borrowing another", () => {
    const checks = bearerChecks(traffic(), results().slice(0, 5));
    expect(failing(checks)).toEqual([
      "a non-2xx response surfaces as a tool error naming the status",
    ]);
    expect(output(checks, "a non-2xx response surfaces as a tool error naming the status")).toBe(
      "rt_boom → (no result)",
    );
  });

  it("fails every check on a connector that sent nothing, rather than passing any vacuously", () => {
    const checks = bearerChecks([], []);
    expect(failing(checks)).toHaveLength(checks.length);
    expect(output(checks, "path args are percent-encoded at runtime")).toBe("GET (no request)");
  });

  it("never prints the token, even when the wrong one arrives", () => {
    const checks = bearerChecks(traffic({ list: { auth: "Bearer leaked-secret-9f3" } }), results());
    expect(verdicts(checks)["bearer token reaches the wire as an Authorization header"]).toBe(
      false,
    );
    expect(output(checks, "bearer token reaches the wire as an Authorization header")).toBe(
      "Authorization: present, unexpected value",
    );
    for (const c of checks) expect(c.output).not.toContain("leaked-secret-9f3");
  });
});

describe("clientCredentialsChecks", () => {
  const exchange = (body = "grant_type=client_credentials&client_id=id-1&client_secret=secret-1") =>
    req("POST", "/oauth/token", { contentType: "application/x-www-form-urlencoded", body });
  const api = (auth = "Bearer exchanged-token-abc") => req("GET", "/items", { auth });

  it("passes every check on one exchange followed by two calls carrying its token", () => {
    const checks = clientCredentialsChecks([exchange(), api(), api()]);
    expect(checks.map((c) => c.name)).toEqual([
      "the token exchange happens before the API call",
      "credentialsIn: body puts the id and secret in the form body",
      "the exchanged token is used for the API call",
      "the token is cached — two tool calls, one exchange",
    ]);
    expect(failing(checks)).toEqual([]);
    expect(output(checks, "the token exchange happens before the API call")).toBe(
      "POST /oauth/token → GET /items → GET /items",
    );
    expect(output(checks, "the token is cached — two tool calls, one exchange")).toBe(
      "1 exchange(s) for 2 API call(s)",
    );
  });

  it("fails the caching check when the second call exchanges again", () => {
    const checks = clientCredentialsChecks([exchange(), api(), exchange(), api()]);
    expect(failing(checks)).toEqual(["the token is cached — two tool calls, one exchange"]);
    expect(output(checks, "the token is cached — two tool calls, one exchange")).toBe(
      "2 exchange(s) for 2 API call(s)",
    );
  });

  it("fails the caching check when the second call never reaches the API — one exchange is not a cache hit", () => {
    const checks = clientCredentialsChecks([exchange(), api()]);
    expect(failing(checks)).toEqual(["the token is cached — two tool calls, one exchange"]);
    expect(output(checks, "the token is cached — two tool calls, one exchange")).toBe(
      "1 exchange(s) for 1 API call(s)",
    );
  });

  it("fails the ordering check when the API is called before any token exists", () => {
    const checks = clientCredentialsChecks([req("GET", "/items"), exchange(), api()]);
    expect(failing(checks)).toContain("the token exchange happens before the API call");
  });

  it("fails the form-body check when the secret is not in the body", () => {
    const checks = clientCredentialsChecks([
      exchange("grant_type=client_credentials&client_id=id-1"),
      api(),
      api(),
    ]);
    expect(failing(checks)).toEqual([
      "credentialsIn: body puts the id and secret in the form body",
    ]);
    expect(output(checks, "credentialsIn: body puts the id and secret in the form body")).toBe(
      "token body: missing expected field(s)",
    );
  });

  it("fails the token check when the call carries something other than the exchanged token", () => {
    const checks = clientCredentialsChecks([exchange(), api("Bearer stale-token"), api()]);
    expect(failing(checks)).toEqual(["the exchanged token is used for the API call"]);
  });

  it("reports no requests at all as a failure of every check", () => {
    const checks = clientCredentialsChecks([]);
    expect(failing(checks)).toHaveLength(4);
    expect(output(checks, "the token exchange happens before the API call")).toBe("(no requests)");
  });

  it("never prints the client secret or the exchanged token", () => {
    const checks = clientCredentialsChecks([exchange(), api("Bearer wrong-token-77"), api()]);
    for (const c of checks) {
      expect(c.output).not.toContain("secret-1");
      expect(c.output).not.toContain("wrong-token-77");
      expect(c.output).not.toContain("exchanged-token-abc");
    }
  });
});

describe("restKitChecks", () => {
  const AUTH = "Bearer rest-tok";
  const json = (body: string) => ({ auth: AUTH, contentType: "application/json", body });

  it("passes every check on a correct rest-kit connector's traffic", () => {
    const checks = restKitChecks([
      req("GET", "/items", { auth: AUTH }),
      req("POST", "/items", json('{"title":"made","draft":true}')),
      req("PATCH", "/items/p1", json('{"title":"renamed"}')),
    ]);
    expect(checks.map((c) => c.name)).toEqual([
      "rest-kit sends the bearer token the registrar resolves itself",
      "rest-kit buildInit produces the declared method and a JSON body",
      "rest-kit applies the D5 path-arg exclusion too",
    ]);
    expect(failing(checks)).toEqual([]);
  });

  it("fails the D5 check when the path arg is repeated in the body", () => {
    const checks = restKitChecks([
      req("GET", "/items", { auth: AUTH }),
      req("POST", "/items", json('{"title":"made","draft":true}')),
      req("PATCH", "/items/p1", json('{"id":"p1","title":"renamed"}')),
    ]);
    expect(failing(checks)).toEqual(["rest-kit applies the D5 path-arg exclusion too"]);
  });

  it("fails the buildInit check when the boolean arrives as a string", () => {
    const checks = restKitChecks([
      req("GET", "/items", { auth: AUTH }),
      req("POST", "/items", json('{"title":"made","draft":"true"}')),
      req("PATCH", "/items/p1", json('{"title":"renamed"}')),
    ]);
    expect(failing(checks)).toEqual([
      "rest-kit buildInit produces the declared method and a JSON body",
    ]);
  });

  it("fails the token check when the registrar sends no Authorization", () => {
    const checks = restKitChecks([
      req("GET", "/items"),
      req("POST", "/items", json('{"title":"made","draft":true}')),
      req("PATCH", "/items/p1", json('{"title":"renamed"}')),
    ]);
    expect(failing(checks)).toEqual([
      "rest-kit sends the bearer token the registrar resolves itself",
    ]);
    expect(output(checks, "rest-kit sends the bearer token the registrar resolves itself")).toBe(
      "Authorization: absent",
    );
  });
});

describe("queryChecks", () => {
  it("passes both checks when the base's path component appears exactly once", () => {
    const checks = queryChecks([req("GET", "/v2/items?limit=10&after=abc")]);
    expect(failing(checks)).toEqual([]);
  });

  it("fails both checks on the doubled base this scenario exists to catch", () => {
    const checks = queryChecks([req("GET", "/v2/v2/items?limit=10&after=abc")]);
    expect(failing(checks)).toEqual([
      "a query tool's request path carries the base's path component exactly once",
      "the base's own path segment is not duplicated in the request",
    ]);
    expect(output(checks, "the base's own path segment is not duplicated in the request")).toBe(
      "GET /v2/v2/items?limit=10&after=abc",
    );
  });

  it("fails only the exact-path check when the base is right but a query parameter is lost", () => {
    const checks = queryChecks([req("GET", "/v2/items?limit=10")]);
    expect(failing(checks)).toEqual([
      "a query tool's request path carries the base's path component exactly once",
    ]);
  });

  it("fails both checks when the base's path component is dropped entirely", () => {
    const checks = queryChecks([req("GET", "/items?limit=10&after=abc")]);
    expect(failing(checks)).toHaveLength(2);
  });
});

describe("headerAuthChecks", () => {
  const NAME = 'auth: "headers" sends the named header, not Authorization';

  it("passes when only the named header carries the key", () => {
    const checks = headerAuthChecks([req("GET", "/items", { apiKey: "key-9" })]);
    expect(verdicts(checks)).toEqual({ [NAME]: true });
    expect(output(checks, NAME)).toBe("X-Api-Key: present, as expected / Authorization: absent");
  });

  it("fails when the key is ALSO sent as Authorization", () => {
    const checks = headerAuthChecks([
      req("GET", "/items", { apiKey: "key-9", auth: "Bearer key-9" }),
    ]);
    expect(verdicts(checks)).toEqual({ [NAME]: false });
  });

  it("fails when the named header is missing, without printing what arrived instead", () => {
    const checks = headerAuthChecks([req("GET", "/items", { apiKey: "key-LEAKED-4" })]);
    expect(verdicts(checks)).toEqual({ [NAME]: false });
    expect(output(checks, NAME)).not.toContain("key-LEAKED-4");
  });
});

describe("tokenExpiryChecks", () => {
  const BASIC = "Basic aWQtMjpzZWNyZXQtMg==";
  const exchange = (extra: Partial<Recorded> = {}) =>
    req("POST", "/oauth/token?short", {
      auth: BASIC,
      body: "grant_type=client_credentials",
      ...extra,
    });
  const api = (auth: string | undefined) => req("GET", "/items", { auth });

  it("passes every check when each expiry is followed by a fresh exchange and a new token", () => {
    const checks = tokenExpiryChecks([
      exchange(),
      api("Bearer short-1"),
      exchange(),
      api("Bearer short-3"),
      exchange(),
      api("Bearer short-5"),
    ]);
    expect(checks.map((c) => c.name)).toEqual([
      'credentialsIn: "basic" sends the credentials as an Authorization: Basic header',
      "an expired token is re-exchanged rather than reused",
      "the API call after re-exchange carries the NEW token",
    ]);
    expect(failing(checks)).toEqual([]);
    expect(output(checks, "an expired token is re-exchanged rather than reused")).toBe(
      "3 exchange(s) for 3 API call(s)",
    );
  });

  it("fails both expiry checks when one token is reused for every call", () => {
    const checks = tokenExpiryChecks([
      exchange(),
      api("Bearer short-1"),
      api("Bearer short-1"),
      api("Bearer short-1"),
    ]);
    expect(failing(checks)).toEqual([
      "an expired token is re-exchanged rather than reused",
      "the API call after re-exchange carries the NEW token",
    ]);
  });

  it("fails the new-token check when the call after re-exchange carries no token at all", () => {
    const checks = tokenExpiryChecks([
      exchange(),
      api("Bearer short-1"),
      exchange(),
      api(undefined),
    ]);
    expect(failing(checks)).toEqual(["the API call after re-exchange carries the NEW token"]);
    expect(output(checks, "the API call after re-exchange carries the NEW token")).toBe(
      "last call carries Authorization: false; first and last Authorization differ: true",
    );
  });

  it("fails the Basic check when the secret travels in the body instead", () => {
    const checks = tokenExpiryChecks([
      exchange({ auth: undefined, body: "grant_type=client_credentials&client_secret=secret-2" }),
      api("Bearer short-1"),
      exchange(),
      api("Bearer short-3"),
    ]);
    expect(failing(checks)).toEqual([
      'credentialsIn: "basic" sends the credentials as an Authorization: Basic header',
    ]);
    expect(
      output(
        checks,
        'credentialsIn: "basic" sends the credentials as an Authorization: Basic header',
      ),
    ).toBe("Basic scheme: false; secret kept out of the body: false");
  });

  it("never prints the Basic credential or a token", () => {
    const checks = tokenExpiryChecks([
      exchange(),
      api("Bearer short-1"),
      exchange(),
      api("Bearer short-3"),
    ]);
    for (const c of checks) {
      expect(c.output).not.toContain("aWQtMjpzZWNyZXQtMg");
      expect(c.output).not.toContain("short-");
    }
  });
});

describe("runtimeReport", () => {
  const pass: Check = { name: "a", ok: true, output: "GET /a" };
  const fail: Check = { name: "b", ok: false, output: "GET /b" };

  it("prints every check with its evidence, passes included, then the tally", () => {
    const { lines, failure } = runtimeReport([pass, pass]);
    expect(lines).toEqual([
      "PASS  a",
      "        GET /a",
      "PASS  a",
      "        GET /a",
      "",
      "2/2 runtime checks passed.",
    ]);
    expect(failure).toBeUndefined();
  });

  it("names how many failed, and still prints the passes beside them", () => {
    const { lines, failure } = runtimeReport([pass, fail]);
    expect(lines).toEqual([
      "PASS  a",
      "        GET /a",
      "FAIL  b",
      "        GET /b",
      "",
      "1/2 runtime checks passed.",
    ]);
    expect(failure).toBe("1 runtime check(s) failed.");
  });

  it("refuses to report a pass for a run that checked nothing", () => {
    const { lines, failure } = runtimeReport([]);
    expect(lines).toEqual([]);
    expect(failure).toBe("No runtime checks ran. Refusing to report a pass with nothing checked.");
    expect(failure).not.toContain("0/0");
  });
});
