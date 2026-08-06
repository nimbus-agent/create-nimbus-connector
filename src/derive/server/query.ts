import type { AstNode } from "../ast.ts";
import {
  binary,
  blockBody,
  callArgs,
  calleeOf,
  callTo,
  constDecl,
  expressionOf,
  identName,
  ifStatement,
  isIdent,
  logical,
  memberName,
  memberObject,
  newOf,
  returnArgument,
  stringLit,
  templateLiteral,
} from "../read.ts";
import type { ArgFields } from "./args.ts";
import { type HoistMeta, splitHoists } from "./hoists.ts";
import { type PathLocal, recognizePathParts } from "./path-template.ts";

/**
 * The inverse of src/emit/server/query.ts's `renderQueryLines`, plus the block it lives inside —
 * `renderTool`'s query branch, which BOTH emitters write, differing only in how the block ends:
 *
 *   (parsed) => {                            |   async (p) => {
 *     <zero or more hoist consts>            |     <zero or more hoist consts>
 *     const u = new URL(<prefixed pathExpr>);|     const u = new URL(<prefixed pathExpr>);
 *     <query lines>                          |     <query lines>
 *     return `${u}`;                         |     const path = `${u}`;
 *   }                                        |     return <jsonResult(await …(path))>;
 *                                            |   }
 *   src/emit/server/tools-rest.ts            |   src/emit/server/tools-hand.ts
 *
 * The tail is selected by the caller rather than tried in turn, so neither style's ending can be
 * accepted for the other's block: a rest-kit `pathFn` binding `path` and returning a fetch call
 * is not a shape `renderTool` writes for rest-kit, and a hand-rolled handler returning a bare
 * `` `${u}` `` returns a string where the registrar expects an MCP result.
 *
 * `String(...)` is NOT recorded — it is VERIFIED. `wrapsInString` (src/emit/server/query.ts)
 * derives the wrapper from the argument's declared type alone; see its own docstring, which
 * tabulates the corpus specifically to establish that guardedness never enters the decision. The
 * wrapper therefore carries no information the schema does not already hold. Recording it would
 * invent a spec field; checking it is what makes a `String(...)` around a declared `string` — a
 * shape the emitter cannot write — a refusal rather than a silently claimed statement.
 *
 * The check is split across the two exports below on purpose: `recognizeQueryLines` reads the
 * statements and reports `wrapped` per entry, because it has no access to any arg's declared
 * type; `recognizeQueryBlock`, which is handed `recognizeArgs`'s result, is where `wrapped` is
 * held against that type and the entry either becomes a `QueryEntry` or the block is refused.
 *
 * Nothing here claims: `recognizeRestTools` claims the whole `<registrar>(...)` statement and
 * `recognizeTools` the whole `reg(...)` one, and claims are byte ranges with containment coverage
 * (see claims.ts), so every statement of this block is covered by that one claim either way.
 */

/** One recovered `query` entry, in the shape QueryParamSchema (src/spec.ts) declares. */
export type QueryEntry = {
  readonly name: string;
  readonly arg: string;
  readonly omitWhen?: "absent" | "empty";
};

/** A `QueryEntry` plus the `String(...)` evidence only `recognizeQueryBlock` can adjudicate. */
export type QueryLine = QueryEntry & { readonly wrapped: boolean };

/**
 * A value expression as one query line reads it: which spec ARG it names, and — when it arrived
 * through a hoisted const rather than a direct `<param>.<arg>` read — that const's own name.
 *
 * `local` is carried rather than discarded because a guard and the `set` call it wraps have to
 * name the same EXPRESSION, not merely the same arg: `renderQueryLines` builds both from one
 * `valueExpr(q, ctx)` string, so `if (lim !== undefined) { u.searchParams.set("limit",
 * String(parsed.limit)); }` — two spellings of arg "limit" — is a shape it cannot write, and
 * accepting it would derive a spec that re-emits different bytes.
 */
type ValueRef = { readonly arg: string; readonly local: string | undefined };

/**
 * `<hoistedConst>` or `<param>.<arg>` -> the ARG name, plus the const it arrived through.
 *
 * `locals` is `splitHoists`'s map, keyed by the const's own identifier. An identifier that is not
 * in it is not a hoisted local this recognizer can name, and is refused rather than guessed at —
 * the same rule `path-template.ts`'s `placeholderFor` applies to a bare identifier.
 *
 * The bare-member form is resolved WITHOUT checking the receiver, the same lax rule `hoists.ts`'s
 * `memberArgName` and `path-template.ts`'s `argNameFromExpr` already use — pinning a check here
 * that neither use site makes would create a second, inconsistent notion of "the param".
 * `memberName`/`memberObject` carry the computed-member guard both of those cite: `parsed[key]`
 * has an Identifier `property` too, naming the KEY variable rather than an arg.
 */
function valueRef(
  node: AstNode | undefined,
  locals: ReadonlyMap<string, PathLocal>,
): ValueRef | undefined {
  const local = identName(node);
  if (local !== undefined) {
    const hoisted = locals.get(local);
    return hoisted === undefined ? undefined : { arg: hoisted.arg, local };
  }

  if (identName(memberObject(node)) === undefined) return undefined;
  const arg = memberName(node);
  return arg === undefined ? undefined : { arg, local: undefined };
}

type SetCall = { readonly name: string; readonly value: ValueRef; readonly wrapped: boolean };

/**
 * `<urlVar>.searchParams.set("<name>", <value>)` — the receiver pinned to the `new URL` const's
 * own binding, and the method pinned to `set`. `renderQueryLines` writes only `set`; accepting
 * `append` too would claim a statement with different semantics (repeated keys) for a spec that
 * regenerates `set`.
 *
 * The receiver is a TWO-level member expression, which `methodCallTo` deliberately does not
 * model — see `calleeOf`'s docstring in read.ts, which names this exact call and spells out the
 * composition used here, each step keeping its own guard.
 */
function setCall(
  expr: AstNode | undefined,
  urlVar: string,
  locals: ReadonlyMap<string, PathLocal>,
): SetCall | undefined {
  const args = callArgs(expr);
  if (args?.length !== 2) return undefined;

  const callee = calleeOf(expr);
  if (memberName(callee) !== "set") return undefined;
  const receiver = memberObject(callee);
  if (memberName(receiver) !== "searchParams") return undefined;
  if (!isIdent(memberObject(receiver), urlVar)) return undefined;

  const name = stringLit(args[0]);
  if (name === undefined) return undefined;

  const wrapper = callTo(args[1], "String", 1);
  const value = valueRef(wrapper === undefined ? args[1] : wrapper[0], locals);
  return value === undefined ? undefined : { name, value, wrapped: wrapper !== undefined };
}

/** `<value> !== <right>`, with `<value>` required to be the same expression the `set` call reads. */
function isNotEqual(
  node: AstNode | undefined,
  right: (n: AstNode) => boolean,
  value: ValueRef,
  locals: ReadonlyMap<string, PathLocal>,
): boolean {
  const b = binary(node);
  if (b?.operator !== "!==" || !right(b.right)) return false;
  const left = valueRef(b.left, locals);
  return left !== undefined && left.arg === value.arg && left.local === value.local;
}

/**
 * `<value> !== undefined` -> "absent"; `<value> !== undefined && <value> !== ""` -> "empty" —
 * `guardExpr`'s two forms (src/emit/server/query.ts), and no third.
 *
 * The two are distinguishable by node type alone: one `BinaryExpression` versus a
 * `LogicalExpression` of two, which read.ts's `binary` and `logical` keep strictly apart. Both
 * operands of the `&&` are checked, and both must name the SAME value expression the guarded
 * `set` call uses — a guard on one arg wrapping a `set` of another is a shape `renderQueryLines`
 * cannot write, and claiming it would derive an `omitWhen` attached to the wrong argument.
 */
function guardKind(
  test: AstNode,
  value: ValueRef,
  locals: ReadonlyMap<string, PathLocal>,
): "absent" | "empty" | undefined {
  const notUndefined = (n: AstNode | undefined): boolean =>
    isNotEqual(n, (r) => isIdent(r, "undefined"), value, locals);

  if (notUndefined(test)) return "absent";

  const l = logical(test);
  if (l?.operator !== "&&" || !notUndefined(l.left)) return undefined;
  return isNotEqual(l.right, (r) => stringLit(r) === "", value, locals) ? "empty" : undefined;
}

/**
 * `if (<guard>) { <urlVar>.searchParams.set(...); }` — exactly one statement in the consequent
 * and no `else`, matching the three lines `renderQueryLines` pushes for a guarded entry.
 */
function guardedSet(
  statement: AstNode,
  urlVar: string,
  locals: ReadonlyMap<string, PathLocal>,
): QueryLine | undefined {
  const s = ifStatement(statement);
  if (s === undefined || s.alternate !== undefined) return undefined;

  const body = blockBody(s.consequent);
  if (body?.length !== 1) return undefined;

  const set = setCall(expressionOf(body[0]!), urlVar, locals);
  if (set === undefined) return undefined;

  const omitWhen = guardKind(s.test, set.value, locals);
  if (omitWhen === undefined) return undefined;
  return { name: set.name, arg: set.value.arg, omitWhen, wrapped: set.wrapped };
}

/**
 * The `searchParams` statements of one query block, in order — refusing on the first statement
 * that is neither a bare `set` call nor an `if` wrapping exactly one.
 *
 * Zero statements yields `[]` rather than a refusal; it is `recognizeQueryBlock` that treats an
 * empty query as one, because the fact that makes it wrong lives there: `renderTool` emits the
 * `new URL` trio only inside `if (query !== undefined)`, and ToolSchema rejects an empty `query`
 * array, so a trio with no lines between it is not a shape the emitter can produce.
 */
export function recognizeQueryLines(
  statements: readonly AstNode[],
  urlVar: string,
  locals: ReadonlyMap<string, PathLocal>,
): QueryLine[] | undefined {
  const out: QueryLine[] = [];
  for (const statement of statements) {
    const bare = setCall(expressionOf(statement), urlVar, locals);
    if (bare !== undefined) {
      out.push({ name: bare.name, arg: bare.value.arg, wrapped: bare.wrapped });
      continue;
    }
    const guarded = guardedSet(statement, urlVar, locals);
    if (guarded === undefined) return undefined;
    out.push(guarded);
  }
  return out;
}

/**
 * The `new URL(...)` prefix, in the two forms `baseExpr` (src/emit/server/fetch-helper.ts) can
 * write: the resolved literal text, or `` `${<baseConst>}` ``. Compared against the recognized
 * fetch helper's own fields by the caller — see `deriveRestKitSpec`, which is also where a
 * `literal` prefix's base is finally taken back OFF the path.
 *
 * The literal variant's field is named `leadingQuasi`, not `text` or `base`, and the name is
 * load-bearing: it is the template's whole leading quasi, which CONTAINS the base but is not it.
 * `renderPath` splices the prefix in as raw template text immediately ahead of the path's first
 * literal segment, so the two arrive fused (`https://api.x.test` + `/v1/items` -> one quasi
 * `https://api.x.test/v1/items`) with no marker between them. A base may itself carry a path
 * component (discord's `https://discord.com/api/v10`) and a query tool's path must start with "/"
 * (ToolSchema's `checkQueryPathPrefix`), so several splits of that quasi are byte-identical and
 * THIS recognizer cannot pick the right one — only the module's own fetch helper says where the
 * base ends. The quasi is handed over whole and the caller, which has that fact, does the split.
 * Reading this field as though it were the base is the single mistake the split exists to
 * prevent, so it is spelled so that the misreading does not survive being written down.
 */
export type BasePrefix =
  | { kind: "literal"; leadingQuasi: string }
  | { kind: "const"; name: string };

/**
 * A recognized query block. `path` still carries a `literal` base prefix (see `BasePrefix`); a
 * `const` one is already gone, because the base const is a whole template expression and dropping
 * it is unambiguous.
 *
 * There is no `staticStyle`, deliberately: `renderPath`'s fast path is
 * `if (!dynamic && prefix === "")`, so a query tool's non-empty prefix forces the template branch
 * regardless of `ctx.staticStyle`, exactly as a dynamic segment does. The path therefore carries
 * no evidence of the connector's convention, and reporting "template" for one would be reading
 * the prefix as if it were the convention — which `voteStaticPathStyle` BLOCKS on when another
 * tool votes "quoted", manufacturing a refusal against a module the emitter wrote correctly.
 */
export type QueryBlock = {
  readonly path: string;
  readonly query: QueryEntry[];
  readonly basePrefix: BasePrefix;
  readonly hoistMeta: ReadonlyMap<string, HoistMeta>;
  /**
   * The expression the block's final `return` returns, left UNREAD — set only for the
   * `"binds-path"` tail, whose `return` carries a `jsonResult(await <helper>(path))` call rather
   * than the URL itself. Handed back rather than read here for the same reason
   * `recognizeHoistedBlock` hands its own `returned` back (hoists.ts): what a returned expression
   * means is the caller's concern, and only tools-hand.ts knows the fetch helper's local name to
   * check that call against.
   */
  readonly returned?: AstNode;
};

/**
 * The URL const's name, pinned rather than recovered. `renderTool` writes `const u = new URL(...)`
 * literally, and `RESERVED_IDENTIFIERS` (src/validate.ts) reserves "u" unconditionally BECAUSE it
 * does — so a module binding this URL to any other name is one this generator cannot reproduce,
 * and reading it anyway would derive a spec that re-emits `u` and byte-matches nothing.
 */
const URL_LOCAL = "u";

/**
 * The hand-rolled tail's path const, pinned for the same reason `URL_LOCAL` is: `renderTool`
 * (src/emit/server/tools-hand.ts) writes `` const path = `${u}`; `` literally and then
 * substitutes the bare identifier `path` into the fetch call (`callPath`), and
 * `RESERVED_IDENTIFIERS` (src/validate.ts) reserves "path" unconditionally BECAUSE it does.
 *
 * Exported because the statement that BINDS it is matched here while the call that READS it is
 * matched in tools-hand.ts, and the two must name the same binding. A second literal there is a
 * place for one side to be tightened while the other keeps accepting what its twin just learned
 * to reject — the rule hoists.ts's module docstring states.
 */
export const PATH_LOCAL = "path";

/** The `new URL(...)` argument: its base prefix, and the path template behind it. */
function prefixedPath(
  node: AstNode,
  locals: ReadonlyMap<string, PathLocal>,
): { path: string; basePrefix: BasePrefix } | undefined {
  // Always a template literal: `renderPath`'s quoted-string fast path requires `prefix === ""`,
  // and a query tool's prefix is `baseExpr(spec)`, which FetchHelperSchema keeps non-empty
  // (`base: z.string().min(1)`).
  const t = templateLiteral(node);
  const head = t?.quasis[0];
  if (t === undefined || head === undefined) return undefined;

  // The hoisted-base form, `` `${BASE}<path>` ``: `baseExpr` writes the expression as the very
  // first thing in the template, so the leading quasi is empty.
  //
  // An empty leading quasi does NOT prove the hoisted form on its own, and the check that
  // actually decides it is `identName` below. For rest-kit a literal base cannot produce one —
  // `base` is non-empty and the schema's rest-kit refine forbids `${env.X}` in it, so `baseExpr`
  // returns that literal text verbatim. Hand-rolled has no such refine: `baseExpr` runs
  // `resolveEnvRefs(base)` there, so a base of `"${env.HOST}/api"` renders `` `${HOST()}/api…` ``
  // — an empty leading quasi with a literal base behind it.
  //
  // An env-ref base is REFUSED, deliberately, not merely unhandled. It is refused here because
  // the first expression is a CallExpression, so `identName` returns undefined and no base const
  // is invented; the form with text ahead of the accessor (`"https://${env.HOST}/api"`) takes the
  // literal branch below instead and is refused by `rebaseQueryTools` (src/derive/index.ts),
  // whose docstring carries the proof that the two halves cover every env-ref base between them.
  // Supporting it would mean a third `BasePrefix` variant spanning a quasi AND an expression,
  // splittable only against a base whose own value is decided per request — and the whole point
  // of `BasePrefix` is that this recognizer cannot pick the split, only the caller's fetch helper
  // can. Nothing in the corpus writes it (the hand-rolled query shape appears zero times across
  // 94 connectors, measured 2026-08-06), so the cost of the refusal is a named blocker on a spec
  // someone would have to write on purpose.
  //
  // An identifier already in `locals` is a path placeholder, not a base const, and is refused for
  // the same reason.
  if (head === "") {
    const name = identName(t.expressions[0]);
    if (name === undefined || locals.has(name)) return undefined;
    const path = recognizePathParts(t.quasis.slice(1), t.expressions.slice(1), locals);
    return path === undefined ? undefined : { path, basePrefix: { kind: "const", name } };
  }

  const path = recognizePathParts(t.quasis, t.expressions, locals);
  return path === undefined
    ? undefined
    : { path, basePrefix: { kind: "literal", leadingQuasi: head } };
}

/**
 * `` `${u}` `` — one expression, two empty quasis: the absolute URL both tails are built from.
 *
 * The template form is pinned, not `u` in any stringifying position. Ten corpus connectors write
 * `new URL(...)` in a buildPath callback and every one of them reaches for
 * `` `${u.pathname}${u.search}` `` or `u.toString()` instead — measured 2026-08-06 — so a lax
 * reader would claim ten modules this generator cannot reproduce.
 */
function isUrlTemplate(node: AstNode | undefined, urlVar: string): boolean {
  const t = templateLiteral(node);
  if (t?.expressions.length !== 1) return false;
  return t.quasis[0] === "" && t.quasis[1] === "" && isIdent(t.expressions[0], urlVar);
}

/** `` return `${u}`; `` — the rest-kit tail, whole. */
function isUrlReturn(statement: AstNode, urlVar: string): boolean {
  return isUrlTemplate(returnArgument(statement), urlVar);
}

/** `` const path = `${u}`; `` — the hand-rolled tail's first statement. See `PATH_LOCAL`. */
function isPathConst(statement: AstNode, urlVar: string): boolean {
  const decl = constDecl(statement);
  return decl?.name === PATH_LOCAL && isUrlTemplate(decl.init, urlVar);
}

/**
 * The hand-rolled tail: `` const path = `${u}`; `` then a `return`, whose argument is handed
 * back unread (see `QueryBlock.returned`). A `return` with no argument is refused — `renderTool`
 * always returns the fetch call — rather than recorded as a tool that returns nothing.
 */
function readPathConstTail(statements: readonly AstNode[], urlVar: string): AstNode | undefined {
  const [bind, ret] = statements;
  if (bind === undefined || ret === undefined) return undefined;
  if (!isPathConst(bind, urlVar) || ret.type !== "ReturnStatement") return undefined;
  return returnArgument(ret);
}

/**
 * `renderTool`'s query branch, whole: the hoists, `const u = new URL(<pathExpr>)`, the query
 * lines, and the `tail` the caller names — see this module's header for the two forms and why
 * the caller chooses rather than this function trying both.
 *
 * The tail is verified precisely rather than accepted as "any return"; `isUrlTemplate` carries
 * the corpus measurement behind that. The emitter's choice of the absolute form is deliberate and
 * documented at the `` `${u}` `` line in each emitter.
 *
 * `args` is `recognizeArgs`'s result — the schema's declared types, before `mergeHoistedArgs` —
 * which is what the `String(...)` wrapper is held against; see this module's header.
 */
export function recognizeQueryBlock(
  body: AstNode,
  args: Readonly<Record<string, ArgFields>>,
  tail: "returns-url" | "binds-path",
): QueryBlock | undefined {
  const statements = blockBody(body);
  if (statements === undefined) return undefined;

  const section = splitHoists(statements);
  const tailLength = tail === "binds-path" ? 2 : 1;
  // The URL const, at least one query line, and the tail. Fewer means either a missing tail or an
  // empty query, and `renderTool` writes the trio only for a non-empty one.
  if (section.rest.length < 2 + tailLength) return undefined;

  const urlDecl = constDecl(section.rest[0]!);
  if (urlDecl?.name !== URL_LOCAL) return undefined;
  const urlArgs = newOf(urlDecl.init, "URL", 1);
  if (urlArgs === undefined) return undefined;

  const prefixed = prefixedPath(urlArgs[0]!, section.locals);
  if (prefixed === undefined) return undefined;

  const tailStatements = section.rest.slice(-tailLength);
  let returned: AstNode | undefined;
  if (tail === "returns-url") {
    if (!isUrlReturn(tailStatements[0]!, URL_LOCAL)) return undefined;
  } else {
    returned = readPathConstTail(tailStatements, URL_LOCAL);
    if (returned === undefined) return undefined;
  }

  const lines = recognizeQueryLines(section.rest.slice(1, -tailLength), URL_LOCAL, section.locals);
  if (lines === undefined) return undefined;

  const query: QueryEntry[] = [];
  for (const line of lines) {
    // src/emit/server/query.ts's `wrapsInString`: the wrapper is written iff the declared type
    // is not "string", regardless of guardedness. Checked rather than recorded — see the header.
    const declared = args[line.arg]?.type;
    if (declared === undefined) return undefined;
    if (line.wrapped !== (declared !== "string")) return undefined;
    query.push({
      name: line.name,
      arg: line.arg,
      ...(line.omitWhen === undefined ? {} : { omitWhen: line.omitWhen }),
    });
  }

  return {
    path: prefixed.path,
    query,
    basePrefix: prefixed.basePrefix,
    hoistMeta: section.hoistMeta,
    ...(returned === undefined ? {} : { returned }),
  };
}
