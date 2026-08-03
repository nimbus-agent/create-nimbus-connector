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

  it("does not claim a multi-var accessor, which this recognizer does not model", () => {
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
});
