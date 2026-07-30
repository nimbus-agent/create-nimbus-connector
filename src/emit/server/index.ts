import type { ConnectorSpec } from "../../spec.ts";
import type { GeneratedFile } from "../../types.ts";
import { renderEnvAccessor } from "./env.ts";
import { renderFetchHelper } from "./fetch-helper.ts";
import { renderHandRolledTools } from "./tools-hand.ts";
import { renderRestKitTools } from "./tools-rest.ts";

function imports(spec: ConnectorSpec): string {
  // z.object(...) is only emitted per tool — a zero-tool spec never calls it.
  const usesZod = spec.tools.length > 0;
  // Stub handlers only throw; jsonResult(...) is only emitted by a non-stub hand-rolled tool.
  const usesJsonResult = spec.style === "hand-rolled" && spec.tools.some((t) => t.impl !== "stub");

  const head = [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    ...(usesZod ? ['import { z } from "zod";'] : []),
    "",
  ];
  if (spec.style === "hand-rolled") {
    if (usesJsonResult) {
      head.push(
        "import {",
        "  createRegisterSimpleTool,",
        "  createZodToolRegistrar,",
        "  mcpJsonResult as jsonResult,",
        '} from "../../shared/mcp-tool-kit.ts";',
      );
    } else {
      head.push(
        'import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
      );
    }
  } else {
    head.push(
      'import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
      'import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";',
    );
  }
  return head.join("\n");
}

function wiring(spec: ConnectorSpec): string {
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return [
    `const ${v} = new McpServer({ name: "nimbus-${spec.name}", version: "0.1.0" });`,
    `const reg = createZodToolRegistrar(createRegisterSimpleTool(${v}));`,
  ].join("\n");
}

function tail(spec: ConnectorSpec): string {
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return ["const transport = new StdioServerTransport();", `await ${v}.connect(transport);`].join(
    "\n",
  );
}

export function emitServer(spec: ConnectorSpec): GeneratedFile {
  const isHand = spec.style === "hand-rolled";
  const sections = [
    imports(spec),
    // Env accessors are emitted for hand-rolled ONLY. Rest-kit's makeRestToolRegistrar
    // resolves the credential itself via requireProcessEnv(cfg.tokenEnv), so an accessor
    // would never be called; mapping renderEnvAccessor unconditionally would emit dead code.
    ...(isHand ? spec.env.map((e) => renderEnvAccessor(e)) : []),
    renderFetchHelper(spec),
    wiring(spec),
    isHand ? renderHandRolledTools(spec) : renderRestKitTools(spec),
    tail(spec),
  ].filter((s) => s.trim() !== "");

  return { path: ["src", "server.ts"], content: `${sections.join("\n\n")}\n` };
}
