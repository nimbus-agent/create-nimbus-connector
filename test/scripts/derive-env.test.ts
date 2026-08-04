import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeEnv } from "../../scripts/_lib/derive/server/env.ts";

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

  it("does not claim a multi-var accessor without auth, which no spec field can produce", () => {
    const source = [
      "function creds(): string {",
      '  const a = process.env["A"]?.trim();',
      '  const b = process.env["B"]?.trim();',
      "  return a + b;",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  // --- Step A: the recognizer must reject rather than approximate a return it doesn't model.
  // These are the shapes the pre-fix recognizer over-claimed (it looked only at whether the
  // last statement was a ReturnStatement, never at what it returned).

  it("rejects a return that matches no modeled shape at all", () => {
    const source = [
      "function weird(): string {",
      '  const u = process.env["V"]?.trim();',
      '  return u + "!";',
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it('rejects a method call on the binding that is not .replace(/\\/$/, "") — a wrong callee, not a wrong expression shape', () => {
    // Distinct from the BinaryExpression case above: this is a CallExpression on the binding
    // itself (matchTransformExpr's MemberExpression branch), just not the one transform this
    // recognizer models. `.replace` with the wrong pattern would be the same kind of near miss;
    // a different method name entirely is the more obviously-real-world one.
    const source = [
      "function weird(): string {",
      '  const b = process.env["V"]?.trim();',
      "  return b.toUpperCase();",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
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

  // --- Further rejection cases, exercising the "reject rather than guess" rule directly.

  it("rejects a guard whose message does not match the emitted form", () => {
    const source = [
      "function apiKey(): string {",
      '  const k = process.env["NEW_RELIC_API_KEY"]?.trim();',
      '  if (k === undefined || k === "") {',
      '    throw new Error("something else entirely");',
      "  }",
      "  return k;",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("rejects an auth-shaped return with no guard and no default (not producible by the emitter)", () => {
    const source = [
      "function authHeaders(): Record<string, string> {",
      '  const tok = process.env["TOKEN"]?.trim();',
      '  return { Authorization: `Bearer ${tok}`, Accept: "application/json" };',
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("rejects a headers-auth return missing the trailing Accept property", () => {
    const source = [
      "function headers(): Record<string, string> {",
      '  const ak = process.env["DD_API_KEY"]?.trim();',
      '  if (ak === undefined || ak === "") {',
      '    throw new Error("DD_API_KEY is not set");',
      "  }",
      '  return { "DD-API-KEY": ak };',
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("rejects an auth return containing a spread rather than treating it as headers", () => {
    const source = [
      "function headers(): Record<string, string> {",
      '  const ak = process.env["DD_API_KEY"]?.trim();',
      '  if (ak === undefined || ak === "") {',
      '    throw new Error("DD_API_KEY is not set");',
      "  }",
      '  return { ...common, "DD-API-KEY": ak, Accept: "application/json" };',
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("rejects reads with an inconsistent default across vars", () => {
    const source = [
      "function headers(): Record<string, string> {",
      '  const ak = process.env["DD_API_KEY"]?.trim() || "x";',
      '  const app = process.env["DD_APP_KEY"]?.trim();',
      '  return { "DD-API-KEY": ak, "DD-APPLICATION-KEY": app, Accept: "application/json" };',
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("rejects a default co-occurring with a guard, which the emitter never produces", () => {
    const source = [
      "function siteHost(): string {",
      '  const s = process.env["DD_SITE"]?.trim() || "datadoghq.com";',
      '  if (s === undefined || s === "") {',
      '    throw new Error("DD_SITE is not set");',
      "  }",
      "  return s;",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });
});
