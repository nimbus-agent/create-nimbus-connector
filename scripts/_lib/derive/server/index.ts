import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";

export type FrameFields = { name: string };

const FRAME_IMPORTS = new Set([
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "zod",
]);

function importSource(node: AstNode): string | undefined {
  if (node.type !== "ImportDeclaration") return undefined;
  return String((node["source"] as AstNode | undefined)?.["value"] ?? "");
}

function isFrameImport(node: AstNode): boolean {
  const source = importSource(node);
  if (source === undefined) return false;
  return FRAME_IMPORTS.has(source) || source.endsWith("/mcp-tool-kit.ts");
}

/** `new McpServer({ name: "nimbus-<name>", … })` -> `{ varName, connectorName }`. */
function getMcpServerInfo(node: AstNode): { varName: string; connectorName: string } | undefined {
  if (node.type !== "VariableDeclaration") return undefined;
  const varName = ((node["declarations"] as AstNode[])[0]?.["id"] as AstNode)?.["name"];
  if (typeof varName !== "string") return undefined;

  const init = (node["declarations"] as AstNode[])[0]?.["init"] as AstNode | undefined;
  if (init?.type !== "NewExpression") return undefined;
  const callee = init["callee"] as AstNode;
  if (callee.type !== "Identifier" || callee["name"] !== "McpServer") return undefined;
  const arg = (init["arguments"] as AstNode[])[0];
  const properties = (arg?.["properties"] as AstNode[] | undefined) ?? [];
  for (const p of properties) {
    const key = p["key"] as AstNode | undefined;
    const value = p["value"] as AstNode | undefined;
    if (key?.["name"] === "name" && typeof value?.["value"] === "string") {
      const full = value["value"];
      const connectorName = full.startsWith("nimbus-") ? full.slice("nimbus-".length) : full;
      return { varName, connectorName };
    }
  }
  return undefined;
}

function hasMcpToolKitImport(node: AstNode): boolean {
  const source = importSource(node);
  return source?.endsWith("/mcp-tool-kit.ts") === true;
}

function isConstFrom(node: AstNode, callee: string): boolean {
  if (node.type !== "VariableDeclaration") return false;
  const init = (node["declarations"] as AstNode[])[0]?.["init"] as AstNode | undefined;
  if (init?.type === "CallExpression") {
    return (init["callee"] as AstNode)["name"] === callee;
  }
  if (init?.type === "NewExpression") {
    return (init["callee"] as AstNode)["name"] === callee;
  }
  return false;
}

/** `await <mcpVar>.connect(transport);` where mcpVar matches the McpServer const's variable name. */
function isConnect(node: AstNode, mcpVar: string): boolean {
  if (node.type !== "ExpressionStatement") return false;
  const await_ = node["expression"] as AstNode;
  if (await_.type !== "AwaitExpression") return false;
  const call = await_["argument"] as AstNode;
  if (call.type !== "CallExpression") return false;
  const callee = call["callee"] as AstNode;
  if (callee.type !== "MemberExpression") return false;
  const receiver = callee["object"] as AstNode;
  return (
    receiver.type === "Identifier" &&
    receiver["name"] === mcpVar &&
    (callee["property"] as AstNode)["name"] === "connect"
  );
}

/**
 * The hand-rolled prologue and epilogue, as src/emit/server/index.ts writes them.
 *
 * Returns undefined and claims NOTHING when the module is not this frame — a partially claimed
 * module would leave the totality rule reporting blockers for statements a different style's
 * recognizer would have claimed, which reads as a spec-language gap when it is a
 * wrong-recognizer gap. All or nothing is what keeps the histogram honest.
 *
 * Requires all five frame elements:
 * 1. An import from /mcp-tool-kit.ts
 * 2. const mcp = new McpServer({ name: "nimbus-<name>", ... })
 * 3. const reg = createZodToolRegistrar(...)
 * 4. const transport = new StdioServerTransport()
 * 5. await mcp.connect(transport) — receiver must be the same variable from (2)
 */
export function recognizeFrame(
  statements: readonly AstNode[],
  claims: ClaimSet,
): FrameFields | undefined {
  // (1) Find mcp-tool-kit.ts import (REQUIRED).
  const toolKitImport = statements.find(hasMcpToolKitImport);
  if (!toolKitImport) return undefined;

  // (2) Find McpServer const with variable name and connector name (REQUIRED).
  const mcpServerNode = statements.find((s) => getMcpServerInfo(s) !== undefined);
  if (!mcpServerNode) return undefined;
  const mcpInfo = getMcpServerInfo(mcpServerNode);
  if (!mcpInfo) return undefined;
  const { varName: mcpVar, connectorName } = mcpInfo;

  // (3) Find registrar const (REQUIRED).
  const registrarNode = statements.find((s) => isConstFrom(s, "createZodToolRegistrar"));
  if (!registrarNode) return undefined;

  // (4) Find transport const (REQUIRED).
  const transportNode = statements.find((s) => isConstFrom(s, "StdioServerTransport"));
  if (!transportNode) return undefined;

  // (5) Find connect call with the correct mcp variable (REQUIRED).
  const connectNode = statements.find((s) => isConnect(s, mcpVar));
  if (!connectNode) return undefined;

  // Gather optional frame imports (does not affect recognition, but are claimed when present).
  const optionalFrameImports = statements.filter((s) => isFrameImport(s) && s !== toolKitImport);

  // All five required elements found. Claim them and all optional frame imports.
  const framesToClaim = [
    toolKitImport,
    mcpServerNode,
    registrarNode,
    transportNode,
    connectNode,
    ...optionalFrameImports,
  ];
  claims.claim(framesToClaim, "frame");
  return { name: connectorName };
}
