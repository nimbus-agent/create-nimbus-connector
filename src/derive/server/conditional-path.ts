import type { PathWhen, StaticPathStyle } from "../../spec.ts";
import type { AstNode } from "../ast.ts";
import { binary, blockBody, ifStatement, isIdent, memberOn, returnArgument } from "../read.ts";

/**
 * The inverse of `renderTool`'s guard ladder (src/emit/server/tools-hand.ts):
 *
 *   if (<param>.<absent> === undefined) {
 *     return <the same call the fallthrough makes, around a different path>;
 *   }
 *   ...
 *   return <call>;
 *
 * The emitter writes guard-return, guard-return, fallthrough — never an `else`, never a compound
 * test, never a test other than `=== undefined`. Each of those three is REFUSED here rather than
 * read as a near-miss, and none of the three is a formatting difference:
 *
 *   - an `else` makes the fallthrough conditional, so the ladder's "and otherwise" is no longer
 *     what the module says;
 *   - a compound guard (`<param>.a === undefined && <param>.b === undefined` — semgrep's shape)
 *     means ONE path when ALL of them are absent, where a ladder means a different path PER
 *     argument. Reading it as a ladder would change behaviour, which is why `binary` is the
 *     reader and a LogicalExpression falls out on its own;
 *   - all twelve corpus connectors that branch on an optional argument test `=== undefined` and
 *     nothing else, so any other test is a hand-written shape this generator was never asked to
 *     produce.
 */

/**
 * What the caller's return-shape reader hands back for one `return jsonResult(await …)` —
 * `pathFromJsonResult`'s result (server/tools-hand.ts), named structurally rather than imported.
 *
 * A callback, not an import, and that is the whole reason this module can exist beside its
 * caller: `tools-hand.ts` imports THIS module to try the ladder, so importing its reader back
 * would be a runtime import cycle. Parameterising instead keeps the dependency one-way and keeps
 * the return shape defined exactly once — this module never learns what a `jsonResult(await
 * <helper>(…))` call looks like, only what a LADDER looks like.
 */
export type ReturnReader = (node: AstNode | undefined) =>
  | {
      readonly path: string;
      readonly staticStyle?: StaticPathStyle;
      readonly method?: string;
      readonly bodyNode?: AstNode;
    }
  | undefined;

export type ConditionalPath = {
  readonly pathWhen: PathWhen[];
  /** The final unguarded return's path — the tool's own `path`. */
  readonly path: string;
  /**
   * The one static-path-style vote this tool carries, over the fallthrough AND every guard: all
   * of them go through `renderPath` with the SAME `RenderContext` (src/emit/server/
   * tools-hand.ts), so two paths in one ladder disagreeing about the convention is a module the
   * emitter cannot have written, and is refused rather than voted on with whichever one came
   * first.
   */
  readonly staticStyle?: StaticPathStyle;
};

/**
 * One recovered return, restricted to the READ helper's bodyless one-argument call.
 *
 * A ladder over the WRITE helper is a shape the emitter can write (`pathWhen` is legal on a POST)
 * and this reader deliberately refuses it: every rung repeats `renderBodyExpr`'s output verbatim,
 * so accepting a ladder whose rungs carry bodies would mean pinning those body expressions equal
 * to each other, and nothing at this layer can compare two expression NODES — only the module
 * source could, which the tool recognizers do not have. Reading only the fallthrough's body and
 * ignoring the rungs' would claim a module that re-emits with the wrong body in every guard. A
 * refusal claims nothing and shows up by name in the blocker histogram; a wrong claim does not.
 */
function plainReadPath(
  node: AstNode | undefined,
  readReturn: ReturnReader,
): { path: string; staticStyle?: StaticPathStyle } | undefined {
  const recovered = readReturn(node);
  if (recovered === undefined) return undefined;
  if (recovered.method !== undefined || recovered.bodyNode !== undefined) return undefined;
  return recovered;
}

/** The block-bodied `{ return <call>; }` a guard's consequent always is — nothing else. */
function returnedFromBlock(consequent: AstNode): AstNode | undefined {
  const statements = blockBody(consequent);
  if (statements?.length !== 1) return undefined;
  const only = statements[0]!;
  if (only.type !== "ReturnStatement") return undefined;
  return returnArgument(only);
}

/**
 * One rung: `if (<param>.<absent> === undefined) { return <call>; }`.
 *
 * `param` is an INPUT, never the literal `"p"`. The corpus writes three spellings — measured
 * 2026-08-09 against `packages/mcp-connectors` tree `67c7390a`, by grepping every connector's
 * `src/*.ts` for `async (<name>) =>`: 215 `p`, 92 `parsed`, 4 `data`. (The pattern is not spelled
 * out here: it contains a glob that would close this comment.) A reader hardcoding `p.` would
 * fail 92 handlers SILENTLY — a recognizer that matches
 * nothing simply leaves the connector blocked, which is indistinguishable from a connector that
 * genuinely cannot be read, and every other test in this module's test file would still pass.
 * `tools-hand.ts` already threads the name through for the same reason (`ToolFields.query`'s
 * docstring: "parameterised only by the handler's parameter name").
 *
 * `memberOn` is what pins the receiver: unlike `hoists.ts`'s and `path-template.ts`'s deliberately
 * lax `<anything>.<name>` reads, a guard's test is the ONE place the parameter identity decides
 * whether a statement is a rung at all — `someOtherObject.buildId === undefined` is not a test on
 * this tool's argument, and reading it as one would name a guard after an argument the connector
 * never declared.
 */
function recognizeRung(
  statement: AstNode,
  param: string,
  readReturn: ReturnReader,
): { guard: PathWhen; staticStyle?: StaticPathStyle } | undefined {
  const parts = ifStatement(statement);
  // An `else` is refused before anything else is read: the emitter writes guard-return with no
  // alternate at all, and an if/else says something a ladder cannot.
  if (parts === undefined || parts.alternate !== undefined) return undefined;

  // `binary`, not `logical` — a compound guard is a LogicalExpression and is refused here by node
  // type, which is the refusal this reader most needs to make. See the module docstring.
  const test = binary(parts.test);
  if (test?.operator !== "===" || !isIdent(test.right, "undefined")) return undefined;
  const absent = memberOn(test.left, param);
  if (absent === undefined) return undefined;

  const recovered = plainReadPath(returnedFromBlock(parts.consequent), readReturn);
  if (recovered === undefined) return undefined;
  return { guard: { absent, path: recovered.path }, staticStyle: recovered.staticStyle };
}

/**
 * A run of guard rungs followed by exactly one unguarded `return`, or undefined for anything else
 * — including a handler with NO rung at all, which is the ordinary single-path shape
 * `recognizeHoistedBlock` reads and not this reader's business.
 *
 * `statements` is the handler block's tail, after `splitHoists` has taken the hoisted-argument
 * consts off the front: a guard's path is a path like any other and may name a hoisted local, so
 * the caller resolves those through the `locals` map it binds into `readReturn`.
 */
export function recognizeConditionalPath(
  statements: readonly AstNode[],
  param: string,
  readReturn: ReturnReader,
): ConditionalPath | undefined {
  const pathWhen: PathWhen[] = [];
  const styles = new Set<StaticPathStyle>();

  let i = 0;
  for (; i < statements.length; i++) {
    const rung = recognizeRung(statements[i]!, param, readReturn);
    if (rung === undefined) break;
    pathWhen.push(rung.guard);
    if (rung.staticStyle !== undefined) styles.add(rung.staticStyle);
  }
  if (pathWhen.length === 0) return undefined;

  // Whatever ended the run must be the fallthrough and nothing more. A statement the rung reader
  // refused — an `else`, a compound test — lands here as an extra statement rather than as a
  // silently dropped one, so a near-miss ladder is refused whole instead of read as a shorter one.
  if (statements.length - i !== 1) return undefined;
  const last = statements[i]!;
  if (last.type !== "ReturnStatement") return undefined;

  const fallthrough = plainReadPath(returnArgument(last), readReturn);
  if (fallthrough === undefined) return undefined;
  if (fallthrough.staticStyle !== undefined) styles.add(fallthrough.staticStyle);
  if (styles.size > 1) return undefined;

  const [staticStyle] = styles;
  return {
    pathWhen,
    path: fallthrough.path,
    ...(staticStyle === undefined ? {} : { staticStyle }),
  };
}
