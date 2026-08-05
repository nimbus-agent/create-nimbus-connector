import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  arrowFn,
  awaited,
  callArgs,
  calleeOf,
  callTo,
  expressionOf,
  isIdent,
  stringLit,
} from "../read.ts";
import { type ArgFields, recognizeArgs } from "./args.ts";
import { mergeHoistedArgs, recognizeHoistedBlock } from "./hoists.ts";
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
  if (args?.length !== 4) return undefined;
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
  // partially read — hoists.ts's `recognizeHoistedBlock` is where that refusal happens, shared
  // with tools-rest.ts, which reads the identical hoist statements behind a different registrar.
  const block = recognizeHoistedBlock(arrow.body);
  if (block === undefined) return undefined;

  const path = pathFromJsonResult(block.returned, block.locals);
  if (path === undefined) return undefined;

  // Gap A / Gap B: renderZodSchema never encodes `local` or `default` in the schema text
  // itself (recognizeArgs, above, cannot see either), so both are only visible at the hoist
  // statement — merge them back onto the matching arg now that both are known.
  const mergedArgs = mergeHoistedArgs(toolArgs, block.hoistMeta);
  if (mergedArgs === undefined) return undefined;

  return {
    fields: { name, description, args: mergedArgs, path },
    isBlock: true,
    hasHoists: block.locals.size > 0,
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
