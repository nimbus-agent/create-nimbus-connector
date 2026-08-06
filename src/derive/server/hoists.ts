import type { AstNode } from "../ast.ts";
import {
  binary,
  blockBody,
  boolLit,
  conditional,
  constDecl,
  identName,
  logical,
  memberName,
  memberObject,
  numericValue,
  returnArgument,
  stringLit,
} from "../read.ts";
import type { ArgFields } from "./args.ts";
import type { PathLocal } from "./path-template.ts";

/**
 * The inverse of renderHoists (src/emit/server/args.ts), plus the block-bodied handler shape the
 * hoists live inside — the half tools-hand.ts and tools-rest.ts share.
 *
 * The two recognizers read two different registration forms (`reg(...)` with a
 * `jsonResult(await <helper>(...))` handler; `<registrar>(...)` with a path-returning arrow), but
 * `renderHoists` writes an IDENTICAL statement for both, parameterised only by `PARAM` — "p" for
 * the hand-rolled style, "parsed" for the rest-kit one — which none of the matchers below ever
 * reads. The two files carried verbatim copies of this half until it moved here; a copy is a
 * place for one side to be tightened and the other to keep silently accepting the shape its twin
 * just learned to reject.
 *
 * What genuinely differs between the two callers stays with them: how the block's final `return`
 * argument becomes a path. `recognizeHoistedBlock` therefore hands back that returned expression
 * rather than a path, and each caller reads it its own way.
 */

/**
 * The literal types a `?? <default>` hoist can carry — `ArgSchema.default` is
 * `z.union([z.string(), z.number(), z.boolean()])` (src/spec.ts), which `ArgFields["default"]`
 * mirrors.
 */
export type HoistDefault = string | number | boolean;

/**
 * Gap A (`local`) and Gap B (`default`) for one hoisted arg — the two spec fields
 * `renderZodSchema` never writes into the schema text, so the hoist statement is their only
 * source. See `mergeHoistedArgs`.
 */
export type HoistMeta = { local: string; default?: HoistDefault };

/**
 * `<anything>.<name>` -> "<name>".
 *
 * Deliberately does not check that the object identifier is the handler's own parameter (it is
 * always `PARAM`: "p" for the hand-rolled style, "parsed" for the rest-kit one) —
 * path-template.ts's own `argNameFromExpr` already resolves a bare `p.name` member read the same
 * lax way, so pinning a check here that the use site doesn't make would only create a second,
 * inconsistent notion of "the param".
 *
 * `memberName`/`memberObject` carry the same computed-member guard this used to check by hand: a
 * computed member (`p[key]`) has an Identifier `property` too — it's the KEY variable's name,
 * not a property name. Reading it unguarded would name an arg after whatever local happens to be
 * used as the index (`p[key]` -> arg "key"), an arg the connector never declared.
 * path-template.ts's `argNameFromExpr` guards this identical hazard on the read side (citing
 * args.ts:53); this function had the same shape and the same gap, just unnoticed until the
 * computed-member sweep that added server/index.ts's isConnect guard.
 */
function memberArgName(node: AstNode | undefined): string | undefined {
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
 * module-level warning about over-claiming that these recognizers exist to avoid.
 */
function booleanHoistArg(init: AstNode): string | undefined {
  const c = conditional(init);
  if (c === undefined) return undefined;
  if (stringLit(c.consequent) !== "true" || stringLit(c.alternate) !== "false") return undefined;

  const test = binary(c.test);
  if (test?.operator !== "===" || boolLit(test.right) !== true) {
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
function hoistDefaultLiteral(node: AstNode): HoistDefault | undefined {
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
function defaultHoistArg(init: AstNode): { arg: string; default: HoistDefault } | undefined {
  const l = logical(init);
  if (l?.operator !== "??") return undefined;
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
): { local: string; pathLocal: PathLocal; default?: HoistDefault } | undefined {
  const decl = constDecl(statement);
  if (decl?.init === undefined) return undefined;
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

/**
 * The leading run of hoisted-argument consts in a handler block, and everything after it.
 *
 * Split out so the query branch (server/query.ts) reads the SAME hoist statements
 * `recognizeHoistedBlock` does without a second copy of the loop — the copy this module's own
 * docstring exists to have removed once already. The two callers differ only in what they demand
 * of `rest`: a single `return` here, the `new URL` trio there.
 */
export type HoistSection = {
  readonly locals: ReadonlyMap<string, PathLocal>;
  readonly hoistMeta: ReadonlyMap<string, HoistMeta>;
  readonly rest: readonly AstNode[];
};

export function splitHoists(statements: readonly AstNode[]): HoistSection {
  const locals = new Map<string, PathLocal>();
  const hoistMeta = new Map<string, HoistMeta>();
  let i = 0;
  for (; i < statements.length; i++) {
    const hoist = hoistedLocal(statements[i]!);
    if (hoist === undefined) break;
    locals.set(hoist.local, hoist.pathLocal);
    hoistMeta.set(hoist.pathLocal.arg, { local: hoist.local, default: hoist.default });
  }
  return { locals, hoistMeta, rest: statements.slice(i) };
}

/**
 * A recognized block-bodied handler: the hoists it declared, and the expression its final
 * `return` returned — left unread, because what a returned expression means is the caller's
 * concern (a `jsonResult(await ...)` call for tools-hand.ts, a bare path expression for
 * tools-rest.ts).
 *
 * `locals` is keyed by the const's own identifier, the name the path template refers to;
 * `hoistMeta` is keyed by the ARG name (`pathLocal.arg`), because that is what `recognizeArgs`
 * keys by too and it is the join key `mergeHoistedArgs` feeds Gap A/B back through.
 */
export type HoistedBlock = {
  readonly locals: ReadonlyMap<string, PathLocal>;
  readonly hoistMeta: ReadonlyMap<string, HoistMeta>;
  readonly returned: AstNode | undefined;
};

/**
 * A handler block: zero or more hoisted-argument consts, then a single `return`.
 *
 * A block containing anything else — the query branch's `const u = new URL(...)` trio, a stub's
 * `throw` — is a shape THIS recognizer does not model, and is refused rather than partially read.
 * No special case is needed for any of them: a statement that is not a hoist ends `splitHoists`'
 * run like any other unmodeled statement, and `rest` is then longer than the single `return`
 * required below. (server/query.ts models the query branch by taking a different tail off the
 * same split; both tools-rest.ts and tools-hand.ts try this reader first and that one only once
 * this has refused.)
 */
export function recognizeHoistedBlock(body: AstNode): HoistedBlock | undefined {
  const statements = blockBody(body);
  if (statements === undefined || statements.length === 0) return undefined;

  const section = splitHoists(statements);
  // Unchanged from the slice(0, -1) form this replaced: everything before the last statement must
  // be a hoist, and the last must be a `return`. `splitHoists` stops at the first non-hoist, so
  // "exactly one statement left, and it returns" is the same condition stated positively.
  if (section.rest.length !== 1) return undefined;
  const last = section.rest[0]!;
  if (last.type !== "ReturnStatement") return undefined;
  return { locals: section.locals, hoistMeta: section.hoistMeta, returned: returnArgument(last) };
}

/**
 * Gap A / Gap B: `renderZodSchema` never encodes `local` or `default` in the schema text itself
 * (`recognizeArgs` cannot see either), so both are only visible at the hoist statement — merge
 * them back onto the matching arg now that both are known.
 *
 * A hoist naming an arg the schema doesn't declare is an inconsistency this recognizer does not
 * understand — reject the tool (undefined) rather than guess which side is wrong.
 *
 * With no hoists at all the caller's own `toolArgs` is handed straight back, uncopied, exactly
 * as the two inlined copies of this merge did.
 */
export function mergeHoistedArgs(
  toolArgs: Record<string, ArgFields>,
  hoistMeta: ReadonlyMap<string, HoistMeta>,
): Record<string, ArgFields> | undefined {
  if (hoistMeta.size === 0) return toolArgs;

  const mergedArgs = { ...toolArgs };
  for (const [argName, meta] of hoistMeta) {
    const arg = mergedArgs[argName];
    if (arg === undefined) return undefined;
    mergedArgs[argName] = {
      ...arg,
      ...(meta.local !== argName ? { local: meta.local } : {}),
      ...(meta.default !== undefined ? { default: meta.default } : {}),
    };
  }
  return mergedArgs;
}
