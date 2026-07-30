import { describe, expect, it } from "bun:test";
import { generate } from "../../src/emit/index.ts";
import { formatAll } from "../../src/format.ts";
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
