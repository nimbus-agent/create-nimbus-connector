/**
 * The parser boundary. Everything downstream reads plain structural node types rather than
 * Babel's, so a matcher can be unit-tested against a hand-written object and the parser stays
 * replaceable.
 */
import { parse } from "@babel/parser";

export type AstNode = {
  type: string;
  start: number | null;
  end: number | null;
  loc?: { start: { line: number } };
  [key: string]: unknown;
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
