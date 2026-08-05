/**
 * The parser boundary. Everything downstream reads plain structural node types rather than
 * Babel's, so a matcher can be unit-tested against a hand-written object and the parser stays
 * replaceable.
 */
import { parse } from "@babel/parser";

/**
 * A parsed node, carrying ONLY what the infrastructure needs: `claims.ts` compares byte ranges,
 * `blockers.ts` reads the type and line. Every other field is reached through `read.ts`.
 *
 * The absence of an index signature is the enforcement mechanism, not an oversight. With
 * `[key: string]: unknown`, `node["computed"]` and `node["kind"]` typecheck for any key and yield
 * `undefined` for absent ones — and whether that `undefined` rejects or matches depends on which
 * side of a comparison it lands on. Eight defects across five files came from exactly that.
 * Removing it makes an unguarded read a `tsc --noEmit` error.
 */
export type AstNode = {
  readonly type: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly loc?: { start: { line: number } };
};

/**
 * `plugins: ["typescript"]` is required, not optional: connector source carries type
 * annotations and generics that the base parser rejects outright. No `jsx` or `decorators` —
 * neither appears in the corpus, and a plugin list longer than the syntax in play widens what
 * parses without widening what is recognized.
 */
export function parseModule(source: string): AstNode[] {
  const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  return file.program.body as unknown as AstNode[];
}
