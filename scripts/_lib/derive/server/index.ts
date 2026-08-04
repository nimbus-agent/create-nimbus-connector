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

/**
 * `new McpServer({ name: "nimbus-<name>", version: "0.1.0" })` -> `{ varName, connectorName }`.
 *
 * Pinned to exactly the two properties `wiring()` in src/emit/server/index.ts writes, in that
 * order, with `version` checked against the literal "0.1.0" it always emits — not merely
 * "some `name` property is present, ignore the rest". A wholesale `version: "2.4.1"` swap or an
 * added third property (a `capabilities` block, say) is a shape this emitter never writes, and
 * must be rejected rather than accepted on the strength of the `name` property alone.
 */
function getMcpServerInfo(node: AstNode): { varName: string; connectorName: string } | undefined {
  if (node.type !== "VariableDeclaration") return undefined;
  const varName = ((node["declarations"] as AstNode[])[0]?.["id"] as AstNode)?.["name"];
  if (typeof varName !== "string") return undefined;

  const init = (node["declarations"] as AstNode[])[0]?.["init"] as AstNode | undefined;
  if (init?.type !== "NewExpression") return undefined;
  const callee = init["callee"] as AstNode;
  if (callee.type !== "Identifier" || callee["name"] !== "McpServer") return undefined;
  const args = (init["arguments"] as AstNode[]) ?? [];
  if (args.length !== 1) return undefined;
  const arg = args[0] as AstNode;
  if (arg.type !== "ObjectExpression") return undefined;
  const properties = (arg["properties"] as AstNode[] | undefined) ?? [];
  if (properties.length !== 2) return undefined;
  if (properties.some((p) => p.type !== "ObjectProperty")) return undefined;

  const [nameProp, versionProp] = properties as [AstNode, AstNode];
  const nameKey = nameProp["key"] as AstNode;
  const nameValue = nameProp["value"] as AstNode;
  if (nameKey["name"] !== "name" || typeof nameValue["value"] !== "string") return undefined;
  const versionKey = versionProp["key"] as AstNode;
  const versionValue = versionProp["value"] as AstNode;
  if (versionKey["name"] !== "version" || versionValue["value"] !== "0.1.0") return undefined;

  const full = nameValue["value"] as string;
  const connectorName = full.startsWith("nimbus-") ? full.slice("nimbus-".length) : full;
  return { varName, connectorName };
}

function hasMcpToolKitImport(node: AstNode): boolean {
  const source = importSource(node);
  return source?.endsWith("/mcp-tool-kit.ts") === true;
}

/**
 * `const <x> = <callee>(...)` / `new <callee>(...)` with exactly `expectedArgs` arguments.
 *
 * The argument count is checked, not just the callee name: `createZodToolRegistrar(
 * createRegisterSimpleTool(mcp))` always takes exactly one argument and `new
 * StdioServerTransport()` always takes zero, per src/emit/server/index.ts's `wiring()`. An
 * extra argument — `createZodToolRegistrar(createRegisterSimpleTool(mcp), { strict: true })`,
 * say — is a call this emitter never writes, and accepting it on the callee name alone would
 * claim a statement whose actual behaviour this recognizer never verified.
 */
function isConstFrom(node: AstNode, callee: string, expectedArgs: number): boolean {
  if (node.type !== "VariableDeclaration") return false;
  const init = (node["declarations"] as AstNode[])[0]?.["init"] as AstNode | undefined;
  if (init?.type !== "CallExpression" && init?.type !== "NewExpression") return false;
  const args = (init["arguments"] as AstNode[]) ?? [];
  if (args.length !== expectedArgs) return false;
  return (init["callee"] as AstNode)["name"] === callee;
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

  // (3) Find registrar const (REQUIRED). createZodToolRegistrar(createRegisterSimpleTool(mcp))
  // always takes exactly one argument.
  const registrarNode = statements.find((s) => isConstFrom(s, "createZodToolRegistrar", 1));
  if (!registrarNode) return undefined;

  // (4) Find transport const (REQUIRED). new StdioServerTransport() always takes zero.
  const transportNode = statements.find((s) => isConstFrom(s, "StdioServerTransport", 0));
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
