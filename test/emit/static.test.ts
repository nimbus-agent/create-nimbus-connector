import { describe, expect, it } from "bun:test";
import { BIOME_VERSION, emitBiomeJson } from "../../src/emit/biome-json.ts";
import { generate } from "../../src/emit/index.ts";
import { emitPackageJson } from "../../src/emit/package-json.ts";
import { emitReadme } from "../../src/emit/readme.ts";
import { emitSandboxTest } from "../../src/emit/sandbox-test.ts";
import { emitTsconfig } from "../../src/emit/tsconfig.ts";
import { FORMATTER_CONFIG } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

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
    const pkg = JSON.parse(emitPackageJson(spec, "monorepo").content);
    expect(pkg.name).toBe("nimbus-mcp-newrelic");
    expect(pkg.license).toBe("AGPL-3.0-only");
    expect(pkg.private).toBe(false);
    expect(pkg.type).toBe("module");
  });

  it("declares exactly the three connector dependencies", () => {
    const pkg = JSON.parse(emitPackageJson(spec, "monorepo").content);
    expect(pkg.dependencies).toEqual({
      "@modelcontextprotocol/sdk": "1.30.0",
      "@nimbus-dev/sdk": "^1.8.1",
      zod: "^4.4.2",
    });
  });

  it("ends with a trailing newline", () => {
    expect(emitPackageJson(spec, "monorepo").content.endsWith("}\n")).toBe(true);
  });
});

describe("emitTsconfig", () => {
  it("extends the monorepo base three levels up", () => {
    const cfg = JSON.parse(emitTsconfig("monorepo").content);
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

describe("standalone package.json", () => {
  const pkg = () => JSON.parse(emitPackageJson(spec, "standalone").content);

  it("raises the SDK floor to the version carrying connector-kit", () => {
    expect(pkg().dependencies["@nimbus-dev/sdk"]).toBe("^1.11.0");
  });

  it("keeps the other two connector dependencies unchanged", () => {
    expect(pkg().dependencies["@modelcontextprotocol/sdk"]).toBe("1.30.0");
    expect(pkg().dependencies.zod).toBe("^4.4.2");
  });

  it("adds dev and build scripts producing the manifest's declared entrypoint", () => {
    expect(pkg().scripts.build).toBe("bun build src/server.ts --outdir dist --target bun");
    expect(pkg().scripts.dev).toBe("bun run --watch src/server.ts");
  });

  it("declares no bin — a connector is spawned via its manifest entrypoint", () => {
    expect(pkg().bin).toBeUndefined();
  });

  it("declares the tools its own lint and typecheck scripts invoke", () => {
    // A monorepo connector finds biome and tsc in the workspace root's node_modules/.bin.
    // A standalone package has no root, so `bun run lint` / `bun run typecheck` are
    // "command not found" on a clean registry install unless these are declared here.
    expect(pkg().scripts.lint).toBe("biome check src/");
    expect(pkg().scripts.typecheck).toBe("tsc --noEmit");
    expect(pkg().devDependencies["@biomejs/biome"]).toBe(`^${BIOME_VERSION}`);
    expect(pkg().devDependencies.typescript).toBeDefined();
    expect(pkg().devDependencies["@types/bun"]).toBe("latest");
  });

  it("leaves the monorepo target untouched", () => {
    const mono = JSON.parse(emitPackageJson(spec, "monorepo").content);
    expect(mono.dependencies["@nimbus-dev/sdk"]).toBe("^1.8.1");
    expect(mono.scripts.build).toBeUndefined();
    // The workspace root supplies both — declaring them here would change golden bytes.
    expect(mono.devDependencies).toEqual({ "@types/bun": "latest" });
  });
});

describe("license stamping", () => {
  it("defaults a standalone package to UNLICENSED, not the monorepo's AGPL stamp", () => {
    expect(JSON.parse(emitPackageJson(spec, "standalone").content).license).toBe("UNLICENSED");
  });

  it("keeps the monorepo package on AGPL-3.0-only", () => {
    expect(JSON.parse(emitPackageJson(spec, "monorepo").content).license).toBe("AGPL-3.0-only");
  });

  it("stamps an explicit license into package.json and the standalone README", () => {
    const files = generate(spec, { target: "standalone", license: "MIT" });
    const pkg = JSON.parse(files.find((f) => displayPath(f.path) === "package.json")!.content);
    const readme = files.find((f) => displayPath(f.path) === "README.md")!.content;
    expect(pkg.license).toBe("MIT");
    expect(readme).toContain("## License\n\nMIT\n");
    expect(readme).not.toContain("AGPL");
  });

  it("explains UNLICENSED in the README rather than leaving a bare word", () => {
    const readme = generate(spec, { target: "standalone" }).find(
      (f) => displayPath(f.path) === "README.md",
    )!.content;
    expect(readme).toContain("UNLICENSED — no license is granted");
    expect(readme).toContain("--license <spdx>");
  });

  it("refuses a license on the monorepo target instead of silently dropping it", () => {
    expect(() => generate(spec, { target: "monorepo", license: "MIT" })).toThrow(
      /only configurable for the standalone target/i,
    );
    expect(() => generate(spec, { license: "MIT" })).toThrow(/AGPL-3\.0-only unconditionally/);
  });

  it("leaves the monorepo README's byte-locked License section alone", () => {
    // The real connectors' README.md says "AGPL-3.0" under the heading, not the SPDX id.
    expect(emitReadme(spec, "monorepo").content).toContain("## License\n\nAGPL-3.0\n");
  });
});

describe("emitBiomeJson", () => {
  const cfg = () => JSON.parse(emitBiomeJson().content);

  it("is written to the package root", () => {
    expect(emitBiomeJson().path).toEqual(["biome.json"]);
  });

  it("mirrors the formatter settings src/format.ts applies", () => {
    // Not a restatement from memory: any drift between the generator's own formatter and
    // the config it ships means `biome check src/` reformats what the generator produced.
    expect(cfg().formatter).toEqual(FORMATTER_CONFIG.formatter);
    expect(cfg().javascript).toEqual(FORMATTER_CONFIG.javascript);
  });

  it("pins its $schema to the Biome version it declares as a devDependency", () => {
    expect(cfg().$schema).toBe(`https://biomejs.dev/schemas/${BIOME_VERSION}/schema.json`);
    expect(
      JSON.parse(emitPackageJson(spec, "standalone").content).devDependencies["@biomejs/biome"],
    ).toBe(`^${BIOME_VERSION}`);
  });

  it("enables the linter, so `biome check src/` is a real gate and not a format-only pass", () => {
    expect(cfg().linter.enabled).toBe(true);
    expect(cfg().linter.rules.recommended).toBe(true);
  });
});

describe("SDK floor", () => {
  const searchSpec = parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "d.",
    serviceLabel: "Mercury",
    style: "read-only-kit",
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools: [
      {
        name: "mercury_search",
        description: "Search.",
        impl: "search",
        path: "/api/v1/accounts",
        filter: { export: "filterThing", fields: ["id"] },
      },
    ],
  });

  const plainSpec = parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "d.",
    serviceLabel: "Mercury",
    style: "read-only-kit",
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools: [
      {
        name: "mercury_list",
        description: "List.",
        path: "/api/v1/accounts",
      },
    ],
  });

  // ^1.15.0, not the ^1.12.0 the Stage D plan predicted: the SDK released 1.12.0, 1.13.0 and
  // 1.14.0 while this stage was being built, and `git ls-tree typescript-v1.14.0
  // sdks/typescript/src/connector-kit/` shows no search-filter.ts in any of them. A package
  // pinning ^1.12.0 would resolve 1.14.x and fail to import matchesResult at all.
  it("raises the floor to ^1.15.0 for a standalone search spec", () => {
    const pkg = JSON.parse(emitPackageJson(searchSpec, "standalone", "MIT").content);
    expect(pkg.dependencies["@nimbus-dev/sdk"]).toBe("^1.15.0");
  });

  it("leaves the floor at ^1.11.0 for a standalone spec with no search tool", () => {
    const pkg = JSON.parse(emitPackageJson(plainSpec, "standalone", "MIT").content);
    expect(pkg.dependencies["@nimbus-dev/sdk"]).toBe("^1.11.0");
  });

  it("leaves the monorepo floor at ^1.8.1 regardless of search", () => {
    const pkg = JSON.parse(emitPackageJson(searchSpec, "monorepo", "AGPL-3.0-only").content);
    expect(pkg.dependencies["@nimbus-dev/sdk"]).toBe("^1.8.1");
  });
});

describe("standalone tsconfig", () => {
  const cfg = () => JSON.parse(emitTsconfig("standalone").content);

  it("is self-contained, not extending the monorepo base", () => {
    expect(cfg().extends).toBeUndefined();
    expect(cfg().compilerOptions.strict).toBe(true);
    expect(cfg().compilerOptions.target).toBe("ESNext");
    expect(cfg().compilerOptions.moduleResolution).toBe("bundler");
  });

  it("omits customConditions so the SDK resolves to dist like a real consumer", () => {
    expect(cfg().compilerOptions.customConditions).toBeUndefined();
  });

  it("omits allowImportingTsExtensions — no .ts imports remain", () => {
    expect(cfg().compilerOptions.allowImportingTsExtensions).toBeUndefined();
  });

  it("leaves the monorepo target extending the base", () => {
    expect(JSON.parse(emitTsconfig("monorepo").content).extends).toBe(
      "../../../tsconfig.base.json",
    );
  });
});
