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
import { recognizeSearchTool, type SearchToolFields } from "./search.ts";

/**
 * The inverse of src/emit/server/tools-hand.ts's renderTool — recovers one `reg(...)` call's
 * declared spec fields, including which of the two fetch helpers produced the call:
 * `jsonResult(await <helper>(<path>, ...))` for GET, `<helper>Send(<path>, <method>, <body>)`
 * for everything else. Reading the path argument without checking WHICH function produced it
 * used to derive a POST tool as a GET read tool — see `fetchCall`'s docstring.
 */
export type ToolFields = {
  name: string;
  description: string;
  args: Record<string, ArgFields>;
  path: string;
  /**
   * Omitted for GET, so ToolSchema's `.default("GET")` applies and a read connector's derived
   * spec is byte-unchanged by this field's existence. Present only when the emitter wrote the
   * write helper, which is the only place a method literal appears.
   */
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
};

/**
 * The connector-wide `handlerStyle` recovered from the SET of recognized tools, not from any
 * one of them — `handlerStyle` is a top-level `ConnectorSpec` field
 * (`z.enum(["concise","block"]).default("concise")`, src/spec.ts), not a per-tool one.
 *
 * The result of one tool's recognition, before that aggregation: whether its handler was a
 * block body, and — only meaningful when it was — whether that block contained any hoisted
 * consts. `staticStyle`/`schemaShape` are the same per-tool evidence for the other two
 * connector-wide style votes (index.ts's `voteStaticPathStyle`/`voteArgsSchemaStyle`) — carried
 * here rather than folded into `fields`, because neither belongs on a TOOL in the derived spec:
 * both are `ConnectorSpecSchema`/`FetchHelperSchema` fields, and `ToolSchema` is a
 * `strictObject` that would reject them.
 *
 * `isSearch` marks a shape recovered by `recognizeSearchTool` rather than `recognizeOne` — see
 * the handlerStyle vote below for why it must be excluded rather than counted: `renderSearchTool`
 * always writes a hoist-free block, so counting it would force `handlerStyle: "block"` on every
 * connector that declares a search tool, regardless of what its OTHER tools actually show.
 */
type ToolShape = {
  fields: ToolFields | SearchToolFields;
  isBlock: boolean;
  hasHoists: boolean;
  isSearch?: true;
  staticStyle?: "quoted" | "template";
  schemaShape: { propertyCount: number; oneLine: boolean };
};

/** `handlerStyle` omitted lets ConnectorSpecSchema's `.default("concise")` apply. `staticPathStyles`/
 * `schemaShapes` are the per-tool style evidence index.ts's two votes consume. */
export type ToolsResult = {
  tools: (ToolFields | SearchToolFields)[];
  handlerStyle?: "block";
  staticPathStyles: readonly ("quoted" | "template" | undefined)[];
  schemaShapes: readonly { propertyCount: number; oneLine: boolean }[];
};

function isRegCall(node: AstNode): AstNode | undefined {
  const call = expressionOf(node);
  return isIdent(calleeOf(call), "reg") ? call : undefined;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type FetchCall = { path: AstNode; method?: "POST" | "PUT" | "PATCH" | "DELETE" };

/**
 * The read helper `<local>(path)` or the write helper `<local>Send(path, "METHOD", body)`, and
 * NOTHING else. Reading args[0] without checking the callee derived a POST tool as a GET read
 * tool — losing method, effect and therefore the manifest's hitlRequired — which is a wrong
 * artifact rather than a byte mismatch, and invisible to the totality rule because the statement
 * was claimed, just claimed wrongly. deriveRestKitSpec already performs the equivalent refusal.
 */
function fetchCall(call: AstNode, helperLocal: string): FetchCall | undefined {
  const callee = calleeOf(call);
  const args = callArgs(call);
  if (args === undefined) return undefined;

  if (isIdent(callee, helperLocal)) {
    return args.length === 1 && args[0] !== undefined ? { path: args[0] } : undefined;
  }
  if (isIdent(callee, `${helperLocal}Send`)) {
    if (args.length !== 3 || args[0] === undefined) return undefined;
    const method = stringLit(args[1]);
    if (method === undefined || !WRITE_METHODS.has(method)) return undefined;
    return { path: args[0], method: method as "POST" | "PUT" | "PATCH" | "DELETE" };
  }
  return undefined;
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

/** The declared path, its static-path-style evidence, and method recovered from
 * `jsonResult(await <helper|helperSend>(...))`. */
function pathFromJsonResult(
  node: AstNode | undefined,
  locals: ReadonlyMap<string, PathLocal>,
  helperLocal: string,
):
  | {
      path: string;
      staticStyle?: "quoted" | "template";
      method?: "POST" | "PUT" | "PATCH" | "DELETE";
    }
  | undefined {
  const helperCall = jsonResultCall(node);
  if (helperCall === undefined) return undefined;
  const fetched = fetchCall(helperCall, helperLocal);
  if (fetched === undefined) return undefined;
  const recognized = recognizePath(fetched.path, locals);
  if (recognized === undefined) return undefined;
  return {
    path: recognized.path,
    ...(recognized.staticStyle === undefined ? {} : { staticStyle: recognized.staticStyle }),
    ...(fetched.method === undefined ? {} : { method: fetched.method }),
  };
}

function recognizeOne(call: AstNode, helperLocal: string): ToolShape | undefined {
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

  const argsResult = recognizeArgs(schemaNode);
  if (argsResult === undefined) return undefined;
  const schemaShape = {
    propertyCount: Object.keys(argsResult.args).length,
    oneLine: argsResult.schemaStyle === "inline",
  };

  // The concise, expression-bodied form: `async (...) => jsonResult(await helper(path))`.
  if (!arrow.isBlock) {
    const recovered = pathFromJsonResult(arrow.body, new Map(), helperLocal);
    if (recovered === undefined) return undefined;
    const { staticStyle, ...pathFields } = recovered;
    return {
      fields: { name, description, args: argsResult.args, ...pathFields },
      isBlock: false,
      hasHoists: false,
      staticStyle,
      schemaShape,
    };
  }

  // The block form: zero or more hoisted-argument consts, then a single `return jsonResult(...)`.
  // A tool whose block contains anything else (e.g. the query branch's `new URL(...)` trio, or
  // a stub's `throw`) is a shape this recognizer does not model, and is refused rather than
  // partially read — hoists.ts's `recognizeHoistedBlock` is where that refusal happens, shared
  // with tools-rest.ts, which reads the identical hoist statements behind a different registrar.
  const block = recognizeHoistedBlock(arrow.body);
  if (block === undefined) return undefined;

  const recovered = pathFromJsonResult(block.returned, block.locals, helperLocal);
  if (recovered === undefined) return undefined;
  const { staticStyle, ...pathFields } = recovered;

  // Gap A / Gap B: renderZodSchema never encodes `local` or `default` in the schema text
  // itself (recognizeArgs, above, cannot see either), so both are only visible at the hoist
  // statement — merge them back onto the matching arg now that both are known.
  const mergedArgs = mergeHoistedArgs(argsResult.args, block.hoistMeta);
  if (mergedArgs === undefined) return undefined;

  return {
    fields: { name, description, args: mergedArgs, ...pathFields },
    isBlock: true,
    hasHoists: block.locals.size > 0,
    staticStyle,
    schemaShape,
  };
}

/**
 * The fallback tried when `recognizeOne` does not recognize a `reg(...)` call — a search tool's
 * handler is shaped entirely differently (`renderSearchTool` never writes `jsonResult`, so
 * `recognizeOne`'s block-form reader always and safely refuses it; see `search.ts`'s own module
 * docstring). Wraps `recognizeSearchTool`'s result into the same `ToolShape` shape `recognizeOne`
 * produces so the caller's loop, claim and votes do not need to know which recognizer fired.
 *
 * `isBlock`/`hasHoists` are reported as what `renderSearchTool` actually writes (a block with no
 * hoists) rather than a value chosen to influence the vote — `isSearch: true` is what excludes
 * this shape from the vote outright, so these two stay honest.
 */
function recognizeSearchShape(call: AstNode, helperLocal: string): ToolShape | undefined {
  const result = recognizeSearchTool(call, helperLocal);
  if (result === undefined) return undefined;
  return {
    fields: result.fields,
    isBlock: true,
    hasHoists: false,
    isSearch: true,
    staticStyle: result.staticStyle,
    schemaShape: result.schemaShape,
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
 *
 * `helperLocal` is the fetch helper's recognized name (`FetchHelperFields.local`), threaded in
 * by the caller so `fetchCall` can verify each reg() handler's fetch call is actually the
 * connector's own helper rather than assume it. It is `undefined` when `recognizeFetchHelper`
 * itself found nothing — with no name to check a callee against, refusing every call here is the
 * only option that does not risk attributing a method/effect to a call this recognizer cannot
 * verify. Refusing claims nothing, so those reg() statements fall through to the totality rule
 * and are reported by name rather than silently inheriting the (unrelated) no-fetch-helper case.
 */
export function recognizeTools(
  statements: readonly AstNode[],
  claims: ClaimSet,
  helperLocal: string | undefined,
): ToolsResult | undefined {
  if (helperLocal === undefined) return undefined;

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
    const shape = recognizeOne(call, helperLocal) ?? recognizeSearchShape(call, helperLocal);
    if (shape === undefined) return undefined;
    shapes.push(shape);
  }

  // Search shapes carry no handlerStyle evidence either way — see ToolShape's own docstring —
  // so the vote runs over the non-search subset only. A connector whose every tool is a search
  // tool correctly abstains entirely (both booleans false), leaving handlerStyle unset.
  const votingShapes = shapes.filter((s) => s.isSearch !== true);
  const hasBlockWithoutHoists = votingShapes.some((s) => s.isBlock && !s.hasHoists);
  const hasConcise = votingShapes.some((s) => !s.isBlock);
  if (hasBlockWithoutHoists && hasConcise) return undefined;

  claims.claim(
    regs.map((entry) => entry.statement),
    "tools",
  );
  return {
    tools: shapes.map((s) => s.fields),
    ...(hasBlockWithoutHoists ? { handlerStyle: "block" as const } : {}),
    staticPathStyles: shapes.map((s) => s.staticStyle),
    schemaShapes: shapes.map((s) => s.schemaShape),
  };
}
