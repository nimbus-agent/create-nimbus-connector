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
  // The tail is spelled `\s*(?:\?\s*)?` and not `\s*\??\s*`. The two describe the same
  // language — optional whitespace, an optional `?`, optional whitespace — but the second
  // is ambiguous: a run of n spaces before a non-`?` can be split between the two `\s*`
  // in n+1 ways, which is polynomial backtracking on a failing line. Separating the two
  // quantifiers with the mandatory `\?` leaves exactly one parse for any input.
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*(?:\?\s*)?[:(]/gm)].map(
    (m) => m[1]!,
  );
}
