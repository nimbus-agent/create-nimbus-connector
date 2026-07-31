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
    expect(h2s(emitReadme(spec, "monorepo").content)).toEqual([
      "what this is",
      "install",
      "quickstart",
      "see also",
      "license",
    ]);
  });

  it("uses the derived title in the H1 and the directory name as the auth slug", () => {
    const md = emitReadme(spec, "monorepo").content;
    expect(md.startsWith("# Newrelic Connector\n")).toBe(true);
    expect(md).toContain("nimbus connector auth newrelic");
  });
});

describe("standalone README", () => {
  const md = () => emitReadme(spec, "standalone").content;

  it("still carries every H2 the monorepo audit requires", () => {
    expect(h2s(md())).toEqual(["what this is", "install", "quickstart", "see also", "license"]);
  });

  it("gives real install instructions instead of 'bundled with Nimbus'", () => {
    expect(md()).not.toContain("Bundled with Nimbus");
    expect(md()).toContain("bun install");
  });

  it("names the credential env var the connector actually reads", () => {
    expect(md()).toContain("NEW_RELIC_API_KEY");
    expect(md()).toContain("Set the credentials this connector reads from the environment:");
    expect(md()).toContain("export NEW_RELIC_API_KEY=...");
  });

  it("omits the credential sentence and its fence when the spec reads no env vars", () => {
    // `env: []` with literal inlineHeaders passes validation, and previously produced
    // "Set the credentials this connector reads from the environment:" above an empty
    // ```bash block.
    const envless = parseSpec({
      name: "acme",
      displayName: "Acme",
      description: "d.",
      serviceLabel: "Acme",
      style: "hand-rolled",
      env: [],
      fetchHelper: {
        local: "acmeGet",
        base: "https://api.acme.test",
        inlineHeaders: { Accept: "application/json" },
      },
    });
    const out = emitReadme(envless, "standalone").content;
    expect(out).not.toContain("Set the credentials");
    expect(out).not.toContain("```bash\n```");
    expect(out).not.toMatch(/```bash\s*```/);
    expect(out).toContain("Register it with Nimbus, or run it directly over stdio:");
    // The Quickstart section still has content and the H2s are unchanged.
    expect(h2s(out)).toEqual(["what this is", "install", "quickstart", "see also", "license"]);
  });

  it("leaves the monorepo README unchanged", () => {
    expect(emitReadme(spec, "monorepo").content).toContain("Bundled with Nimbus");
  });
});
