/**
 * Member-name extraction for `bun run wiring:conformance`.
 *
 * That harness reads Nimbus's REAL `sync/types.ts` and asserts the emitted skeleton still
 * supplies every member `Syncable` requires. This is the parsing step, split out because the
 * rest of the harness cannot run without an AGPL Nimbus checkout while this needs nothing
 * but a string — and because bunfig.toml's per-file `coverageThreshold` makes "cannot run
 * here" and "must be 78% covered" mutually exclusive in one file.
 */

/**
 * Member names of an `interface X { ... }` block, by brace matching from its opening brace.
 *
 * Regex rather than a TypeScript parser because the shape being read is one flat interface
 * of scalar members, and the failure mode of getting it wrong is loud: an empty member set
 * fails the harness's "parsed no members" check rather than passing vacuously.
 */
export function interfaceMembers(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name} {`);
  if (start === -1) throw new Error(`interface ${name} not found in the real sync/types.ts`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end);
  // `name:` / `name?:` / `name(` at the start of a line, ignoring comments and nesting.
  //
  // Every quantifier here is over a DISJOINT character class, so any input has exactly one
  // parse and the match is linear. The earlier spellings — `\s*\??\s*`, and then
  // `\s*(?:\?\s*)?` — both placed two whitespace quantifiers either side of an optional `?`,
  // so on a line that fails to match (an identifier followed by spaces and no `:`), the
  // leading run backtracks position by position; with the `g` flag over n start positions
  // that is quadratic. Collapsing the tail to the single class `[ \t?]*` removes the
  // ambiguity outright rather than relocating it.
  //
  // `[ \t]` rather than `\s`: `\s` matches `\n`, which under `^…/gm` would let a match run
  // past the end of its own line.
  return [...body.matchAll(/^[ \t]*(?:readonly[ \t]+)?([A-Za-z_]\w*)[ \t?]*[:(]/gm)].map(
    (m) => m[1]!,
  );
}
