import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  arrowFn,
  awaited,
  binary,
  blockBody,
  boolLit,
  callArgs,
  calleeOf,
  callTo,
  conditional,
  constDecl,
  expressionOf,
  identName,
  isIdent,
  logical,
  memberName,
  memberObject,
  numericValue,
  returnArgument,
  stringLit,
} from "../read.ts";
import { type ArgFields, recognizeArgs } from "./args.ts";
import { type PathLocal, recognizePath } from "./path-template.ts";

/**
 * The inverse of src/emit/server/tools-hand.ts's renderTool — recovers one `reg(...)` call's
 * declared spec fields. No `method` field: tools-hand.ts routes both GET and non-GET tools
 * through `jsonResult(await <helper>(<path>, ...))` / `<helper>Send(<path>, <method>, <body>)`
 * with the path always first, so this recognizer can name the path without needing to
 * distinguish which helper produced the call — the method itself is a different task's concern.
 */
export type ToolFields = {
  name: string;
  description: string;
  args: Record<string, ArgFields>;
  path: string;
};

/**
 * The connector-wide `handlerStyle` recovered from the SET of recognized tools, not from any
 * one of them — `handlerStyle` is a top-level `ConnectorSpec` field
 * (`z.enum(["concise","block"]).default("concise")`, src/spec.ts), not a per-tool one.
 *
 * The result of one tool's recognition, before that aggregation: whether its handler was a
 * block body, and — only meaningful when it was — whether that block contained any hoisted
 * consts.
 */
type ToolShape = { fields: ToolFields; isBlock: boolean; hasHoists: boolean };

/** `handlerStyle` omitted lets ConnectorSpecSchema's `.default("concise")` apply. */
export type ToolsResult = { tools: ToolFields[]; handlerStyle?: "block" };

function isRegCall(node: AstNode): AstNode | undefined {
  const call = expressionOf(node);
  return isIdent(calleeOf(call), "reg") ? call : undefined;
}

/**
 * `<anything>.<name>` -> "<name>".
 *
 * Deliberately does not check that the object identifier is the handler's own parameter (it
 * would always be "p" per tools-hand.ts's `PARAM` constant) — path-template.ts's own
 * `argNameFromExpr` already resolves a bare `p.name` member read the same lax way, so pinning a
 * check here that the use site doesn't make would only create a second, inconsistent notion of
 * "the param".
 *
 * `memberName`/`memberObject` carry the same computed-member guard this used to check by hand: a
 * computed member (`p[key]`) has an Identifier `property` too — it's the KEY variable's name,
 * not a property name. Reading it unguarded would name an arg after whatever local happens to be
 * used as the index (`p[key]` -> arg "key"), an arg the connector never declared.
 * path-template.ts's `argNameFromExpr` guards this identical hazard on the read side (citing
 * args.ts:53); this function had the same shape and the same gap, just unnoticed until the
 * computed-member sweep that added server/index.ts's isConnect guard.
 */
function memberArgName(node: AstNode): string | undefined {
  if (identName(memberObject(node)) === undefined) return undefined;
  return memberName(node);
}

/**
 * `p.only_open === true ? "true" : "false"` -> "only_open".
 *
 * Pinned to every part of renderHoists's exact boolean form: the `===` operator, a literal
 * `true` right operand, and the `"true"`/`"false"` string branches (in that order — a swapped
 * pair is not this shape either). `p.limit === 0 ? "a" : "b"` fails on the very first check
 * (consequent !== "true") and is correctly refused rather than partially matched — see the
 * module-level warning about over-claiming that this whole file exists to avoid.
 */
function booleanHoistArg(init: AstNode): string | undefined {
  const c = conditional(init);
  if (c === undefined) return undefined;
  if (stringLit(c.consequent) !== "true" || stringLit(c.alternate) !== "false") return undefined;

  const test = binary(c.test);
  if (test === undefined || test.operator !== "===" || boolLit(test.right) !== true) {
    return undefined;
  }
  return memberArgName(test.left);
}

/**
 * A literal `renderHoists` can write as a `??` default's right-hand side —
 * `JSON.stringify(a.default)` on a value typed `z.union([z.string(), z.number(), z.boolean()])`
 * in ArgSchema (booleans never actually reach here: `a.type === "boolean"` always takes the
 * ternary form above instead, per `renderHoists`'s own branch — but a literal is a literal,
 * and the boundary this recognizer draws is the AST shape, not which combinations the schema
 * happens to allow today). Anything else — an identifier, a template literal, `null` — is not
 * one of these three node types and is refused.
 *
 * The numeric branch reads through `numericValue`, not `numberLit`: a numeric default may be
 * negative (ArgSchema constrains sign on none of `min`, `max` or `default`), and `?? -1` is a
 * shape `renderHoists` can legitimately write. This is one of this retrofit's two sanctioned
 * widenings — `.min(-5)`/`.max(-5)` in args.ts is the other.
 */
function hoistDefaultLiteral(node: AstNode): string | number | boolean | undefined {
  const s = stringLit(node);
  if (s !== undefined) return s;
  const n = numericValue(node);
  if (n !== undefined) return n;
  return boolLit(node);
}

/**
 * `p.scope ?? "all"` -> `{ arg: "scope", default: "all" }`.
 *
 * Pinned to the `??` operator specifically. renderHoists never writes `||` for a default value,
 * so a matcher accepting `||` too would recover the same placeholder for a shape the emitter
 * could not actually have produced — a wrong match dressed as a success. The default's VALUE is
 * recovered here too (Gap B): it is only ever visible at this statement — `renderZodSchema`
 * never encodes `a.default` in the schema text — so an arg's default is otherwise unrecoverable.
 */
function defaultHoistArg(
  init: AstNode,
): { arg: string; default: string | number | boolean } | undefined {
  const l = logical(init);
  if (l === undefined || l.operator !== "??") return undefined;
  const arg = memberArgName(l.left);
  if (arg === undefined) return undefined;
  const value = hoistDefaultLiteral(l.right);
  if (value === undefined) return undefined;
  return { arg, default: value };
}

/**
 * One hoisted-argument const statement, in either of renderHoists's two forms:
 *
 *   const <local> = <param>.<name> === true ? "true" : "false";   // -> bool: true
 *   const <local> = <param>.<name> ?? <default>;                  // -> bool: false, + default
 *
 * The two forms produce an indistinguishable bare identifier at the path-template use site, so
 * `bool` has to be decided here, at the statement that actually carries the distinction, and
 * threaded into `recognizePath`'s `locals` map — see `PathLocal`'s docstring.
 *
 * `local` — the const's own identifier — is returned alongside `pathLocal` because it is Gap
 * A's only source too: `renderHoists` writes `a.local ?? name`, so the const name IS `a.local`
 * whenever it differs from the arg's own key, and this statement is the only place that name
 * appears in the emitted module.
 *
 * `constDecl` carries the `kind === "const"` guard this used to check by hand — without it,
 * `let <local> = p.<name> ?? <default>;` passed every check below and was claimed as the
 * documented `const` hoist, same gap as server/index.ts's isRegistrarConst.
 */
function hoistedLocal(
  statement: AstNode,
): { local: string; pathLocal: PathLocal; default?: string | number | boolean } | undefined {
  const decl = constDecl(statement);
  if (decl === undefined || decl.init === undefined) return undefined;
  const local = decl.name;

  const boolArg = booleanHoistArg(decl.init);
  if (boolArg !== undefined) return { local, pathLocal: { arg: boolArg, bool: true } };

  const defaultHoist = defaultHoistArg(decl.init);
  if (defaultHoist !== undefined) {
    return {
      local,
      pathLocal: { arg: defaultHoist.arg, bool: false },
      default: defaultHoist.default,
    };
  }

  return undefined;
}

/** The path argument of `<helper>(<path>, ...)` / `<helper>Send(<path>, ...)`. */
function fetchPathArgument(call: AstNode): AstNode | undefined {
  return callArgs(call)?.[0];
}

function awaitedCall(node: AstNode | undefined): AstNode | undefined {
  const call = awaited(node);
  return call?.type === "CallExpression" ? call : undefined;
}

/** `jsonResult(await helper(path, ...))` -> the awaited call. */
function jsonResultCall(node: AstNode | undefined): AstNode | undefined {
  const args = callTo(node, "jsonResult", 1);
  return args === undefined ? undefined : awaitedCall(args[0]);
}

/** The declared path recovered from `jsonResult(await helper(path, ...))`, or undefined. */
function pathFromJsonResult(node: AstNode | undefined, locals: ReadonlyMap<string, PathLocal>) {
  const helperCall = jsonResultCall(node);
  const pathNode = helperCall === undefined ? undefined : fetchPathArgument(helperCall);
  return pathNode === undefined ? undefined : recognizePath(pathNode, locals);
}

function recognizeOne(call: AstNode): ToolShape | undefined {
  const args = callArgs(call);
  if (args === undefined || args.length !== 4) return undefined;
  const [nameNode, descriptionNode, schemaNode, handlerNode] = args as [
    AstNode,
    AstNode,
    AstNode,
    AstNode,
  ];
  const name = stringLit(nameNode);
  const description = stringLit(descriptionNode);
  if (name === undefined || description === undefined) return undefined;

  const arrow = arrowFn(handlerNode);
  if (arrow === undefined) return undefined;

  const toolArgs = recognizeArgs(schemaNode);
  if (toolArgs === undefined) return undefined;

  // The concise, expression-bodied form: `async (...) => jsonResult(await helper(path))`.
  if (!arrow.isBlock) {
    const path = pathFromJsonResult(arrow.body, new Map());
    return path === undefined
      ? undefined
      : { fields: { name, description, args: toolArgs, path }, isBlock: false, hasHoists: false };
  }

  // The block form: zero or more hoisted-argument consts, then a single `return jsonResult(...)`.
  // A tool whose block contains anything else (e.g. the query branch's `new URL(...)` trio, or
  // a stub's `throw`) is a shape this recognizer does not model, and is refused rather than
  // partially read.
  const statements = blockBody(arrow.body);
  if (statements === undefined || statements.length === 0) return undefined;

  const locals = new Map<string, PathLocal>();
  // Keyed by arg name (pathLocal.arg), not by the const's own identifier — that is what
  // toolArgs is keyed by too, and it's the join key for feeding Gap A/B back into the arg.
  const hoistMeta = new Map<string, { local: string; default?: string | number | boolean }>();
  for (const statement of statements.slice(0, -1)) {
    const hoist = hoistedLocal(statement);
    if (hoist === undefined) return undefined;
    locals.set(hoist.local, hoist.pathLocal);
    hoistMeta.set(hoist.pathLocal.arg, { local: hoist.local, default: hoist.default });
  }

  const last = statements.at(-1)!;
  if (last.type !== "ReturnStatement") return undefined;
  const path = pathFromJsonResult(returnArgument(last), locals);
  if (path === undefined) return undefined;

  // Gap A / Gap B: renderZodSchema never encodes `local` or `default` in the schema text
  // itself (recognizeArgs, above, cannot see either), so both are only visible here, at the
  // hoist statement — merge them back onto the matching arg now that both are known.
  let mergedArgs = toolArgs;
  if (hoistMeta.size > 0) {
    mergedArgs = { ...toolArgs };
    for (const [argName, meta] of hoistMeta) {
      const arg = mergedArgs[argName];
      // A hoist naming an arg the schema doesn't declare is an inconsistency this recognizer
      // does not understand — reject the tool rather than guess which side is wrong.
      if (arg === undefined) return undefined;
      mergedArgs[argName] = {
        ...arg,
        ...(meta.local !== argName ? { local: meta.local } : {}),
        ...(meta.default !== undefined ? { default: meta.default } : {}),
      };
    }
  }

  return {
    fields: { name, description, args: mergedArgs, path },
    isBlock: true,
    hasHoists: locals.size > 0,
  };
}

/**
 * Every `reg(...)` call in the module, or undefined if any one of them is not understood.
 *
 * All-or-nothing on purpose: a connector with nine recognized tools and one bespoke handler is
 * not nine-tenths regenerable, it is blocked — deriving a spec for the nine would produce a
 * server.ts missing a tool, which then fails the byte-diff for a reason the report would
 * misattribute to formatting rather than to the real, unmodeled tenth handler.
 *
 * `handlerStyle` is recovered here, from the SET of recognized tools, not per-tool — see
 * renderTool in src/emit/server/tools-hand.ts: a hoist forces a block body regardless of
 * `spec.handlerStyle` (`used.size === 0 && spec.handlerStyle === "concise"` is the only
 * condition that renders the one-line concise form), so a block body alone is not evidence of
 * `handlerStyle: "block"` — a block body with ZERO hoists is, because that shape can only come
 * from an explicit "block" setting; a "concise" connector would have rendered that same tool
 * as the one-line form instead.
 *
 * Two style-carrying shapes are consistent with a single connector-wide value:
 *   - "concise": some tools render concise (no hoists needed), the rest render block (hoists
 *     forced it) — never a block tool with zero hoists.
 *   - "block": every tool renders block, hoisted or not — never a concise tool.
 * A module mixing a concise tool with a block-without-hoists tool matches neither, and is
 * refused as an unmodeled shape rather than guessed at.
 */
export function recognizeTools(
  statements: readonly AstNode[],
  claims: ClaimSet,
): ToolsResult | undefined {
  const regs = statements
    .map((statement) => ({ statement, call: isRegCall(statement) }))
    .filter((entry): entry is { statement: AstNode; call: AstNode } => entry.call !== undefined);

  // A frame with zero reg() calls is not a hand-rolled connector with no tools — it is this
  // recognizer failing to find any reg() calls at all (e.g. a module this plan's recognizers
  // do not model). Deriving `{ tools: [] }` for it is accepted by parseSpec/validateSpec and
  // regenerates a connector that never existed, a false `emits`. Refuse instead.
  if (regs.length === 0) return undefined;

  const shapes: ToolShape[] = [];
  for (const { call } of regs) {
    const shape = recognizeOne(call);
    if (shape === undefined) return undefined;
    shapes.push(shape);
  }

  const hasBlockWithoutHoists = shapes.some((s) => s.isBlock && !s.hasHoists);
  const hasConcise = shapes.some((s) => !s.isBlock);
  if (hasBlockWithoutHoists && hasConcise) return undefined;

  claims.claim(
    regs.map((entry) => entry.statement),
    "tools",
  );
  return {
    tools: shapes.map((s) => s.fields),
    ...(hasBlockWithoutHoists ? { handlerStyle: "block" as const } : {}),
  };
}
