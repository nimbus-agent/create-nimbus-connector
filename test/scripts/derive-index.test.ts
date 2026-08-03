import { describe, expect, it } from "bun:test";
import { deriveSpec } from "../../scripts/_lib/derive/index.ts";

const MANIFEST = JSON.stringify({
  id: "newrelic",
  displayName: "New Relic",
  version: "0.1.0",
  description: "Query New Relic.",
  author: "Nimbus",
  entrypoint: "dist/server.js",
  runtime: "bun",
  permissions: { network: ["api.newrelic.com"] },
  hitlRequired: [],
  syncInterval: 300,
  minNimbusVersion: "0.2.0",
});

const SERVER = [
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { z } from "zod";',
  "",
  "import {",
  "  createRegisterSimpleTool,",
  "  createZodToolRegistrar,",
  "  mcpJsonResult as jsonResult,",
  '} from "../../shared/mcp-tool-kit.ts";',
  "",
  "function apiKey(): string {",
  '  const k = process.env["NEW_RELIC_API_KEY"]?.trim();',
  '  if (k === undefined || k === "") {',
  '    throw new Error("NEW_RELIC_API_KEY is not set");',
  "  }",
  "  return k;",
  "}",
  "",
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
  "",
  'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
  "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
  "",
  'reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>',
  '  jsonResult(await nrGet("/v2/applications.json")),',
  ");",
  "",
  "const transport = new StdioServerTransport();",
  "await mcp.connect(transport);",
].join("\n");

describe("deriveSpec", () => {
  it("derives a whole hand-rolled connector", () => {
    const result = deriveSpec({ server: SERVER, manifest: MANIFEST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.spec).toMatchObject({
      name: "newrelic",
      displayName: "New Relic",
      serviceLabel: "New Relic",
      style: "hand-rolled",
      env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }],
      fetchHelper: { local: "nrGet", base: "https://api.newrelic.com" },
    });
  });

  it("blocks a connector with one unrecognized statement, naming it", () => {
    const server = `${SERVER}\nimport { listTools } from "./tools.ts";`;
    const result = deriveSpec({ server, manifest: MANIFEST });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["import-from:./tools.ts"]);
  });

  it("reports a parse failure as a blocker rather than throwing", () => {
    const result = deriveSpec({ server: "const = ;", manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]?.kind).toBe("parse-error");
  });

  it("reports an unreadable manifest as a blocker rather than throwing", () => {
    const result = deriveSpec({ server: SERVER, manifest: "{not json" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]?.kind).toBe("no-manifest");
  });

  it("blocks a style whose frame it does not recognize", () => {
    const server = 'import { runReadOnlyMcpConnector } from "../../shared/read-only-kit.ts";';
    const result = deriveSpec({ server, manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]?.kind).toBe("no-frame");
  });

  it("blocks a frame with no fetch helper, even though totality is satisfied", () => {
    const server = [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      "import {",
      "  createRegisterSimpleTool,",
      "  createZodToolRegistrar,",
      '} from "../../shared/mcp-tool-kit.ts";',
      "",
      'const mcp = new McpServer({ name: "nimbus-empty", version: "0.1.0" });',
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "",
      "const transport = new StdioServerTransport();",
      "await mcp.connect(transport);",
    ].join("\n");
    const result = deriveSpec({ server, manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["no-fetch-helper"]);
  });
});
