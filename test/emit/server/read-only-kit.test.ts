import { describe, expect, it } from "bun:test";
import { emitServer } from "../../../src/emit/server/index.ts";
import { parseSpec } from "../../../src/spec.ts";

function make(style: string, tools: unknown[] = []) {
  return parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "d.",
    serviceLabel: "Mercury",
    style,
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools,
  });
}

const LIST = [{ name: "mercury_list", description: "List accounts.", path: "/api/v1/accounts" }];

describe("emitServer, style read-only-kit", () => {
  it("wraps the registrations in runReadOnlyMcpConnector and emits no manual wiring", () => {
    const out = emitServer(make("read-only-kit", LIST), "monorepo").content;
    expect(out).toContain('await runReadOnlyMcpConnector("nimbus-mercury", (reg) => {');
    expect(out).not.toContain("new McpServer(");
    expect(out).not.toContain("new StdioServerTransport()");
    expect(out).not.toContain("createZodToolRegistrar");
  });

  it("imports the helper from the shared path for the monorepo target", () => {
    const out = emitServer(make("read-only-kit", LIST), "monorepo").content;
    expect(out).toContain(
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
    );
  });

  it("leaves hand-rolled output untouched", () => {
    const out = emitServer(make("hand-rolled", LIST), "monorepo").content;
    expect(out).toContain("const mcp = new McpServer(");
    expect(out).toContain("await mcp.connect(transport);");
    expect(out).not.toContain("runReadOnlyMcpConnector");
  });
});
