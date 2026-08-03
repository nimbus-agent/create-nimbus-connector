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

/** `new McpServer({ name: "nimbus-<name>", … })` -> `<name>`. */
function mcpServerName(node: AstNode): string | undefined {
  if (node.type !== "VariableDeclaration") return undefined;
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
      return full.startsWith("nimbus-") ? full.slice("nimbus-".length) : full;
    }
  }
  return undefined;
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

/** `await mcp.connect(transport);` */
function isConnect(node: AstNode): boolean {
  if (node.type !== "ExpressionStatement") return false;
  const await_ = node["expression"] as AstNode;
  if (await_.type !== "AwaitExpression") return false;
  const call = await_["argument"] as AstNode;
  if (call.type !== "CallExpression") return false;
  const callee = call["callee"] as AstNode;
  return callee.type === "MemberExpression" && (callee["property"] as AstNode)["name"] === "connect";
}

/**
 * The hand-rolled prologue and epilogue, as src/emit/server/index.ts writes them.
 *
 * Returns undefined and claims NOTHING when the module is not this frame — a partially claimed
 * module would leave the totality rule reporting blockers for statements a different style's
 * recognizer would have claimed, which reads as a spec-language gap when it is a
 * wrong-recognizer gap. All or nothing is what keeps the histogram honest.
 */
export function recognizeFrame(
  statements: readonly AstNode[],
  claims: ClaimSet,
): FrameFields | undefined {
  const name = statements.map(mcpServerName).find((n) => n !== undefined);
  if (name === undefined) return undefined;

  const frame = statements.filter(
    (s) =>
      isFrameImport(s) ||
      mcpServerName(s) !== undefined ||
      isConstFrom(s, "createZodToolRegistrar") ||
      isConstFrom(s, "StdioServerTransport") ||
      isConnect(s),
  );
  claims.claim(frame, "frame");
  return { name };
}
