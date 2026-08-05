/**
 * The parser boundary. Everything downstream reads plain structural node types rather than
 * Babel's, so a matcher can be unit-tested against a hand-written object and the parser stays
 * replaceable.
 *
 * `@babel/parser` is an optionalDependency (src/derive/ has lived under `src/` — and therefore
 * shipped to npm — since Task 2), so it is loaded through a dynamic `import()` rather than a
 * static top-level one. A static import here would make a missing optional dependency break
 * every command, including plain generation, which never touches this module.
 */
import { isMissingModule } from "../optional-dep.ts";

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

const PARSER = "@babel/parser";

type ParseFn = (
  source: string,
  options: { sourceType: "module"; plugins: readonly string[] },
) => { program: { body: unknown[] } };

let parse: ParseFn | undefined;
let initialised = false;
let unavailableReason: string | undefined;

/**
 * Why the parser could not load. Exported because it is the only pure part of the load path:
 * @babel/parser cannot be made unresolvable in-process in a repo that depends on it, so the two
 * messages would otherwise go untested and the misdiagnosis could regress unnoticed.
 *
 * Unlike the formatter, this dependency has no degraded mode — there is no partial derivation
 * without an AST — so callers FAIL with this message rather than continuing. Do not "fix" that
 * into a silent fallback.
 */
export function parserUnavailableReasonFor(err: unknown): string {
  if (isMissingModule(err, PARSER)) {
    return (
      `${PARSER} is not installed. It is an optionalDependency, needed only by ` +
      `--from-connector. Install it with \`bun add ${PARSER}\`, or reinstall without ` +
      "omitting optional dependencies."
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `${PARSER} is installed but failed to load, so a connector cannot be read. ` +
    `Underlying error: ${detail}`
  );
}

/** Load the parser if present. Idempotent, and never throws — callers check parserAvailable(). */
export async function initParser(): Promise<void> {
  if (initialised) return;
  initialised = true;
  try {
    ({ parse } = (await import(PARSER)) as { parse: ParseFn });
    unavailableReason = undefined;
  } catch (err) {
    parse = undefined;
    unavailableReason = parserUnavailableReasonFor(err);
  }
}

export function parserAvailable(): boolean {
  return parse !== undefined;
}

export function parserUnavailableReason(): string | undefined {
  return parse === undefined ? unavailableReason : undefined;
}

/**
 * `plugins: ["typescript"]` is required, not optional: connector source carries type
 * annotations and generics that the base parser rejects outright. No `jsx` or `decorators` —
 * neither appears in the corpus, and a plugin list longer than the syntax in play widens what
 * parses without widening what is recognized.
 */
export function parseModule(source: string): AstNode[] {
  if (parse === undefined) {
    throw new Error(unavailableReason ?? `${PARSER} not initialised — call initParser() first.`);
  }
  const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  return file.program.body as unknown as AstNode[];
}
