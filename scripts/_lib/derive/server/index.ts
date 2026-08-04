import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  arrowFn,
  awaited,
  blockBody,
  callTo,
  constDecl,
  expressionOf,
  identName,
  ifStatement,
  importSource,
  isIdent,
  methodCallTo,
  newOf,
  objectProps,
  stringLit,
} from "../read.ts";
import type { Frame, FrameStyle } from "./frame.ts";

const FRAME_IMPORTS = new Set([
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "zod",
]);

/**
 * The leading slash is load-bearing, not incidental: it makes this a path-SEGMENT match rather
 * than a substring one, so a hypothetical "my-run-read-only-mcp-connector.ts" cannot satisfy it.
 * `hasMcpToolKitImport` uses the same "/mcp-tool-kit.ts" form for the same reason. The emitter
 * writes exactly "../../shared/run-read-only-mcp-connector.ts" (RUN_READ_ONLY in
 * src/emit/server/index.ts), so there is no slashless case to accommodate — and widening to
 * accommodate one that cannot occur only widens what gets claimed.
 */
const RUN_READ_ONLY_SUFFIX = "/run-read-only-mcp-connector.ts";

function isFrameImport(node: AstNode): boolean {
  const source = importSource(node);
  if (source === undefined) return false;
  return (
    FRAME_IMPORTS.has(source) ||
    source.endsWith("/mcp-tool-kit.ts") ||
    source.endsWith(RUN_READ_ONLY_SUFFIX)
  );
}

/**
 * `await runReadOnlyMcpConnector("nimbus-<name>", (reg) => { ... });`
 *
 * Every part is pinned, because this statement is VERIFIED and never CLAIMED (see frame.ts):
 * the await, the callee identity, arity 2, the "nimbus-" prefixed string literal, a
 * single-parameter arrow named exactly `reg`, a block body, and — not async.
 * src/emit/server/index.ts's `renderTools` writes only `(reg) => {`, never `async (reg) => {`,
 * and no corpus connector uses the async form either, so refusing it is lossless: accepting it
 * would make "every part is pinned" false for a shape this emitter cannot produce. Returning the
 * body statements is what lets deriveSpec swap this one statement for its children in
 * verifyStatements.
 */
function readOnlyWrapper(node: AstNode): { name: string; body: AstNode[] } | undefined {
  const args = callTo(awaited(expressionOf(node)), "runReadOnlyMcpConnector", 2);
  if (args === undefined) return undefined;

  const full = stringLit(args[0]);
  if (full === undefined || !full.startsWith("nimbus-")) return undefined;

  const arrow = arrowFn(args[1]);
  if (arrow === undefined || arrow.params.length !== 1 || arrow.isAsync) return undefined;
  if (!isIdent(arrow.params[0], "reg")) return undefined;
  const body = blockBody(arrow.body);
  if (body === undefined) return undefined;

  return { name: full.slice("nimbus-".length), body };
}

/**
 * The read-only-kit frame: no `McpServer`, no transport, no registrar const — every
 * registration lives inside `await runReadOnlyMcpConnector("nimbus-<name>", (reg) => { ... })`.
 *
 * Returns undefined and claims NOTHING when the module is not this frame, for the same reason
 * the hand-rolled recognizer below does: a partially claimed module reports blockers that read
 * as a spec-language gap when they are really a wrong-recognizer gap.
 *
 * See frame.ts's docstring for why the wrapper itself is verified but never claimed.
 */
function recognizeReadOnlyFrame(
  statements: readonly AstNode[],
  claims: ClaimSet,
): Frame | undefined {
  const runImport = statements.find(
    (s) => importSource(s)?.endsWith(RUN_READ_ONLY_SUFFIX) === true,
  );
  if (runImport === undefined) return undefined;

  let wrapper: AstNode | undefined;
  let recognized: { name: string; body: AstNode[] } | undefined;
  for (const statement of statements) {
    const match = readOnlyWrapper(statement);
    if (match === undefined) continue;
    // Two wrappers is a shape the emitter never writes; refuse rather than pick one.
    if (wrapper !== undefined) return undefined;
    wrapper = statement;
    recognized = match;
  }
  if (wrapper === undefined || recognized === undefined) return undefined;

  // Claim the frame's IMPORTS only. The wrapper is deliberately absent from this list: claiming
  // it would cover every registration inside it by containment.
  const frameImports = statements.filter((s) => isFrameImport(s) || s === runImport);
  claims.claim(frameImports, "frame");

  // Exactly one statement is swapped — the wrapper, for its body. Everything else stays.
  const verifyStatements = statements.flatMap((s) => (s === wrapper ? recognized.body : [s]));

  return {
    name: recognized.name,
    style: "read-only-kit",
    toolStatements: recognized.body,
    verifyStatements,
  };
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
 * The rest-kit-specific import, checked with the same path-SEGMENT rule `RUN_READ_ONLY_SUFFIX`
 * documents above rather than a plain string match — a hypothetical "my-run-rest-tool-kit.ts"
 * must not satisfy it. The emitter writes exactly "../../shared/rest-tool-kit.ts"
 * (src/emit/server/index.ts's `imports`), so a slashless check would only widen what gets
 * claimed.
 */
const REST_TOOL_KIT_SUFFIX = "/rest-tool-kit.ts";

function hasRestToolKitImport(node: AstNode): boolean {
  const source = importSource(node);
  return source?.endsWith(REST_TOOL_KIT_SUFFIX) === true;
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
 * The hand-rolled prologue and epilogue, as src/emit/server/index.ts writes them — shared with
 * rest-kit, which wiring() emits identically (see its `v = style === "hand-rolled" ? "mcp" :
 * "server"`): only the McpServer binding's own name differs, and this recognizer already reads
 * that off the node rather than assuming "mcp", so no change was needed for rest-kit to match
 * here too.
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
 *
 * A sixth, optional element decides which of the two styles this is: an import from
 * /rest-tool-kit.ts. Present -> "rest-kit" (imports() in src/emit/server/index.ts emits BOTH
 * the mcp-tool-kit.ts import, for wiring(), and this one, for the tool registrar factory).
 * Absent -> "hand-rolled". Frame recognition says nothing about whether the TOOLS inside are
 * understood — that is `deriveSpec`'s job, dispatching on `style` to recognizeTools or
 * recognizeRestTools.
 */
export function recognizeFrame(
  statements: readonly AstNode[],
  claims: ClaimSet,
): Frame | undefined {
  // read-only-kit has no McpServer const, so a module cannot match both this and the
  // hand-rolled shape below — but trying the cheap unambiguous discriminator first keeps the
  // two frames' failure modes separate rather than falling through hand-rolled's five checks.
  const readOnly = recognizeReadOnlyFrame(statements, claims);
  if (readOnly !== undefined) return readOnly;

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

  // (6) The rest-kit discriminator (OPTIONAL): present -> "rest-kit", claimed alongside the
  // other five; absent -> "hand-rolled". `isFrameImport` deliberately does not match this
  // suffix, so it is never claimed twice through `optionalFrameImports` below.
  const restToolKitImport = statements.find(hasRestToolKitImport);
  const style: FrameStyle = restToolKitImport === undefined ? "hand-rolled" : "rest-kit";

  // Gather optional frame imports (does not affect recognition, but are claimed when present).
  const optionalFrameImports = statements.filter((s) => isFrameImport(s) && s !== toolKitImport);

  // All five required elements found. Claim them, all optional frame imports, and the rest-kit
  // discriminator when present.
  const framesToClaim = [
    toolKitImport,
    mcpServerNode,
    registrarNode,
    transportNode,
    connectNode,
    ...optionalFrameImports,
    ...(restToolKitImport === undefined ? [] : [restToolKitImport]),
  ];
  claims.claim(framesToClaim, "frame");
  return {
    name: connectorName,
    style,
    toolStatements: statements,
    verifyStatements: statements,
  };
}

/**
 * `await runReadOnlyMcpConnector("nimbus-<name>", <identifier>);` — the read-only-kit near miss:
 * every part of `readOnlyWrapper` matches except the callback, which is a bare identifier (a
 * named function reference) rather than an inline `(reg) => { ... }` arrow.
 *
 * Ten corpus connectors write exactly this — `argocd`, `bigeye`, `flux`, `looker`, `mlflow`,
 * `monte-carlo`, `powerbi`, `snowflake`, `tableau`, `workday` — passing an already-declared
 * `function registerXTools(reg) { ... }` by name instead of inlining it at the call site. This is
 * why Task 4's read-only-kit frame moved 50 connectors rather than the ~60 predicted: the
 * shortfall is exactly this shape. `readOnlyWrapper` refuses it (its arrow-fn check is a claim,
 * so it cannot be loosened — see this module's docstring for that function), but naming it here
 * costs nothing, because this function only labels, never claims.
 */
function isNamedReadOnlyCallback(node: AstNode): boolean {
  const args = callTo(awaited(expressionOf(node)), "runReadOnlyMcpConnector", 2);
  if (args === undefined) return false;
  const full = stringLit(args[0]);
  if (full === undefined || !full.startsWith("nimbus-")) return false;
  return identName(args[1]) !== undefined;
}

/**
 * `statements`, plus — for every top-level `if (...) { ... }` — that `if`'s own consequent
 * block spliced in too.
 *
 * All ten `frame:readonly-callback-not-inline` corpus connectors gate their call behind
 * `if (import.meta.main) { await runReadOnlyMcpConnector(...) }`, a "only run when executed
 * directly" idiom `recognizeReadOnlyFrame` does not look inside — its top-level scan is a CLAIM
 * (see its docstring on why a partially-claimed module is worse than an unrecognized one), and
 * widening it to reach one statement inside an arbitrary `if` would risk claiming code the
 * emitter cannot reproduce the surrounding shape of. This function exists only so the LABEL can
 * see one level deeper than the claim does — nothing here is pinned to `import.meta.main`
 * specifically (checking a MetaProperty precisely would need its own read.ts accessor for a
 * fact this diagnostic does not need to be exact about), because a label may be more permissive
 * than a recognizer.
 */
function withTopLevelIfBodies(statements: readonly AstNode[]): AstNode[] {
  const out: AstNode[] = [];
  for (const statement of statements) {
    out.push(statement);
    const parts = ifStatement(statement);
    const body = parts === undefined ? undefined : blockBody(parts.consequent);
    if (body !== undefined) out.push(...body);
  }
  return out;
}

/**
 * `const <x> = createZodToolRegistrar(<identifier>);` — the registrar near miss: the outer call
 * is right, but its argument is a bare identifier rather than the inlined
 * `createRegisterSimpleTool(<mcpVar>)` call `isRegistrarConst` requires. Eleven corpus connectors
 * write exactly this — `discord`, `github`, and (found only by reading the nine hand-rolled
 * connectors Task 6 was asked to investigate rather than assumed) `bitbucket`, `confluence`,
 * `gitlab`, `jira`, `linear`, `notion`, `obsidian`, `slack`, `teams` — hoisting
 * `createRegisterSimpleTool(mcp)` to its own `const registerSimpleTool = ...;` one line above.
 *
 * Deliberately does not check the identifier's NAME (`registerSimpleTool` in every corpus
 * instance) — see this module's header on labels being allowed more leniency than claims: this
 * function never claims the statement, so pinning a name that a hypothetical differently-named
 * two-line split would fail to match would only make the diagnostic wrong, not the recognizer.
 */
function isBareIdentifierRegistrar(node: AstNode): boolean {
  const decl = constDecl(node);
  const outerArgs = callTo(decl?.init, "createZodToolRegistrar", 1);
  return outerArgs !== undefined && identName(outerArgs[0]) !== undefined;
}

/**
 * `await <mcpVar>.connect(new StdioServerTransport());` — the transport near miss: the connect
 * call is right, but the transport is constructed inline rather than bound to its own const
 * `transportVarName` requires. Six corpus connectors write exactly this — `gmail`, `google-meet`,
 * `google-photos`, `onedrive`, `outlook`, and `google-drive` (found the same way as the registrar
 * near miss above: by reading the source, not by assuming the original three-axis count was
 * complete).
 */
function isInlinedTransportConnect(node: AstNode, mcpVar: string): boolean {
  const call = awaited(expressionOf(node));
  const args = methodCallTo(call, mcpVar, "connect", 1);
  return args !== undefined && newOf(args[0], "StdioServerTransport", 0) !== undefined;
}

/**
 * Names the frame element that blocked a module `recognizeFrame` refused, for the histogram
 * only — never called when `recognizeFrame` succeeded, and never used to claim anything. This is
 * why it may be more permissive than a recognizer (see read.ts's label-only section): a wrong
 * LABEL misdescribes a bucket, but a wrong CLAIM misdescribes what the emitter can reproduce, and
 * only the latter is the defect this codebase guards against.
 *
 * Re-runs the read-only-kit discriminator first (the two frames are mutually exclusive — see
 * `recognizeFrame`'s docstring), searching one level inside a top-level `if` too (see
 * `withTopLevelIfBodies`) so the ten `if (import.meta.main) { ... }`-gated connectors this axis
 * covers are still found — then the five hand-rolled/rest-kit elements in the same order
 * `recognizeFrame` checks them, stopping at the first that fails. Two of those five carry a
 * near-miss check of their own, run only once the strict form is absent: a module can be BOTH
 * "no registrar const recognized" and "a bare-identifier registrar const exists" is never true at
 * once, because the strict check in `recognizeFrame` above already accepts the inlined form.
 *
 * `apple`, `fastmail`, `imap` and `protonmail` land on the plain `frame:no-registrar` here, not a
 * near miss: none of them calls `createZodToolRegistrar` at all — each registers its tools
 * through a single hand-authored `registerXTools(server, ...)` call instead, a shape this
 * function does not try to name more specifically because doing so would require modeling that
 * call, which is `deriveSpec`'s job downstream of frame recognition, not frame recognition's.
 */
export function frameFailureKind(statements: readonly AstNode[]): string {
  const runImport = statements.find(
    (s) => importSource(s)?.endsWith(RUN_READ_ONLY_SUFFIX) === true,
  );
  if (runImport !== undefined && withTopLevelIfBodies(statements).some(isNamedReadOnlyCallback)) {
    return "frame:readonly-callback-not-inline";
  }

  const toolKitImport = statements.find(hasMcpToolKitImport);
  if (toolKitImport === undefined) return "frame:no-kit-import";

  const mcpInfo = statements.map(getMcpServerInfo).find((info) => info !== undefined);
  if (mcpInfo === undefined) return "frame:no-mcp-server";
  const { varName: mcpVar } = mcpInfo;

  const registrarNode = statements.find((s) => isRegistrarConst(s, mcpVar));
  if (registrarNode === undefined) {
    return statements.some(isBareIdentifierRegistrar)
      ? "frame:registrar-not-inlined"
      : "frame:no-registrar";
  }

  const transportVar = statements.map(transportVarName).find((v) => v !== undefined);
  if (transportVar === undefined) {
    return statements.some((s) => isInlinedTransportConnect(s, mcpVar))
      ? "frame:tail-inlined-transport"
      : "frame:no-transport";
  }

  const connectNode = statements.find((s) => isConnect(s, mcpVar, transportVar));
  if (connectNode === undefined) return "frame:no-connect";

  return "frame:unrecognized";
}
