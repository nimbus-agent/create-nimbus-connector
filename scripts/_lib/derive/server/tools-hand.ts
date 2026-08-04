import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
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
  if (node.type !== "ExpressionStatement") return undefined;
  const call = node["expression"] as AstNode;
  if (call.type !== "CallExpression") return undefined;
  const callee = call["callee"] as AstNode;
  return callee.type === "Identifier" && callee["name"] === "reg" ? call : undefined;
}

/**
 * `<anything>.<name>` -> "<name>".
 *
 * Deliberately does not check that the object identifier is the handler's own parameter (it
 * would always be "p" per tools-hand.ts's `PARAM` constant) — path-template.ts's own
 * `argNameFromExpr` already resolves a bare `p.name` member read the same lax way, so pinning a
 * check here that the use site doesn't make would only create a second, inconsistent notion of
 * "the param".
 */
function memberArgName(node: AstNode): string | undefined {
  if (node.type !== "MemberExpression") return undefined;
  const object = node["object"] as AstNode;
  const property = node["property"] as AstNode;
  if (object.type !== "Identifier" || property.type !== "Identifier") return undefined;
  const name = property["name"];
  return typeof name === "string" ? name : undefined;
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
  if (init.type !== "ConditionalExpression") return undefined;
  if ((init["consequent"] as AstNode)["value"] !== "true") return undefined;
  if ((init["alternate"] as AstNode)["value"] !== "false") return undefined;

  const test = init["test"] as AstNode;
  if (test.type !== "BinaryExpression" || test["operator"] !== "===") return undefined;
  if ((test["right"] as AstNode)["value"] !== true) return undefined;

  return memberArgName(test["left"] as AstNode);
}

/**
 * `p.scope ?? "all"` -> "scope".
 *
 * Pinned to the `??` operator specifically. renderHoists never writes `||` for a default value,
 * so a matcher accepting `||` too would recover the same placeholder for a shape the emitter
 * could not actually have produced — a wrong match dressed as a success.
 */
function defaultHoistArg(init: AstNode): string | undefined {
  if (init.type !== "LogicalExpression" || init["operator"] !== "??") return undefined;
  return memberArgName(init["left"] as AstNode);
}

/**
 * One hoisted-argument const statement, in either of renderHoists's two forms:
 *
 *   const <local> = <param>.<name> === true ? "true" : "false";   // -> bool: true
 *   const <local> = <param>.<name> ?? <default>;                  // -> bool: false
 *
 * The two forms produce an indistinguishable bare identifier at the path-template use site, so
 * `bool` has to be decided here, at the statement that actually carries the distinction, and
 * threaded into `recognizePath`'s `locals` map — see `PathLocal`'s docstring.
 */
function hoistedLocal(statement: AstNode): [string, PathLocal] | undefined {
  if (statement.type !== "VariableDeclaration") return undefined;
  const declarations = statement["declarations"] as AstNode[];
  if (declarations.length !== 1) return undefined;
  const id = declarations[0]?.["id"] as AstNode | undefined;
  const init = declarations[0]?.["init"] as AstNode | undefined;
  if (id?.type !== "Identifier" || init === undefined) return undefined;
  const local = id["name"];
  if (typeof local !== "string") return undefined;

  const boolArg = booleanHoistArg(init);
  if (boolArg !== undefined) return [local, { arg: boolArg, bool: true }];

  const defaultArg = defaultHoistArg(init);
  if (defaultArg !== undefined) return [local, { arg: defaultArg, bool: false }];

  return undefined;
}

/** The path argument of `<helper>(<path>, ...)` / `<helper>Send(<path>, ...)`. */
function fetchPathArgument(call: AstNode): AstNode | undefined {
  const args = call["arguments"] as AstNode[];
  return args[0];
}

function awaitedCall(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "AwaitExpression") return undefined;
  const call = node["argument"] as AstNode;
  return call.type === "CallExpression" ? call : undefined;
}

/** `jsonResult(await helper(path, ...))` -> the awaited call. */
function jsonResultCall(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "CallExpression") return undefined;
  const callee = node["callee"] as AstNode;
  if (callee.type !== "Identifier" || callee["name"] !== "jsonResult") return undefined;
  const args = node["arguments"] as AstNode[];
  if (args.length !== 1) return undefined;
  return awaitedCall(args[0]);
}

/** The declared path recovered from `jsonResult(await helper(path, ...))`, or undefined. */
function pathFromJsonResult(node: AstNode | undefined, locals: ReadonlyMap<string, PathLocal>) {
  const helperCall = jsonResultCall(node);
  const pathNode = helperCall === undefined ? undefined : fetchPathArgument(helperCall);
  return pathNode === undefined ? undefined : recognizePath(pathNode, locals);
}

function recognizeOne(call: AstNode): ToolShape | undefined {
  const args = call["arguments"] as AstNode[];
  if (args.length !== 4) return undefined;
  const [nameNode, descriptionNode, schemaNode, handlerNode] = args as [
    AstNode,
    AstNode,
    AstNode,
    AstNode,
  ];
  const name = nameNode["value"];
  const description = descriptionNode["value"];
  if (typeof name !== "string" || typeof description !== "string") return undefined;
  if (handlerNode.type !== "ArrowFunctionExpression") return undefined;

  const toolArgs = recognizeArgs(schemaNode);
  if (toolArgs === undefined) return undefined;

  const body = handlerNode["body"] as AstNode;

  // The concise, expression-bodied form: `async (...) => jsonResult(await helper(path))`.
  if (body.type !== "BlockStatement") {
    const path = pathFromJsonResult(body, new Map());
    return path === undefined
      ? undefined
      : { fields: { name, description, args: toolArgs, path }, isBlock: false, hasHoists: false };
  }

  // The block form: zero or more hoisted-argument consts, then a single `return jsonResult(...)`.
  // A tool whose block contains anything else (e.g. the query branch's `new URL(...)` trio, or
  // a stub's `throw`) is a shape this recognizer does not model, and is refused rather than
  // partially read.
  const statements = (body["body"] as AstNode[]) ?? [];
  if (statements.length === 0) return undefined;

  const locals = new Map<string, PathLocal>();
  for (const statement of statements.slice(0, -1)) {
    const hoist = hoistedLocal(statement);
    if (hoist === undefined) return undefined;
    locals.set(hoist[0], hoist[1]);
  }

  const last = statements.at(-1) as AstNode;
  if (last.type !== "ReturnStatement") return undefined;
  const path = pathFromJsonResult(last["argument"] as AstNode | undefined, locals);
  return path === undefined
    ? undefined
    : {
        fields: { name, description, args: toolArgs, path },
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
