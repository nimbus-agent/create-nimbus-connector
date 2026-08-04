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
 * The argument count is checked, not just the callee name — `new StdioServerTransport()`
 * always takes zero, per src/emit/server/index.ts's `wiring()`. This is deliberately NOT used
 * for the registrar const any more: that call's single argument is itself a call
 * (`createRegisterSimpleTool(mcp)`) whose own identity — the callee name and the mcp variable
 * it closes over — this function never looked at, so `createZodToolRegistrar(unrelated)`
 * passed it on argument COUNT alone. See `isRegistrarConst` below.
 */
function isConstFrom(node: AstNode, callee: string, expectedArgs: number): boolean {
  if (node.type !== "VariableDeclaration") return false;
  const init = (node["declarations"] as AstNode[])[0]?.["init"] as AstNode | undefined;
  if (init?.type !== "CallExpression" && init?.type !== "NewExpression") return false;
  const args = (init["arguments"] as AstNode[]) ?? [];
  if (args.length !== expectedArgs) return false;
  return (init["callee"] as AstNode)["name"] === callee;
}

/**
 * `const <x> = createZodToolRegistrar(createRegisterSimpleTool(<mcpVar>));` — the registrar
 * const, checked all the way down to the identity of its argument's argument.
 *
 * `isConstFrom(node, "createZodToolRegistrar", 1)` alone accepted ANY single-argument call to
 * that name — `createZodToolRegistrar(unrelated)` claimed the statement just as readily as the
 * real shape, because argument count is not argument identity. This requires the sole argument
 * to itself be a zero-ambiguity call to `createRegisterSimpleTool` whose own sole argument is
 * the exact `mcp` binding introduced by the `McpServer` const — the emitter never writes
 * anything else here.
 */
function isRegistrarConst(node: AstNode, mcpVar: string): boolean {
  // `let`/`var` both produce a VariableDeclaration node too — `node["kind"]` is what actually
  // distinguishes them from `const`. Without this check, `let reg = createZodToolRegistrar(...)`
  // passed every check below and was claimed as the documented `const` frame (see
  // recognizeFrame's docstring, element 3), which is a shape src/emit/server/index.ts's
  // `wiring()` never emits.
  if (node.type !== "VariableDeclaration" || node["kind"] !== "const") return false;
  const init = (node["declarations"] as AstNode[])[0]?.["init"] as AstNode | undefined;
  if (init?.type !== "CallExpression") return false;
  const outerCallee = init["callee"] as AstNode;
  if (outerCallee.type !== "Identifier" || outerCallee["name"] !== "createZodToolRegistrar") {
    return false;
  }
  const outerArgs = (init["arguments"] as AstNode[]) ?? [];
  if (outerArgs.length !== 1) return false;

  const inner = outerArgs[0] as AstNode;
  if (inner.type !== "CallExpression") return false;
  const innerCallee = inner["callee"] as AstNode;
  if (innerCallee.type !== "Identifier" || innerCallee["name"] !== "createRegisterSimpleTool") {
    return false;
  }
  const innerArgs = (inner["arguments"] as AstNode[]) ?? [];
  if (innerArgs.length !== 1) return false;
  const innerArg = innerArgs[0] as AstNode;
  return innerArg.type === "Identifier" && innerArg["name"] === mcpVar;
}

/**
 * `const <x> = new StdioServerTransport();` — the transport const's OWN variable name, read off
 * alongside the shape `isConstFrom` already verifies. Needed so `isConnect` can require the
 * connect call's argument to be that exact binding rather than any identifier at all.
 */
function transportVarName(node: AstNode): string | undefined {
  if (!isConstFrom(node, "StdioServerTransport", 0)) return undefined;
  const id = (node["declarations"] as AstNode[])[0]?.["id"] as AstNode | undefined;
  return id?.type === "Identifier" ? String(id["name"]) : undefined;
}

/**
 * `await <mcpVar>.connect(<transportVar>);` — both identities checked, not just the receiver.
 *
 * Previously this verified only that the receiver was the `mcp` binding and the property name
 * was `connect`, never looking at the call's argument at all — `await mcp.connect(other)`
 * claimed the statement just as readily as the real one. `connect()` always takes exactly the
 * transport const introduced two statements earlier, per src/emit/server/index.ts's `wiring()`.
 */
function isConnect(node: AstNode, mcpVar: string, transportVar: string): boolean {
  if (node.type !== "ExpressionStatement") return false;
  const await_ = node["expression"] as AstNode;
  if (await_.type !== "AwaitExpression") return false;
  const call = await_["argument"] as AstNode;
  if (call.type !== "CallExpression") return false;
  const callee = call["callee"] as AstNode;
  if (callee.type !== "MemberExpression") return false;
  // A computed member (`mcp[connect](transport)`) can have an Identifier `property` too — it's
  // the KEY variable's name, not a property name. Reading it unguarded would accept
  // `await mcp[connect](transport)` as `await mcp.connect(transport)` whenever the index
  // variable happened to be named "connect". args.ts:53 and path-template.ts's
  // argNameFromExpr guard this exact hazard already; this is the same guard here.
  if (callee["computed"] === true) return false;
  const receiver = callee["object"] as AstNode;
  if (receiver.type !== "Identifier" || receiver["name"] !== mcpVar) return false;
  if ((callee["property"] as AstNode)["name"] !== "connect") return false;
  const args = (call["arguments"] as AstNode[]) ?? [];
  if (args.length !== 1) return false;
  const arg = args[0] as AstNode;
  return arg.type === "Identifier" && arg["name"] === transportVar;
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

  // (3) Find registrar const (REQUIRED): createZodToolRegistrar(createRegisterSimpleTool(mcp)),
  // with mcp the exact variable bound in (2).
  const registrarNode = statements.find((s) => isRegistrarConst(s, mcpVar));
  if (!registrarNode) return undefined;

  // (4) Find transport const (REQUIRED): new StdioServerTransport(), taking its variable name
  // so (5) can require the connect call's argument to be this exact binding.
  const transportNode = statements.find((s) => transportVarName(s) !== undefined);
  if (!transportNode) return undefined;
  const transportVar = transportVarName(transportNode);
  if (transportVar === undefined) return undefined;

  // (5) Find connect call with the correct mcp variable AND the correct transport variable
  // (REQUIRED).
  const connectNode = statements.find((s) => isConnect(s, mcpVar, transportVar));
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
