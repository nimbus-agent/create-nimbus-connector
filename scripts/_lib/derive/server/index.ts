import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  awaited,
  callTo,
  constDecl,
  expressionOf,
  importSource,
  isIdent,
  methodCallTo,
  newOf,
  objectProps,
  stringLit,
} from "../read.ts";

export type FrameFields = { name: string };

const FRAME_IMPORTS = new Set([
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "zod",
]);

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
 *
 * `constDecl` carries the `kind === "const"` guard this used to check by hand — `let`/`var` both
 * produce a VariableDeclaration node too, and without it `let mcp = new McpServer(...)` passed
 * every check below and was claimed as the documented `const` frame, the same gap
 * `isRegistrarConst` closed for the registrar const (see its comment below).
 */
function getMcpServerInfo(node: AstNode): { varName: string; connectorName: string } | undefined {
  const decl = constDecl(node);
  if (decl === undefined) return undefined;
  const args = newOf(decl.init, "McpServer", 1);
  if (args === undefined) return undefined;
  const props = objectProps(args[0]);
  if (props === undefined || props.length !== 2) return undefined;

  const [nameProp, versionProp] = props;
  const full = nameProp === undefined ? undefined : stringLit(nameProp.value);
  if (nameProp?.key !== "name" || full === undefined) return undefined;
  if (versionProp?.key !== "version" || stringLit(versionProp.value) !== "0.1.0") return undefined;

  const connectorName = full.startsWith("nimbus-") ? full.slice("nimbus-".length) : full;
  return { varName: decl.name, connectorName };
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
 *
 * `constDecl` also carries the same `let`/`var` gap `isRegistrarConst` closes, here for the
 * transport const: without it, `let transport = new StdioServerTransport()` passed every check
 * below and was claimed as the documented `const` frame.
 */
function isConstFrom(node: AstNode, callee: string, expectedArgs: number): boolean {
  const decl = constDecl(node);
  if (decl === undefined) return false;
  return (
    callTo(decl.init, callee, expectedArgs) !== undefined ||
    newOf(decl.init, callee, expectedArgs) !== undefined
  );
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
 *
 * `constDecl` carries the `kind === "const"` guard this used to check by hand: without it,
 * `let reg = createZodToolRegistrar(...)` passed every check below and was claimed as the
 * documented `const` frame (see `recognizeFrame`'s docstring, element 3), which is a shape
 * src/emit/server/index.ts's `wiring()` never emits.
 */
function isRegistrarConst(node: AstNode, mcpVar: string): boolean {
  const decl = constDecl(node);
  const outerArgs = callTo(decl?.init, "createZodToolRegistrar", 1);
  if (outerArgs === undefined) return false;
  const innerArgs = callTo(outerArgs[0], "createRegisterSimpleTool", 1);
  if (innerArgs === undefined) return false;
  return isIdent(innerArgs[0], mcpVar);
}

/**
 * `const <x> = new StdioServerTransport();` — the transport const's OWN variable name, read off
 * alongside the shape `isConstFrom` already verifies. Needed so `isConnect` can require the
 * connect call's argument to be that exact binding rather than any identifier at all.
 */
function transportVarName(node: AstNode): string | undefined {
  if (!isConstFrom(node, "StdioServerTransport", 0)) return undefined;
  return constDecl(node)?.name;
}

/**
 * `await <mcpVar>.connect(<transportVar>);` — both identities checked, not just the receiver.
 *
 * Previously this verified only that the receiver was the `mcp` binding and the property name
 * was `connect`, never looking at the call's argument at all — `await mcp.connect(other)`
 * claimed the statement just as readily as the real one. `connect()` always takes exactly the
 * transport const introduced two statements earlier, per src/emit/server/index.ts's `wiring()`.
 * `methodCallTo` carries the same computed-member guard this used to check by hand: a computed
 * member (`mcp[connect](transport)`) has an Identifier `property` too — it's the KEY variable's
 * name, not a property name — so an unguarded read would accept `await mcp[connect](transport)`
 * as `await mcp.connect(transport)` whenever the index variable happened to be named "connect".
 */
function isConnect(node: AstNode, mcpVar: string, transportVar: string): boolean {
  const call = awaited(expressionOf(node));
  const args = methodCallTo(call, mcpVar, "connect", 1);
  return args !== undefined && isIdent(args[0], transportVar);
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
