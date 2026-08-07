import type { AstNode } from "../ast.ts";

export type FrameStyle = "hand-rolled" | "read-only-kit" | "rest-kit";

/**
 * What frame recognition recovers, and the two statement lists it hands downstream.
 *
 * The two lists exist because claims are byte ranges and coverage is CONTAINMENT. That is
 * load-bearing elsewhere — it lets one matcher claim a multi-statement construct — and a hazard
 * here: read-only-kit nests its registrations inside
 * `await runReadOnlyMcpConnector("nimbus-x", (reg) => { ... })`, so claiming that statement would
 * cover every registration transitively, the totality rule would find nothing unclaimed, and a
 * connector whose tools were never recognized would derive successfully. A false `emits`, produced
 * by the very mechanism the totality rule exists to remove.
 *
 * So the read-only-kit branch removes EXACTLY ONE statement from `verifyStatements`, splices that
 * statement's registration body in, and never claims it. It is still fully verified; it is simply
 * never granted coverage. Every OTHER top-level statement stays in `verifyStatements` and must
 * still be claimed or become a blocker.
 *
 * WHICH statement is spliced depends on which of the two read-only entry shapes the module writes
 * (`recognizeReadOnlyFrame`, server/index.ts) — the rule is identical either way, which is the
 * point:
 *
 * - the inline wrapper this generator emits: the `await runReadOnlyMcpConnector(...)` call itself,
 *   verified down to the await, the callee, arity 2, the "nimbus-<name>" literal and a
 *   single-parameter `(reg) =>` block arrow;
 * - the named registrar ten corpus connectors write (`namedReadOnlyEntry`): the
 *   `export function register<X>Tools(reg: ZodToolRegistrar)` DECLARATION, whose body carries the
 *   registrations. Its two companion statements — `startConnector` and the `import.meta.main`
 *   guard — nest no registration, so they are claimed outright rather than spliced.
 *
 * Marking a spliced statement claimed "once its body statements are claimed" is the
 * obvious-looking alternative to removing it, and it is exactly the hazard above: the claim is
 * retroactive over everything inside the range. Removing it from `verifyStatements` is the whole
 * mechanism; there is no second step.
 *
 * For hand-rolled and rest-kit both lists are the module's own statement list.
 */
export type Frame = {
  readonly name: string;
  readonly style: FrameStyle;
  /** What the tool recognizers scan. */
  readonly toolStatements: readonly AstNode[];
  /** What the totality rule walks. */
  readonly verifyStatements: readonly AstNode[];
};
