import { describe, expect, it } from "bun:test";
import { emitPackageJson } from "../../src/emit/package-json.ts";
import { emitSandboxTest } from "../../src/emit/sandbox-test.ts";
import { emitTsconfig } from "../../src/emit/tsconfig.ts";
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

describe("emitPackageJson", () => {
  it("names the package nimbus-mcp-<name> and is AGPL", () => {
    const pkg = JSON.parse(emitPackageJson(spec).content);
    expect(pkg.name).toBe("nimbus-mcp-newrelic");
    expect(pkg.license).toBe("AGPL-3.0-only");
    expect(pkg.private).toBe(false);
    expect(pkg.type).toBe("module");
  });

  it("declares exactly the three connector dependencies", () => {
    const pkg = JSON.parse(emitPackageJson(spec).content);
    expect(pkg.dependencies).toEqual({
      "@modelcontextprotocol/sdk": "1.30.0",
      "@nimbus-dev/sdk": "^1.8.1",
      zod: "^4.4.2",
    });
  });

  it("ends with a trailing newline", () => {
    expect(emitPackageJson(spec).content.endsWith("}\n")).toBe(true);
  });
});

describe("emitTsconfig", () => {
  it("extends the monorepo base three levels up", () => {
    const cfg = JSON.parse(emitTsconfig().content);
    expect(cfg.extends).toBe("../../../tsconfig.base.json");
    expect(cfg.include).toEqual(["src/**/*"]);
  });
});

describe("emitSandboxTest", () => {
  it("is placed at test/sandbox.test.ts and gated on NIMBUS_TEST_HARNESS", () => {
    const f = emitSandboxTest();
    expect(f.path).toEqual(["test", "sandbox.test.ts"]);
    expect(f.content).toContain("NIMBUS_TEST_HARNESS");
    expect(f.content).toContain("runSandboxContractTests");
  });
});
