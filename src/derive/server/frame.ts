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
 * So the read-only-kit branch removes EXACTLY ONE statement — the wrapper — from
 * `verifyStatements`, splices its callback body in, and never claims the wrapper. The wrapper is
 * still fully verified (the await, the callee, arity 2, the "nimbus-<name>" literal, a
 * single-parameter `(reg) =>` block arrow); it is simply never granted coverage. Every OTHER
 * top-level statement stays in `verifyStatements` and must still be claimed or become a blocker.
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
