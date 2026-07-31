import { beforeAll, describe, expect, it } from "bun:test";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

const spec = parseSpec({
  name: "newrelic",
  displayName: "New Relic",
  description: "d.",
  serviceLabel: "New Relic",
  style: "hand-rolled",
  network: ["api.newrelic.com"],
  env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }],
  fetchHelper: {
    local: "nrGet",
    base: "https://api.newrelic.com",
    inlineHeaders: { "X-Api-Key": "${env.apiKey}", Accept: "application/json" },
  },
  tools: [
    {
      name: "newrelic_application_list",
      description: "List APM applications.",
      path: "/v2/applications.json",
    },
  ],
});

describe("generate", () => {
  beforeAll(async () => {
    await initFormatter();
  });
  it("emits exactly the six-file connector tree", () => {
    expect(
      generate(spec)
        .map((f) => displayPath(f.path))
        .sort(),
    ).toEqual([
      "README.md",
      "nimbus.extension.json",
      "package.json",
      "src/server.ts",
      "test/sandbox.test.ts",
      "tsconfig.json",
    ]);
  });

  it("wires the hand-rolled server with relative shared imports", () => {
    const src = generate(spec).find((f) => displayPath(f.path) === "src/server.ts")!.content;
    expect(src).toContain('import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";');
    expect(src).toContain('} from "../../shared/mcp-tool-kit.ts";');
    expect(src).toContain(
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
    );
    expect(src).toContain("const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));");
    expect(src).toContain("const transport = new StdioServerTransport();");
    expect(src).toContain("await mcp.connect(transport);");
  });

  it("uses server/rest-tool-kit wiring for rest-kit style", () => {
    const restSpec = parseSpec({
      ...JSON.parse(JSON.stringify({ ...spec, title: undefined, id: undefined })),
      style: "rest-kit",
      env: [{ vars: ["NR_TOKEN"], local: "hdrs", bindings: ["t"], auth: "bearer" }],
      // rest-kit cannot reference ${env.X} in fetchHelper — makeRestToolRegistrar resolves
      // the token itself, so no accessor exists to call. Literal-only fetchHelper here.
      fetchHelper: {
        local: "nrGet",
        base: "https://api.newrelic.com",
        inlineHeaders: { Accept: "application/json" },
      },
    });
    const src = generate(restSpec).find((f) => displayPath(f.path) === "src/server.ts")!.content;
    expect(src).toContain('} from "../../shared/rest-tool-kit.ts";');
    expect(src).toContain(
      'const server = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
    );
    expect(src).toContain("await server.connect(transport);");
  });

  it("propagates validation failures", () => {
    // Deviation from the brief's literal fixture: `{ local: "apiKey", base: "https://x" }`
    // drops `inlineHeaders`, which the hand-rolled schema refine requires, so parseSpec()
    // itself throws before generate() is ever reached. Preserving inlineHeaders keeps parseSpec
    // green and lets the fetchHelper.local/env.local "apiKey" collision surface from
    // validateSpec() inside generate(), which is what this test asserts on.
    const bad = parseSpec({ ...spec, fetchHelper: { ...spec.fetchHelper, local: "apiKey" } });
    expect(() => generate(bad)).toThrow(/apiKey/);
  });

  it("omits the jsonResult import for an all-stub hand-rolled spec", () => {
    const stubSpec = parseSpec({
      ...JSON.parse(JSON.stringify({ ...spec, title: undefined, id: undefined })),
      tools: [
        { name: "newrelic_application_list", description: "List APM applications.", impl: "stub" },
      ],
    });
    const src = generate(stubSpec).find((f) => displayPath(f.path) === "src/server.ts")!.content;
    expect(src).not.toContain("jsonResult");
  });

  it("keeps the jsonResult import for a hand-rolled spec with one real tool", () => {
    const src = generate(spec).find((f) => displayPath(f.path) === "src/server.ts")!.content;
    expect(src).toContain("mcpJsonResult as jsonResult");
  });

  it("omits the z import for a zero-tool spec", () => {
    const zeroToolSpec = parseSpec({
      ...JSON.parse(JSON.stringify({ ...spec, title: undefined, id: undefined })),
      tools: [],
    });
    const src = generate(zeroToolSpec).find(
      (f) => displayPath(f.path) === "src/server.ts",
    )!.content;
    expect(src).not.toContain("import { z }");
  });

  it("keeps the z import for a spec with tools", () => {
    const src = generate(spec).find((f) => displayPath(f.path) === "src/server.ts")!.content;
    expect(src).toContain("import { z }");
  });

  it("produces a formattable, well-seamed server.ts for a full newrelic-shaped spec", () => {
    const files = formatAll(generate(spec));
    const src = files.find((f) => displayPath(f.path) === "src/server.ts")!.content;
    expect(src.startsWith("import { McpServer }")).toBe(true);
    expect(src).toContain(
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
    );
    expect(src.endsWith("await mcp.connect(transport);\n")).toBe(true);
    expect(src).not.toContain("\n\n\n");
  });
});

const handRolled = parseSpec({
  name: "acme",
  displayName: "Acme",
  description: "d.",
  serviceLabel: "Acme",
  style: "hand-rolled",
  env: [{ vars: ["ACME_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
  fetchHelper: { local: "acmeGet", base: "https://api.acme.test", headers: "headers" },
  tools: [{ name: "acme_item_list", description: "List items.", path: "/v1/items" }],
});

const restKit = parseSpec({
  name: "acme",
  displayName: "Acme",
  description: "d.",
  serviceLabel: "Acme",
  style: "rest-kit",
  env: [{ vars: ["ACME_TOKEN"], local: "hdrs", bindings: ["t"], auth: "bearer" }],
  fetchHelper: { local: "acmeFetch", base: "https://api.acme.test" },
  tools: [{ name: "acme_item_list", description: "List items.", path: "/v1/items" }],
});

function server(spec: Parameters<typeof generate>[0], target?: "monorepo" | "standalone"): string {
  const opts = target === undefined ? undefined : { target };
  return generate(spec, opts).find((f) => displayPath(f.path) === "src/server.ts")!.content;
}

describe("generate target", () => {
  it("defaults to monorepo, keeping relative shared imports", () => {
    expect(server(handRolled)).toContain('} from "../../shared/mcp-tool-kit.ts";');
    expect(server(handRolled)).not.toContain("@nimbus-dev/sdk/connector-kit");
  });

  it("emits one kit import for standalone hand-rolled", () => {
    const src = server(handRolled, "standalone");
    expect(src).toContain('} from "@nimbus-dev/sdk/connector-kit";');
    expect(src).not.toContain("../../shared/");
    expect(src.match(/@nimbus-dev\/sdk\/connector-kit/g)).toHaveLength(1);
  });

  it("emits one kit import for standalone rest-kit, including makeRestToolRegistrar", () => {
    const src = server(restKit, "standalone");
    expect(src).toContain("makeRestToolRegistrar,");
    expect(src).not.toContain("../../shared/");
    expect(src.match(/@nimbus-dev\/sdk\/connector-kit/g)).toHaveLength(1);
  });

  it("omits jsonResult for an all-stub standalone hand-rolled spec", () => {
    const allStub = parseSpec({
      name: "acme",
      displayName: "Acme",
      description: "d.",
      serviceLabel: "Acme",
      style: "hand-rolled",
      env: [{ vars: ["ACME_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
      fetchHelper: { local: "acmeGet", base: "https://api.acme.test", headers: "headers" },
      tools: [{ name: "acme_write", description: "Write.", impl: "stub" }],
    });
    const src = server(allStub, "standalone");
    expect(src).not.toContain("jsonResult");
    expect(src).toContain(
      'import { createRegisterSimpleTool, createZodToolRegistrar } from "@nimbus-dev/sdk/connector-kit";',
    );
  });

  it("no relative import escapes a standalone package", () => {
    for (const spec of [handRolled, restKit]) {
      const srcFiles = generate(spec, { target: "standalone" }).filter((f) => f.path[0] === "src");
      expect(srcFiles.length).toBeGreaterThan(0);
      for (const f of srcFiles) {
        // Only import specifiers matter. A filesystem path such as
        // resolve(fileURLToPath(import.meta.url), "../../nimbus.extension.json") is not an
        // import and is legitimate inside the package — the manifest sits at the package root
        // in both targets.
        const specifiers = [...f.content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
        for (const s of specifiers) {
          expect(s?.startsWith("..")).toBe(false);
        }
      }
    }
  });

  it("adds biome.json to the standalone tree and only there", () => {
    const standalone = generate(handRolled, { target: "standalone" }).map((f) =>
      displayPath(f.path),
    );
    expect(standalone).toContain("biome.json");
    expect(generate(handRolled).map((f) => displayPath(f.path))).not.toContain("biome.json");
  });

  it("sorts the standalone import block the way `biome check` demands", () => {
    // The kit is a package specifier, so it sorts with the other packages — after
    // "@modelcontextprotocol/*" and before "zod" — not into the trailing relative-import
    // group where the monorepo target's "../../shared/*" import lives. Getting this wrong
    // makes every generated package fail its own `bun run lint` on the first run.
    for (const spec of [handRolled, restKit]) {
      const lines = server(spec, "standalone").split("\n");
      const kit = lines.findIndex((l) => l.includes("@nimbus-dev/sdk/connector-kit"));
      const stdio = lines.findIndex((l) => l.includes("server/stdio.js"));
      const zod = lines.findIndex((l) => l === 'import { z } from "zod";');
      expect(stdio).toBeGreaterThanOrEqual(0);
      expect(zod).toBeGreaterThanOrEqual(0);
      expect(kit).toBeGreaterThan(stdio);
      expect(kit).toBeLessThan(zod);
      // No blank line anywhere inside the import block.
      expect(lines.slice(0, zod + 1).some((l) => l === "")).toBe(false);
    }
  });

  it("keeps the monorepo import block in its two-group shape", () => {
    const lines = server(handRolled).split("\n");
    const zod = lines.findIndex((l) => l === 'import { z } from "zod";');
    expect(lines[zod + 1]).toBe("");
    expect(lines[zod + 2]).toContain("import {");
  });

  it("sandbox tests are identical for both targets", () => {
    for (const spec of [handRolled, restKit]) {
      const monorepoSandbox = generate(spec).find(
        (f) => displayPath(f.path) === "test/sandbox.test.ts",
      )?.content;
      const standaloneSandbox = generate(spec, { target: "standalone" }).find(
        (f) => displayPath(f.path) === "test/sandbox.test.ts",
      )?.content;
      expect(monorepoSandbox).toBe(standaloneSandbox);
    }
  });
});
