import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeFetchHelper } from "../../scripts/_lib/derive/server/fetch-helper.ts";

// Real emitted helpers from fixtures

const NEWRELIC = [
  "async function nrGet(path: string): Promise<unknown> {",
  "  const res = await fetch(`https://api.newrelic.com${path}`, {",
  '    headers: { "X-Api-Key": apiKey(), Accept: "application/json" },',
  "  });",
  "  const text = await res.text();",
  "  if (!res.ok) {",
  "    throw new Error(`New Relic ${String(res.status)}: ${text.slice(0, 400)}`);",
  "  }",
  "  return JSON.parse(text) as unknown;",
  "}",
].join("\n");

const DATADOG = [
  "async function ddGet(path: string): Promise<unknown> {",
  "  const res = await fetch(`https://${siteHost()}${path}`, { headers: headers() });",
  "  const text = await res.text();",
  "  if (!res.ok) {",
  "    throw new Error(`Datadog ${String(res.status)}: ${text.slice(0, 400)}`);",
  "  }",
  "  return JSON.parse(text) as unknown;",
  "}",
].join("\n");

const GRAFANA = [
  "async function grafanaGet(path: string): Promise<unknown> {",
  '  const pathPart = path.startsWith("/") ? path : `/${path}`;',
  "  const res = await fetch(`${baseUrl()}${pathPart}`, {",
  "    headers: authHeaders(),",
  "  });",
  "  const text = await res.text();",
  "  if (!res.ok) {",
  "    throw new Error(`Grafana ${String(res.status)}: ${text.slice(0, 400)}`);",
  "  }",
  "  try {",
  "    return JSON.parse(text) as unknown;",
  "  } catch {",
  "    return { raw: text };",
  "  }",
  "}",
].join("\n");

const SENTRY = [
  "async function sentryGet(path: string): Promise<unknown> {",
  "  const res = await fetch(`${apiRoot()}${path}`, { headers: headers() });",
  "  const text = await res.text();",
  "  if (!res.ok) {",
  "    throw new Error(`Sentry ${String(res.status)}: ${text.slice(0, 400)}`);",
  "  }",
  "  return JSON.parse(text) as unknown;",
  "}",
].join("\n");

// Correlation defect test: two fetch() calls
const TWO_FETCHES = [
  "async function malformed(path: string): Promise<unknown> {",
  "  const dummy = await fetch(`https://example.com${path}`, {",
  '    headers: { "X-Dummy": "dummy" },',
  "  });",
  "  const res = await fetch(`https://api.example.com${path}`, {",
  '    headers: { "X-Api-Key": apiKey() },',
  "  });",
  "  const text = await res.text();",
  "  if (!res.ok) {",
  "    throw new Error(`Example ${String(res.status)}: ${text.slice(0, 400)}`);",
  "  }",
  "  return JSON.parse(text) as unknown;",
  "}",
].join("\n");

function run(source: string) {
  const statements = parseModule(source);
  const claims = createClaimSet();
  return { fields: recognizeFetchHelper(statements, claims), claims, statements };
}

describe("recognizeFetchHelper", () => {
  it("recognizes newrelic (inline headers, static base)", () => {
    const { fields, claims, statements } = run(NEWRELIC);
    expect(fields).toEqual({
      local: "nrGet",
      base: "https://api.newrelic.com",
      serviceLabel: "New Relic",
      inlineHeaders: { "X-Api-Key": "${env.apiKey}", Accept: "application/json" },
    });
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("recognizes datadog (accessor headers, env base)", () => {
    const { fields, claims, statements } = run(DATADOG);
    expect(fields).toEqual({
      local: "ddGet",
      base: "https://${env.siteHost}",
      serviceLabel: "Datadog",
      headers: "headers",
    });
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("recognizes grafana (normalizeLeadingSlash, env base)", () => {
    const { fields, claims, statements } = run(GRAFANA);
    expect(fields).toEqual({
      local: "grafanaGet",
      base: "${env.baseUrl}",
      serviceLabel: "Grafana",
      headers: "authHeaders",
      normalizeLeadingSlash: true,
    });
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("recognizes sentry (accessor headers, env base)", () => {
    const { fields, claims, statements } = run(SENTRY);
    expect(fields).toEqual({
      local: "sentryGet",
      base: "${env.apiRoot}",
      serviceLabel: "Sentry",
      headers: "headers",
    });
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("rejects helpers with multiple fetch() calls", () => {
    const { fields, claims } = run(TWO_FETCHES);
    expect(fields).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("returns undefined for a function that is not a fetch helper", () => {
    expect(run("async function g(): Promise<void> {}").fields).toBeUndefined();
  });

  it("claims nothing when it does not recognize the helper", () => {
    const { claims } = run("async function g(): Promise<void> {}");
    expect(claims.claims()).toEqual([]);
  });

  // Gap 1: rejects base template with accessor taking arguments
  it("rejects base template with accessor taking arguments", () => {
    const src = [
      "async function probeGet(path: string): Promise<unknown> {",
      "  const res = await fetch(`https://${region(x)}${path}`, {",
      '    headers: { "X-Api-Key": apiKey() },',
      "  });",
      "  const text = await res.text();",
      "  if (!res.ok) {",
      "    throw new Error(`Probe ${String(res.status)}: ${text.slice(0, 400)}`);",
      "  }",
      "  return JSON.parse(text) as unknown;",
      "}",
    ].join("\n");
    const { fields, claims } = run(src);
    expect(fields).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // Gap 2: pathPart with non-matching ternary should not set normalizeLeadingSlash
  it("does not set normalizeLeadingSlash for non-matching ternary", () => {
    const src = [
      "async function probeGet(path: string): Promise<unknown> {",
      "  const pathPart = somethingElse();",
      "  const res = await fetch(`https://api.example.com${path}`, {",
      '    headers: { "X-Api-Key": apiKey() },',
      "  });",
      "  const text = await res.text();",
      "  if (!res.ok) {",
      "    throw new Error(`Probe ${String(res.status)}: ${text.slice(0, 400)}`);",
      "  }",
      "  return JSON.parse(text) as unknown;",
      "}",
    ].join("\n");
    const { fields, claims, statements } = run(src);
    // Helper should be recognized (valid helper), but normalizeLeadingSlash must NOT be set
    expect(fields).toEqual({
      local: "probeGet",
      base: "https://api.example.com",
      serviceLabel: "Probe",
      inlineHeaders: { "X-Api-Key": "${env.apiKey}" },
    });
    // normalizeLeadingSlash should not be present in the result
    expect(fields?.normalizeLeadingSlash).toBeUndefined();
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  // Gap 3: rejects inline header with accessor taking arguments
  it("rejects inline header with accessor taking arguments", () => {
    const src = [
      "async function probeGet(path: string): Promise<unknown> {",
      "  const res = await fetch(`https://api.example.com${path}`, {",
      '    headers: { "X-Api-Key": apiKey(token), Accept: "application/json" },',
      "  });",
      "  const text = await res.text();",
      "  if (!res.ok) {",
      "    throw new Error(`Probe ${String(res.status)}: ${text.slice(0, 400)}`);",
      "  }",
      "  return JSON.parse(text) as unknown;",
      "}",
    ].join("\n");
    const { fields, claims } = run(src);
    expect(fields).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });
});
