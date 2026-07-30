import { describe, expect, it } from "bun:test";
import { emitReadme } from "../../src/emit/readme.ts";
import { parseSpec } from "../../src/spec.ts";

const spec = parseSpec({
  name: "newrelic",
  displayName: "New Relic",
  description: "d.",
  serviceLabel: "New Relic",
  style: "hand-rolled",
  env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }],
  fetchHelper: {
    local: "nrGet",
    base: "https://api.newrelic.com",
    inlineHeaders: { "X-Api-Key": "${env.apiKey}" },
  },
});

function h2s(md: string): string[] {
  return [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());
}

describe("emitReadme", () => {
  it("carries every H2 that audit:package-readmes requires for the public tier", () => {
    expect(h2s(emitReadme(spec).content)).toEqual([
      "what this is",
      "install",
      "quickstart",
      "see also",
      "license",
    ]);
  });

  it("uses the derived title in the H1 and the directory name as the auth slug", () => {
    const md = emitReadme(spec).content;
    expect(md.startsWith("# Newrelic Connector\n")).toBe(true);
    expect(md).toContain("nimbus connector auth newrelic");
  });
});
