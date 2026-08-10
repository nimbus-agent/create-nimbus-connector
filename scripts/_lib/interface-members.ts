/**
 * Member-name extraction for `bun run wiring:conformance`.
 *
 * That harness reads Nimbus's REAL `sync/types.ts` and asserts the emitted skeleton still
 * supplies every member `Syncable` requires. This is the parsing step, split out because the
 * rest of the harness cannot run without an AGPL Nimbus checkout while this needs nothing
 * but a string — and because bunfig.toml's per-file `coverageThreshold` makes "cannot run
 * here" and "must be 78% covered" mutually exclusive in one file.
 */

/** One member of an interface block, and whether the real interface marks it `?`. */
export interface InterfaceMember {
  readonly name: string;
  readonly optional: boolean;
}

/**
 * Members of an `interface X { ... }` block, by brace matching from its opening brace.
 *
 * Regex rather than a TypeScript parser because the shape being read is one flat interface
 * of scalar members, and the failure mode of getting it wrong is loud: an empty member set
 * fails the harness's "parsed no members" check rather than passing vacuously.
 *
 * **Optionality is carried, not discarded**, because the caller's whole question is "must the
 * emitted skeleton supply this". It was discarded once, and the bill arrived twice: first as a
 * hard-coded `bytesTransferred` skip in the `SyncResult` loop, then — when Nimbus's `Syncable`
 * grew an optional `fetchOne` — as a **false red** that failed `preflight` at a gate the
 * generator had not broken. A gate that cries wolf is how the four checkouts-required gates
 * stop being run at all, which is the same disease as a false green with the sign flipped.
 */
export function interfaceMemberDetails(source: string, name: string): InterfaceMember[] {
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
  //
  // The `?` is read by CAPTURING the same `[ \t?]*` run rather than by splitting it into
  // `[ \t]*(\??)[ \t]*`. That split is exactly the two-whitespace-quantifiers-around-an-optional
  // shape the paragraph above removed, so it would reintroduce the quadratic backtracking. A
  // capture group changes what is reported, never what is matched.
  return [...body.matchAll(/^[ \t]*(?:readonly[ \t]+)?([A-Za-z_]\w*)([ \t?]*)[:(]/gm)].map((m) => ({
    name: m[1]!,
    optional: m[2]!.includes("?"),
  }));
}

/** Just the member names, for callers that do not care which are optional. */
export function interfaceMembers(source: string, name: string): string[] {
  return interfaceMemberDetails(source, name).map((m) => m.name);
}
