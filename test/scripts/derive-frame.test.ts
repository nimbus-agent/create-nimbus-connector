import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeFrame } from "../../scripts/_lib/derive/server/index.ts";

const FRAME = [
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { z } from "zod";',
  'import { createRegisterSimpleTool, createZodToolRegistrar, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";',
  'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
  "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
  "const transport = new StdioServerTransport();",
  "await mcp.connect(transport);",
].join("\n");

describe("recognizeFrame", () => {
  it("recovers the connector name and claims every frame statement", () => {
    const statements = parseModule(FRAME);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toEqual({ name: "newrelic" });
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("leaves a non-frame statement unclaimed", () => {
    const source = `${FRAME}\nfunction extra() {}`;
    const statements = parseModule(source);
    const claims = createClaimSet();

    recognizeFrame(statements, claims);
    expect(claims.unclaimed(statements).map((s) => s.type)).toEqual(["FunctionDeclaration"]);
  });

  it("returns undefined and claims nothing for a read-only-kit module", () => {
    const statements = parseModule('import { runReadOnlyMcpConnector } from "../../shared/x.ts";');
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("rejects partial frames: McpServer with unrelated connect call", () => {
    const source = [
      'const mcp = new McpServer({ name: "nimbus-otherstyle", version: "0.1.0" });',
      "function somethingCompletelyDifferent() { return 1; }",
      "await socket.connect(other);",
    ].join("\n");
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("rejects frame where connect receiver is not the mcp variable", () => {
    const source = [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      'import { z } from "zod";',
      'import { createRegisterSimpleTool, createZodToolRegistrar, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";',
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "const transport = new StdioServerTransport();",
      "await other.connect(transport);",
    ].join("\n");
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });
});
