import { type PathSegment, parsePathTemplate } from "../../spec.ts";
import type { AstNode } from "../ast.ts";
import {
  IDENTIFIER_KEY_RE,
  identName,
  isComputedProperty,
  isIdent,
  isShorthandProperty,
  logical,
  memberName,
  memberObject,
  methodCallTo,
  objectExpressionProperties,
  objectProperty,
  stringLit,
} from "../read.ts";
import type { ArgFields } from "./args.ts";
import { hoistDefaultLiteral } from "./hoists.ts";
import type { QueryEntry } from "./query.ts";

/**
 * The inverse of src/emit/server/body.ts's `renderBodyExpr`.
 *
 * Returns a `body` mapping ONLY when the observed literal differs from what the DEFAULT would have
 * produced for this tool — `Object.keys(tool.args)` minus every arg the path names and every arg
 * `query` names, in that order. Recording the mapping unconditionally would write an explicit
 * `body` into every derived spec, which parses and emits identical bytes today but states
 * something the connector's author never did, and diverges the moment the default's exclusion set
 * changes (it already grew once, when `query` joined `pathArgs` — see renderBodyExpr's docstring).
 *
 * That is the same omit-when-it-is-the-default discipline `title` (src/derive/index.ts's
 * `recognizeRestTitle`), `argsSchemaStyle` and `staticPathStyle` already use, and it is what makes
 * the reconstruction CHECKABLE rather than merely plausible: `test/derive/body.test.ts` compares
 * the derived `body` against the fixture author's own, per tool, so an exclusion set that is wrong
 * in either direction shows up as an explicit mapping where the author wrote none (or the reverse)
 * rather than as bytes that happen to match.
 */

/**
 * What `recognizeBodyExpr` needs of a recognized tool: the fields `renderBodyExpr` itself reads.
 *
 * `args` must be the MERGED args (hoists.ts's `mergeHoistedArgs` already applied), because two of
 * `fieldValue`'s three cases turn on `default` and `local` — neither of which `renderZodSchema`
 * encodes in the schema text, so both are only known once the hoist statements have been read.
 */
export type BodyTool = {
  readonly args: Readonly<Record<string, ArgFields>>;
  readonly path: string;
  readonly query?: readonly QueryEntry[];
  readonly method: string;
};

/**
 * The args the DEFAULT body would carry, in `Object.keys(tool.args)` order — `renderBodyExpr`'s
 * own `tool.body === undefined` branch, computed from the same `parsePathTemplate` rather than
 * from a second placeholder regex here. A copy of that parser is a place for one side to learn a
 * placeholder form the other never does, and the failure would be silent: an arg the copy failed
 * to see stays in the default set, so a tool whose body IS the default derives an explicit
 * mapping instead of none.
 *
 * `parsePathTemplate` THROWS on a path it cannot parse (a `${` it did not consume, an OpenAPI
 * `{id}`), which is right for a spec a human wrote and wrong here: this path was recovered from
 * source, and for a query tool it still carries the fetch helper's base spliced onto its front
 * (see `rebaseQueryTools`, which strips it later). A base carrying either shape would abort the
 * whole sweep, so it refuses the tool instead. The base cannot change the ARG set either way —
 * `baseExpr` renders env references as `${env.X}` accessor calls, which parse as `env` segments.
 */
function defaultBodyArgs(tool: BodyTool): readonly string[] | undefined {
  let segments: PathSegment[];
  try {
    segments = parsePathTemplate(tool.path);
  } catch {
    return undefined;
  }
  const urlArgs = new Set(segments.flatMap((s) => (s.kind === "arg" ? [s.name] : [])));
  for (const q of tool.query ?? []) urlArgs.add(q.arg);
  return Object.keys(tool.args).filter((a) => !urlArgs.has(a));
}

/**
 * `<anything>.<name>` -> "<name>".
 *
 * Deliberately does not check that the receiver is the handler's own parameter ("p" for
 * hand-rolled, "parsed" for rest-kit) — hoists.ts's `memberArgName` and path-template.ts's
 * `argNameFromExpr` both resolve the identical `<param>.<arg>` read the same lax way, and
 * tools-rest.ts/tools-hand.ts never check the arrow's parameter name either. Pinning it here
 * alone would create a second, inconsistent notion of "the param" — the rule hoists.ts's own
 * docstring states.
 *
 * `memberName`/`memberObject` carry the computed-member guard: `p[key]` has an Identifier
 * `property` too, naming the KEY variable rather than an arg.
 */
function memberArgName(node: AstNode | undefined): string | undefined {
  if (identName(memberObject(node)) === undefined) return undefined;
  return memberName(node);
}

/**
 * The arg whose hoisted const is named `local` — the inverse of `hoistedLocals`
 * (src/emit/server/args.ts), restricted to the args `fieldValue` can actually reach a hoist for.
 *
 * A BOOLEAN arg is hoisted too, and is deliberately excluded: `fieldValue`'s first case returns
 * the raw arg for a boolean before `ctx.hoisted` is ever consulted, because the boolean hoist
 * holds the STRING "true"/"false" — right for a URL, wrong for a JSON body. So a boolean's local
 * appearing here is a shape the emitter cannot write, not a hoist to resolve.
 *
 * Two args resolving to one local is refused rather than picked between: `hoistedLocals` is a map
 * keyed by arg, so the emitter can only have written that identifier for one of them, and this
 * recognizer cannot say which.
 */
function defaultedArgForLocal(tool: BodyTool, local: string): string | undefined {
  const matches = Object.entries(tool.args).filter(
    ([name, a]) => a.type !== "boolean" && a.default !== undefined && (a.local ?? name) === local,
  );
  return matches.length === 1 ? matches[0]![0] : undefined;
}

/**
 * One body field's value expression -> the ARG it reads, verified against `fieldValue`'s three
 * cases (src/emit/server/body.ts) and refusing anything that matches none of them.
 *
 * `hoistsInScope` is `ctx.hoisted`'s emptiness, reduced to the one bit that decides between cases
 * 2a and 2b: tools-hand.ts builds the body inside the same handler block as the hoists and passes
 * the full `hoistedLocals(tool.args)` map, so a defaulted arg is ALWAYS the hoisted const there;
 * tools-rest.ts builds it in the registrar's second callback, where nothing is in scope, and
 * passes an empty map, so the same arg is ALWAYS the inlined `?? <default>`. The two are not
 * interchangeable — accepting either would derive a spec that re-emits the other form — and no
 * recognizer can tell which one applies from the expression alone, so the caller says.
 */
function bodyValueArg(value: AstNode, tool: BodyTool, hoistsInScope: boolean): string | undefined {
  // Cases 1 and 3: the raw arg. `fieldValue` writes it for a boolean (always, whatever its
  // default) and for an arg with no default.
  const raw = memberArgName(value);
  if (raw !== undefined) {
    const arg = tool.args[raw];
    if (arg === undefined) return undefined;
    return arg.type === "boolean" || arg.default === undefined ? raw : undefined;
  }

  // Case 2a: the hoisted const, referenced by its own name.
  const local = identName(value);
  if (local !== undefined) {
    return hoistsInScope ? defaultedArgForLocal(tool, local) : undefined;
  }

  // Case 2b: the same value, inlined, because no hoist was in scope to reference. The default is
  // VERIFIED against the arg rather than recovered from here: for hand-rolled the hoist statement
  // is already its source (Gap B), and the rest-kit caller — `recognizeInitFn`
  // (server/tools-rest.ts), which passes `hoistsInScope: false` and is the only caller that
  // reaches this branch — has no second source to cross-check a recovered default against, so
  // recovering one would be a field invented by the only reader of it. (This said the rest-kit
  // caller "does not exist yet"; it does, and test/derive/body.test.ts exercises this branch
  // through it.)
  const l = logical(value);
  if (l?.operator !== "??" || hoistsInScope) return undefined;
  const name = memberArgName(l.left);
  if (name === undefined) return undefined;
  const arg = tool.args[name];
  if (arg === undefined || arg.type === "boolean" || arg.default === undefined) return undefined;
  return hoistDefaultLiteral(l.right) === arg.default ? name : undefined;
}

/**
 * One body field's API name, in the two spellings `renderBodyExpr` chooses between.
 *
 * A quoted key that IS a valid identifier is refused: the emitter quotes a field name only when
 * `IDENTIFIER_KEY_RE` rejects it, so `{ "title": … }` is a shape it cannot write, and reading it
 * anyway would derive a spec that re-emits the bare form. That is `quoteMinimalProps`' rule
 * (src/derive/read.ts) spelled out per key rather than folded into the parse, because `bodyPairs`
 * reads its properties through `objectProperty` — it discriminates SHORTHAND, which `objectProps`
 * cannot report — so the shared regex is imported and the wrapper is not. The empty-key clause is
 * this function's own, and has no counterpart there.
 *
 * The EMPTY key is refused here rather than passed on: `ToolSchema`'s `body` is
 * `z.record(z.string().min(1), z.string().min(1))`, so `{ "": … }` produces a derived spec that
 * fails `parseSpec` — counted as rejected-by-validate, one tier down, with no bucket naming the
 * construct that caused it. A named refusal at the recognizer is what keeps the histogram honest.
 */
function fieldName(key: AstNode): string | undefined {
  const bare = identName(key);
  if (bare !== undefined) return bare;
  const quoted = stringLit(key);
  if (quoted === undefined || quoted === "" || IDENTIFIER_KEY_RE.test(quoted)) return undefined;
  return quoted;
}

/** One observed body field: the API name it fills, and the spec arg it reads. */
type BodyPair = { readonly field: string; readonly arg: string };

/**
 * `JSON.stringify({ <fields> })` -> its fields, in source order, or undefined to refuse the tool.
 *
 * An EMPTY object literal is refused rather than read as an empty body: `renderBodyExpr` returns
 * undefined for an empty pair list and the call site writes the literal `undefined` third argument
 * instead, so `JSON.stringify({})` is a shape it never writes.
 */
function bodyPairs(node: AstNode, tool: BodyTool, hoistsInScope: boolean): BodyPair[] | undefined {
  const args = methodCallTo(node, "JSON", "stringify", 1);
  if (args?.length !== 1) return undefined;
  const properties = objectExpressionProperties(args[0]);
  if (properties === undefined || properties.length === 0) return undefined;

  const out: BodyPair[] = [];
  const seen = new Set<string>();
  for (const property of properties) {
    if (isComputedProperty(property)) return undefined;
    const parts = objectProperty(property);
    if (parts === undefined) return undefined;

    const field = fieldName(parts.key);
    if (field === undefined) return undefined;
    const arg = bodyValueArg(parts.value, tool, hoistsInScope);
    if (arg === undefined) return undefined;

    // The emitter writes shorthand exactly when the field name and the value expression are the
    // same identifier, so `{ scope }` and `{ scope: scope }` are two different outputs and only
    // one of them is reproducible from any given spec.
    if (isShorthandProperty(property) !== isIdent(parts.value, field)) return undefined;

    // `body` is keyed by ARG (`arg name -> API field name`, ToolSchema), so one arg cannot fill
    // two fields — no mapping regenerates that, whatever it says.
    if (seen.has(arg)) return undefined;
    seen.add(arg);

    out.push({ field, arg });
  }
  return out;
}

/**
 * The `body` half of one recognized tool: `{}` when the observed request body is what the DEFAULT
 * would have produced, `{ body: … }` when it is not, and `undefined` to refuse the tool.
 *
 * See this module's header for why the default case omits the field rather than recording it.
 */
export function recognizeBodyExpr(
  node: AstNode,
  tool: BodyTool,
  hoistsInScope: boolean,
): { body?: Record<string, string> } | undefined {
  // Mirrors renderBodyExpr's own first line. Unreachable through tools-hand.ts — a GET routes
  // through the read helper, whose call has no body argument to read — but stated here rather
  // than assumed of every future caller.
  if (tool.method === "GET") return undefined;

  const expected = defaultBodyArgs(tool);
  if (expected === undefined) return undefined;

  if (isIdent(node, "undefined")) {
    // `renderBodyExpr` returns undefined for an empty pair list, which the default produces for a
    // tool whose every arg is carried by the URL — a DELETE by path id, say. When the default
    // would NOT have been empty, the only spec that reproduces this call is an explicit EMPTY
    // mapping, so that is what is recorded: it is forced by the evidence rather than volunteered,
    // which is the opposite of the case the header argues against.
    return expected.length === 0 ? {} : { body: {} };
  }

  const pairs = bodyPairs(node, tool, hoistsInScope);
  if (pairs === undefined) return undefined;

  const isDefault =
    pairs.length === expected.length &&
    pairs.every((p, i) => p.field === p.arg && p.arg === expected[i]);
  if (isDefault) return {};

  return { body: Object.fromEntries(pairs.map((p) => [p.arg, p.field])) };
}
