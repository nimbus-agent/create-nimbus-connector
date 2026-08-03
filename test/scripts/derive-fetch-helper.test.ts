import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeFetchHelper } from "../../scripts/_lib/derive/server/fetch-helper.ts";

const HELPER = [
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

function run(source: string) {
  const statements = parseModule(source);
  const claims = createClaimSet();
  return { fields: recognizeFetchHelper(statements, claims), claims, statements };
}

describe("recognizeFetchHelper", () => {
  it("recovers the local, base, service label and inline headers", () => {
    const { fields, claims, statements } = run(HELPER);
    expect(fields).toEqual({
      local: "nrGet",
      base: "https://api.newrelic.com",
      serviceLabel: "New Relic",
      inlineHeaders: { "X-Api-Key": "${env.apiKey}", Accept: "application/json" },
    });
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("returns undefined for a function that is not a fetch helper", () => {
    expect(run("async function g(): Promise<void> {}").fields).toBeUndefined();
  });

  it("claims nothing when it does not recognize the helper", () => {
    const { claims } = run("async function g(): Promise<void> {}");
    expect(claims.claims()).toEqual([]);
  });
});
