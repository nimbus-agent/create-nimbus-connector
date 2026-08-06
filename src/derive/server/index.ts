import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  arrowFn,
  awaited,
  blockBody,
  callArgs,
  calleeOf,
  callTo,
  constDecl,
  exportedDeclaration,
  expressionOf,
  functionBody,
  functionName,
  functionParams,
  identName,
  identTypeAnnotation,
  ifStatement,
  importNames,
  importSource,
  isAsyncFunction,
  isIdent,
  memberName,
  memberObject,
  metaPropertyNames,
  methodCallTo,
  newOf,
  objectProps,
  stringLit,
  typeAliasName,
  typeAnnotationName,
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

/**
 * Deliberately does NOT match `RUN_READ_ONLY_SUFFIX`. Widening it to do so let
 * `recognizeReadOnlyFrame`'s `optionalFrameImports` (below) claim a `run-read-only-mcp-connector.ts`
 * import on the hand-rolled/rest-kit path with nothing verifying a read-only wrapper actually
 * exists there — the emitter never co-emits that import for those two styles. The read-only-kit
 * frame claims it explicitly instead, scoped by `s === runImport` in `recognizeReadOnlyFrame`.
 */
function isFrameImport(node: AstNode): boolean {
  const source = importSource(node);
  if (source === undefined) return false;
  return FRAME_IMPORTS.has(source) || source.endsWith("/mcp-tool-kit.ts");
}

/**
 * The standalone target's single kit import. A SEPARATE predicate rather than a widened
 * `isFrameImport`: relaxing that one in place would change what the frame claims against the
 * AGPL corpus too, and this recognizer must not move a corpus number it has nothing to do with
 * — no corpus connector is standalone, so `reach`'s histogram is the tripwire for that leak.
 */
const STANDALONE_KIT = "@nimbus-dev/sdk/connector-kit";

function isStandaloneKitImport(node: AstNode): boolean {
  return importSource(node) === STANDALONE_KIT;
}

/**
 * The standalone read-only-kit target's inlined `async function runReadOnlyMcpConnector`
 * (src/emit/server/index.ts's `renderRunReadOnlyGlue`) — emitted at module scope because the
 * dependency-free SDK cannot re-export a helper that imports `@modelcontextprotocol/sdk`
 * directly. Matched by exact identifier, the same way `namedRegistrarBody` below matches the
 * registrar it was told to look for: a differently-named local async function is a shape this
 * emitter cannot produce, so accepting it would claim code this frame cannot verify.
 */
function isInlinedRunReadOnlyHelper(node: AstNode): boolean {
  return isAsyncFunction(node) && functionName(node) === "runReadOnlyMcpConnector";
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
  if (!full?.startsWith("nimbus-")) return undefined;

  const arrow = arrowFn(args[1]);
  if (arrow?.params.length !== 1 || arrow.isAsync) return undefined;
  if (!isIdent(arrow.params[0], "reg")) return undefined;
  const body = blockBody(arrow.body);
  if (body === undefined) return undefined;

  return { name: full.slice("nimbus-".length), body };
}

/**
 * `if (import.meta.main) await <name>();` -> "<name>" — the entrypoint guard the ten
 * named-registrar connectors close their file with.
 *
 * CLAIMED, so every part is pinned, including the test: `metaPropertyNames` (read.ts) settles
 * `import` and `meta` separately and `memberName` settles `.main`, rather than accepting any
 * condition at all on the strength of the consequent's shape. An earlier, LABEL-only version of
 * this idea (`withTopLevelIfBodies`, retired with `frame:readonly-callback-not-inline`)
 * deliberately did not check the test, which is correct for a diagnostic and wrong for a claim.
 * Zero arguments and the bare `await` are pinned for the same reason: `if (import.meta.main)
 * await startConnector(someOption);` is a shape no corpus connector writes, and claiming it would
 * grant coverage to an argument nothing verified.
 */
function entrypointGuardCallee(node: AstNode): string | undefined {
  const parts = ifStatement(node);
  if (parts === undefined || parts.alternate !== undefined) return undefined;
  const meta = metaPropertyNames(memberObject(parts.test));
  if (meta?.meta !== "import" || meta.property !== "meta") return undefined;
  if (memberName(parts.test) !== "main") return undefined;
  const call = awaited(expressionOf(parts.consequent));
  if (callArgs(call)?.length !== 0) return undefined;
  return identName(calleeOf(call));
}

/**
 * `export async function <starter>(): Promise<void> { await runReadOnlyMcpConnector("nimbus-<x>",
 * <register>); }` -> the three names it establishes.
 *
 * The near miss `readOnlyWrapper` above refuses: the second argument is a BARE FUNCTION REFERENCE
 * rather than an inline `(reg) => { … }` arrow, and the call sits inside a locally-declared
 * `startConnector` rather than at module scope. `startConnector` is defined in each connector, not
 * imported — six of the ten carry a two-line `//` comment above it and four do not, so nothing
 * here may discriminate on `hasLeadingComment`.
 *
 * Pinned to the same depth as `readOnlyWrapper`, because this statement IS claimed: exported,
 * `async`, zero parameters, a body of exactly ONE statement, the await, the callee identity, arity
 * 2, and the "nimbus-" prefixed literal. The single-statement body is the pin that matters most —
 * claiming the declaration grants coverage to its whole byte range, so a second statement inside
 * it would ride in unverified.
 */
function namedReadOnlyStarter(
  node: AstNode,
): { starter: string; name: string; register: string } | undefined {
  const decl = exportedDeclaration(node);
  if (!isAsyncFunction(decl)) return undefined;
  const starter = functionName(decl);
  if (starter === undefined || functionParams(decl)?.length !== 0) return undefined;
  const body = functionBody(decl);
  if (body?.length !== 1) return undefined;

  const args = callTo(awaited(expressionOf(body[0])), "runReadOnlyMcpConnector", 2);
  if (args === undefined) return undefined;
  const full = stringLit(args[0]);
  if (!full?.startsWith("nimbus-")) return undefined;
  const register = identName(args[1]);
  if (register === undefined) return undefined;

  return { starter, name: full.slice("nimbus-".length), register };
}

/**
 * `export function <name>(reg: ZodToolRegistrar): void { ... }` -> its BODY statements.
 *
 * `name` comes from what `namedReadOnlyStarter` observed being PASSED, never from a naming
 * convention: `register<X>Tools` is what all ten happen to spell it, but the fact this recognizer
 * needs is the structural link between the two statements, not the spelling of either.
 *
 * The parameter is pinned to exactly one, named `reg` and typed `ZodToolRegistrar` — the same
 * `(reg)` `readOnlyWrapper` pins on the inline arrow, and the name `recognizeTools`
 * (server/tools-hand.ts) searches its `reg(...)` calls for. Note what is NOT pinned: this
 * declaration is never claimed (see below and frame.ts), so being lenient here would not
 * over-claim — it is pinned because a body whose registrar is bound under a different name is a
 * body whose registrations the tool recognizers would silently fail to find.
 */
function namedRegistrarBody(node: AstNode, name: string): AstNode[] | undefined {
  const decl = exportedDeclaration(node);
  if (functionName(decl) !== name || isAsyncFunction(decl)) return undefined;
  const params = functionParams(decl);
  if (params?.length !== 1 || !isIdent(params[0], "reg")) return undefined;
  if (typeAnnotationName(identTypeAnnotation(params[0])) !== "ZodToolRegistrar") return undefined;
  return functionBody(decl);
}

/** What either read-only entry shape establishes: see `recognizeReadOnlyFrame`. */
type ReadOnlyEntry = {
  readonly name: string;
  /** The registrations — `toolStatements`, and what replaces `spliced` in `verifyStatements`. */
  readonly body: readonly AstNode[];
  /** The ONE statement removed from `verifyStatements`, and never claimed. */
  readonly spliced: AstNode;
  /** Statements this entry shape claims outright, beyond the frame's imports. */
  readonly claims: readonly AstNode[];
};

/**
 * The named-registrar entry shape — `argocd`, `bigeye`, `flux`, `looker`, `mlflow`,
 * `monte-carlo`, `powerbi`, `snowflake`, `tableau`, `workday` — as three top-level statements
 * instead of one.
 *
 * The two-list contract (frame.ts) governs this exactly as it governs the inline wrapper, and the
 * reasoning is the same one statement further out: `register<X>Tools`' body CONTAINS the
 * registrations, so claiming that declaration would cover every one of them by containment, the
 * totality rule would find nothing unclaimed, and a connector whose tools were never recognized
 * would derive successfully — a false `emits` produced by the very mechanism the rule exists to
 * remove. So the declaration is what gets removed from `verifyStatements` and replaced by its
 * body, and it is never claimed. Marking it claimed "once its body statements are" is the
 * obvious-looking alternative and is precisely the anti-pattern: coverage is containment, so that
 * claim is retroactive over everything inside it.
 *
 * `startConnector` and the `import.meta.main` guard ARE claimed, and there is no overlap hazard in
 * doing so: `startConnector`'s range contains the `runReadOnlyMcpConnector` call but NOT
 * `register<X>Tools`' body, so it covers nothing a tool recognizer needs to claim.
 *
 * Each of the three is required exactly once. Two starters, two matching declarations, or a guard
 * count other than one is a shape neither this emitter nor the corpus writes; refuse rather than
 * pick, same as the inline wrapper's own two-wrapper rule.
 */
function namedReadOnlyEntry(statements: readonly AstNode[]): ReadOnlyEntry | undefined {
  let starterNode: AstNode | undefined;
  let starter: { starter: string; name: string; register: string } | undefined;
  for (const statement of statements) {
    const match = namedReadOnlyStarter(statement);
    if (match === undefined) continue;
    if (starterNode !== undefined) return undefined;
    starterNode = statement;
    starter = match;
  }
  if (starterNode === undefined || starter === undefined) return undefined;

  let declaration: AstNode | undefined;
  let body: AstNode[] | undefined;
  for (const statement of statements) {
    const match = namedRegistrarBody(statement, starter.register);
    if (match === undefined) continue;
    if (declaration !== undefined) return undefined;
    declaration = statement;
    body = match;
  }
  if (declaration === undefined || body === undefined) return undefined;

  const guards = statements.filter((s) => entrypointGuardCallee(s) === starter.starter);
  const guard = guards[0];
  if (guards.length !== 1 || guard === undefined) return undefined;

  return { name: starter.name, body, spliced: declaration, claims: [starterNode, guard] };
}

/**
 * The read-only-kit frame: no `McpServer`, no transport, no registrar const — every
 * registration lives inside `await runReadOnlyMcpConnector("nimbus-<name>", (reg) => { ... })`.
 *
 * Two ways this discriminator is satisfied, one per target: the monorepo target imports
 * `runReadOnlyMcpConnector` from `../../shared/run-read-only-mcp-connector.ts` (`runImport`);
 * the standalone target cannot — the SDK core stays free of `@modelcontextprotocol/sdk`, which
 * that helper needs — so it inlines the function at module scope instead
 * (`isInlinedRunReadOnlyHelper`). Either is enough to enter this frame; a wrapper CALL is then
 * still required, in one of two shapes.
 *
 * The INLINE wrapper is what this generator emits, and it is tried first — the near-miss shape is
 * accepted only when the strict one is absent, so no module that already recognized changes
 * meaning. The second shape is the NAMED registrar `namedReadOnlyEntry` above reads: three
 * top-level statements, ten corpus connectors, a construct `renderTools` never writes (recorded
 * in docs/ROADMAP.md's *Shape variance the emitter models one way*, so those connectors reach
 * `emits` and never `server-identical`). Both end in the same `Frame`, so the branch is about
 * FINDING the registration body, not about what happens after it.
 *
 * Returns undefined and claims NOTHING when the module is not this frame, for the same reason
 * the hand-rolled recognizer below does: a partially claimed module reports blockers that read
 * as a spec-language gap when they are really a wrong-recognizer gap.
 *
 * See frame.ts's docstring for why the spliced statement — the wrapper, or the register
 * declaration — is verified but never claimed.
 */
function recognizeReadOnlyFrame(
  statements: readonly AstNode[],
  claims: ClaimSet,
): Frame | undefined {
  const runImport = statements.find(
    (s) => importSource(s)?.endsWith(RUN_READ_ONLY_SUFFIX) === true,
  );
  const inlinedHelper = statements.find(isInlinedRunReadOnlyHelper);
  if (runImport === undefined && inlinedHelper === undefined) return undefined;

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
  // The inline wrapper claims nothing of its own beyond the frame imports below — it is the
  // statement that gets SPLICED, and splicing is the opposite of claiming.
  const entry: ReadOnlyEntry | undefined =
    wrapper === undefined || recognized === undefined
      ? namedReadOnlyEntry(statements)
      : { name: recognized.name, body: recognized.body, spliced: wrapper, claims: [] };
  if (entry === undefined) return undefined;

  // Claim the frame's IMPORTS only. The wrapper is deliberately absent from this list: claiming
  // it would cover every registration inside it by containment. `s === runImport` is load-bearing
  // here, not redundant with `isFrameImport`: that predicate deliberately does not match
  // RUN_READ_ONLY_SUFFIX (see its own docstring), so this is the only place the run-read-only
  // import gets claimed, and only once this frame is already confirmed to exist. Likewise
  // `isStandaloneKitImport` is claimed here rather than folded into `isFrameImport` — see that
  // predicate's own docstring on why widening `isFrameImport` in place is the wrong fix.
  const frameImports = statements.filter(
    (s) => isFrameImport(s) || isStandaloneKitImport(s) || s === runImport,
  );
  // The inlined helper's own two statements, standalone only: the function declaration
  // `isInlinedRunReadOnlyHelper` found, and the `type ZodToolRegistrar` alias its signature
  // names (renderRunReadOnlyGlue emits both, always as this exact pair). Matched by name, same
  // as the function itself, so a differently-named alias is still an unclaimed blocker rather
  // than silently covered by proximity to the function.
  const inlinedGlue =
    inlinedHelper === undefined
      ? []
      : [inlinedHelper, ...statements.filter((s) => typeAliasName(s) === "ZodToolRegistrar")];
  claims.claim([...frameImports, ...inlinedGlue, ...entry.claims], "frame");

  // Exactly one statement is swapped — the wrapper (or, for the named form, the register
  // declaration), for its body. Everything else stays.
  const verifyStatements = statements.flatMap((s) => (s === entry.spliced ? entry.body : [s]));

  return {
    name: entry.name,
    style: "read-only-kit",
    toolStatements: entry.body,
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
  if (props?.length !== 2) return undefined;

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
 * The SPLIT registrar — two module-scope consts where `isRegistrarConst` above wants one nested
 * call — as the pair of statements to claim, or undefined when the module is not this shape:
 *
 *   const registerSimpleTool = createRegisterSimpleTool(<mcpVar>);
 *   const reg = createZodToolRegistrar(registerSimpleTool);
 *
 * Thirteen corpus connectors write it (`bitbucket`, `confluence`, `discord`, `github`, `gitlab`,
 * `google-meet`, `google-photos`, `jira`, `linear`, `notion`, `obsidian`, `slack`, `teams`),
 * hand-rolled and rest-kit alike; `wiring()` (src/emit/server/index.ts) writes only the nested
 * form, so a module in this one re-emits as the nested one — recorded in docs/ROADMAP.md's
 * *Shape variance the emitter models one way*.
 *
 * The intermediate binding is a `const` in all 13, never a `function` declaration, so `constDecl`
 * (which carries the `kind === "const"` guard) is the right reader for both halves. What links
 * them is IDENTITY, not layout: the outer call's sole argument must be the exact name the inner
 * const binds. Two things are deliberately not required. The literal name `registerSimpleTool`,
 * which every corpus instance happens to use — pinning it would be a claim about naming rather
 * than structure. And a blank line between the `McpServer` const and this pair: 12 of the 13 have
 * one and `obsidian` does not, and Biome preserves line breaks, so a layout pin would refuse a
 * connector on whitespace.
 */
function splitRegistrarConsts(
  statements: readonly AstNode[],
  mcpVar: string,
): AstNode[] | undefined {
  for (const inner of statements) {
    const innerDecl = constDecl(inner);
    if (innerDecl === undefined) continue;
    const innerArgs = callTo(innerDecl.init, "createRegisterSimpleTool", 1);
    if (innerArgs === undefined || !isIdent(innerArgs[0], mcpVar)) continue;

    const outer = statements.find((s) => {
      const outerArgs = callTo(constDecl(s)?.init, "createZodToolRegistrar", 1);
      return outerArgs !== undefined && isIdent(outerArgs[0], innerDecl.name);
    });
    if (outer !== undefined) return [inner, outer];
  }
  return undefined;
}

/**
 * `await <mcpVar>.connect(new StdioServerTransport());` — the INLINED transport tail, the file's
 * last statement with no transport const anywhere.
 *
 * **SIX corpus connectors write this shape, not four**, and the difference between the two numbers
 * is precedence rather than measurement. `gmail`, `google-drive`, `onedrive` and `outlook` were the
 * whole of the `frame:tail-inlined-transport` BUCKET, because `frameFailureKind` checks the
 * registrar element before the transport one and `google-meet` and `google-photos` — which write
 * the split registrar too — were reported on that earlier axis instead. Both still write this tail,
 * and now that both axes are recognized, this matcher is what carries them past element 5: they
 * have no transport const for `isConnect` to find. Four is a bucket size; six is the shape count,
 * and only the second is a fact about this function.
 *
 * Recorded at this length because the distinction was already established once and then lost: the
 * label-era docstring this replaced had the six right, and noted it was found "by reading the
 * source, not by assuming the original three-axis count was complete" — and the first rewrite of it
 * quietly restated the bucket's four. docs/ROADMAP.md's *Shape variance the emitter models one way*
 * states the "a connector may write both" relationship that makes the two numbers differ.
 *
 * Five of the six are rest-kit (`gmail`, `onedrive`, `outlook`, `google-meet`, `google-photos`);
 * `google-drive` is hand-rolled, declaring its own local `registerDriveTool` rather than importing
 * `makeRestToolRegistrar`. So the axis spans both styles, which is why `mcpVar` is a PARAMETER
 * here — `wiring()` binds `mcp` for hand-rolled and `server` for rest-kit — and why
 * test/derive/frame.test.ts proves this axis on `zzscratch` and `zzstandalone` both.
 *
 * Accepted only once the strict two-statement form is absent (see `recognizeFrame`, elements 4
 * and 5), so no module that already recognized changes meaning. `tail()` (src/emit/server/
 * index.ts) writes the named const, so a module in this shape re-emits with one.
 *
 * This used to be a LABEL (`frame:tail-inlined-transport`), where leniency was correct; it is a
 * CLAIM now, and every part was already pinned to claim depth: the await, the receiver's identity,
 * the property name through `methodCallTo`'s computed-member guard, arity 1, and the argument
 * being specifically a zero-argument `new StdioServerTransport()`.
 */
function isInlinedTransportConnect(node: AstNode, mcpVar: string): boolean {
  const call = awaited(expressionOf(node));
  const args = methodCallTo(call, mcpVar, "connect", 1);
  return args !== undefined && newOf(args[0], "StdioServerTransport", 0) !== undefined;
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
 * 1. An import from /mcp-tool-kit.ts (monorepo) OR "@nimbus-dev/sdk/connector-kit"
 *    (standalone) — the two names the same registrar primitives arrive under, per
 *    src/emit/server/index.ts's `imports()`.
 * 2. const mcp = new McpServer({ name: "nimbus-<name>", ... })
 * 3. const reg = createZodToolRegistrar(...) — OR the two-const SPLIT of it
 *    (`splitRegistrarConsts`), tried only once the nested form is absent
 * 4. const transport = new StdioServerTransport() — OPTIONAL, see (5)
 * 5. await mcp.connect(transport) — receiver must be the same variable from (2). When (4) is
 *    absent, the inlined form `await mcp.connect(new StdioServerTransport())` satisfies both
 *    elements at once (`isInlinedTransportConnect`)
 *
 * Elements 3 and 5 are the two case-2 widenings, and they had to land together: `google-meet` and
 * `google-photos` write BOTH near misses, and `frameFailureKind` checks the registrar element
 * before the transport one, so either alone would have left them blocked. In both, the strict
 * form is tried first and the near miss accepted only in its absence, so no module that already
 * recognized changes meaning.
 *
 * A sixth, optional element decides which of the two styles this is, one signal per target:
 * present -> "rest-kit", claimed alongside the other five; absent -> "hand-rolled". On the
 * monorepo target the signal is a second import, from /rest-tool-kit.ts (imports() emits BOTH
 * the mcp-tool-kit.ts import, for wiring(), and this one, for the tool registrar factory). On
 * the standalone target there is no second import — makeRestToolRegistrar is one more name
 * inside the SAME "@nimbus-dev/sdk/connector-kit" clause found in (1) — so the signal there is
 * that name's presence among the import's own specifiers. Frame recognition says nothing about
 * whether the TOOLS inside are understood — that is `deriveSpec`'s job, dispatching on `style`
 * to recognizeTools or recognizeRestTools.
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

  // (1) Find the tool-kit import (REQUIRED): monorepo's mcp-tool-kit.ts, or standalone's
  // "@nimbus-dev/sdk/connector-kit".
  const toolKitImport = statements.find((s) => hasMcpToolKitImport(s) || isStandaloneKitImport(s));
  if (!toolKitImport) return undefined;

  // (2) Find McpServer const with variable name and connector name (REQUIRED).
  const mcpServerNode = statements.find((s) => getMcpServerInfo(s) !== undefined);
  if (!mcpServerNode) return undefined;
  const mcpInfo = getMcpServerInfo(mcpServerNode);
  if (!mcpInfo) return undefined;
  const { varName: mcpVar, connectorName } = mcpInfo;

  // (3) Find the registrar (REQUIRED): the nested form
  // createZodToolRegistrar(createRegisterSimpleTool(mcp)) with mcp the exact variable bound in
  // (2), or — only in its absence — the two-const split, which claims BOTH statements.
  const registrarNode = statements.find((s) => isRegistrarConst(s, mcpVar));
  const splitRegistrar =
    registrarNode === undefined ? splitRegistrarConsts(statements, mcpVar) : undefined;
  const registrarNodes = registrarNode === undefined ? splitRegistrar : [registrarNode];
  if (registrarNodes === undefined) return undefined;

  // (4) Find transport const (OPTIONAL — see (5)): new StdioServerTransport(), taking its
  // variable name so (5) can require the connect call's argument to be this exact binding.
  const transportNode = statements.find((s) => transportVarName(s) !== undefined);
  const transportVar = transportNode === undefined ? undefined : transportVarName(transportNode);

  // (5) Find the connect call with the correct mcp variable AND — when (4) found a transport
  // const — the correct transport variable. With no transport const the tail must carry the
  // transport inline, which is the only way element 4 may be absent.
  const connectNode =
    transportVar === undefined
      ? statements.find((s) => isInlinedTransportConnect(s, mcpVar))
      : statements.find((s) => isConnect(s, mcpVar, transportVar));
  if (!connectNode) return undefined;

  // (6) The rest-kit discriminator (OPTIONAL) — see the docstring above for the two signals.
  // The standalone one is read off `toolKitImport` itself (gated on it actually being the
  // standalone kit import, so `importNames` is never asked to parse the monorepo's
  // mcp-tool-kit.ts clause, which never carries this name anyway); no separate claim is needed
  // for it, since that import is already claimed as `toolKitImport` below.
  const restToolKitImport = statements.find(hasRestToolKitImport);
  const standaloneKitNames = isStandaloneKitImport(toolKitImport)
    ? importNames(toolKitImport)
    : undefined;
  const hasStandaloneRestRegistrar =
    standaloneKitNames?.some((n) => n.imported === "makeRestToolRegistrar") === true;
  const style: FrameStyle =
    restToolKitImport === undefined && !hasStandaloneRestRegistrar ? "hand-rolled" : "rest-kit";

  // Gather optional frame imports (does not affect recognition, but are claimed when present).
  const optionalFrameImports = statements.filter((s) => isFrameImport(s) && s !== toolKitImport);

  // All five required elements found. Claim them, all optional frame imports, and the rest-kit
  // discriminator when present.
  const framesToClaim = [
    toolKitImport,
    mcpServerNode,
    ...registrarNodes,
    ...(transportNode === undefined ? [] : [transportNode]),
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
 * Names the frame element that blocked a module `recognizeFrame` refused, for the histogram
 * only — never called when `recognizeFrame` succeeded, and never used to claim anything. This is
 * why it may be more permissive than a recognizer (see read.ts's label-only section): a wrong
 * LABEL misdescribes a bucket, but a wrong CLAIM misdescribes what the emitter can reproduce, and
 * only the latter is the defect this codebase guards against.
 *
 * Walks the five hand-rolled/rest-kit elements in the same order `recognizeFrame` checks them,
 * stopping at the first that fails — and, since elements 3 and 5 now accept a second shape each,
 * accepting the same two here so this function never faults an element `recognizeFrame` was
 * satisfied by. That symmetry is what retired three buckets at once:
 *
 * - `frame:registrar-not-inlined` and `frame:tail-inlined-transport` named shapes that are
 *   RECOGNIZED now (`splitRegistrarConsts`, `isInlinedTransportConnect`), so labelling them would
 *   fault a construct that is no longer a fault. A module writing the split registrar and then
 *   breaking element 5 is reported on element 5.
 * - `frame:readonly-callback-not-inline` had already been dead for longer: upstream commit
 *   `b3a6f159` refactored the ten connectors it named into the three-statement shape
 *   `namedReadOnlyEntry` now reads, and the bucket has been absent from `bun run reach --verbose`'s
 *   histogram ever since — the two functions behind it (`isNamedReadOnlyCallback` and
 *   `withTopLevelIfBodies`, which spliced top-level `if` BODIES in to find a call those ten do not
 *   put there) were dead against the whole corpus, and that diagnostic never once printed. Its ten
 *   were reported as `frame:no-mcp-server`, which is the correct fault for the shape: it has no
 *   top-level `McpServer` const at all.
 *
 * There is deliberately no read-only-specific branch left. A read-only module this recognizer
 * refuses falls through to the elements below and is faulted on one of them, which is what those
 * ten already did.
 *
 * `apple`, `fastmail`, `imap` and `protonmail` land on `frame:no-registrar`: none of them calls
 * `createZodToolRegistrar` at all — each registers its tools through a single hand-authored
 * `registerXTools(server, ...)` call instead, a shape this function does not try to name more
 * specifically because doing so would require modeling that call, which is `deriveSpec`'s job
 * downstream of frame recognition, not frame recognition's.
 *
 * Element 1 is widened to the SAME two signals `recognizeFrame` accepts, not just the monorepo
 * one: this function used to check only `hasMcpToolKitImport`, so a standalone module (whose
 * frame element 1 is `isStandaloneKitImport`, never the monorepo import) that failed on a LATER
 * element was told "no kit import" — a label that sends the user to add an import already on line
 * 1. No corpus connector is standalone (see `isStandaloneKitImport`'s own docstring), so `reach`'s
 * histogram could not have caught this; it only surfaces once a standalone module is derived.
 */
export function frameFailureKind(statements: readonly AstNode[]): string {
  const toolKitImport = statements.find((s) => hasMcpToolKitImport(s) || isStandaloneKitImport(s));
  if (toolKitImport === undefined) return "frame:no-kit-import";

  const mcpInfo = statements.map(getMcpServerInfo).find((info) => info !== undefined);
  if (mcpInfo === undefined) return "frame:no-mcp-server";
  const { varName: mcpVar } = mcpInfo;

  const registrarNode = statements.find((s) => isRegistrarConst(s, mcpVar));
  if (registrarNode === undefined && splitRegistrarConsts(statements, mcpVar) === undefined) {
    return "frame:no-registrar";
  }

  // Elements 4 and 5 together: with no transport const the tail must carry the transport inline,
  // and a module with neither has no transport at all.
  const transportVar = statements.map(transportVarName).find((v) => v !== undefined);
  const connectNode =
    transportVar === undefined
      ? statements.find((s) => isInlinedTransportConnect(s, mcpVar))
      : statements.find((s) => isConnect(s, mcpVar, transportVar));
  if (connectNode === undefined) {
    return transportVar === undefined ? "frame:no-transport" : "frame:no-connect";
  }

  return "frame:unrecognized";
}
