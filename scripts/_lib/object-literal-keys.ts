/**
 * Top-level key extraction from the emitted `*-sync.ts` object literal, for
 * `bun run wiring:conformance`.
 *
 * Split out for the same two reasons `interface-members.ts` is: the rest of that harness cannot
 * run without an AGPL Nimbus checkout while this needs nothing but a string, and bunfig.toml's
 * per-file `coverageThreshold` makes "cannot run here" and "must be covered" mutually exclusive
 * in one file.
 *
 * **Why scoping matters — this closes a false green.** The harness used to ask whether the whole
 * emitted file matched `\bsync\s*[:(]`. It always did, and not because the skeleton supplied the
 * member: the file's own generated docstring says "sync() below throws", which satisfies the
 * pattern as English. Renaming the emitted method to `syncMUTANT` left the gate PASSING. The
 * harness's second check had already been scoped to a template literal for exactly this reason,
 * with a comment saying so; the first check kept the bug the comment describes.
 */

/**
 * The keys an object literal supplies at its own top level, comments and nested scopes excluded.
 *
 * Depth-tracked rather than indentation-matched because emitters return UNFORMATTED source —
 * `formatAll()` runs Biome afterwards, so the indentation this sees is the template's, not the
 * output's, and pinning a column count here would be pinning the wrong thing.
 *
 * A method's SIGNATURE sits at depth 1 while its body sits at depth 2, so `sync(...) {` is
 * reported and everything it throws, comments, or interpolates is not.
 */
export function objectLiteralKeys(source: string, opener: string): string[] {
  const at = source.indexOf(opener);
  if (at === -1) throw new Error(`no \`${opener}\` object literal found`);
  const open = source.indexOf("{", at);
  if (open === -1) throw new Error(`\`${opener}\` is not followed by an opening brace`);

  let depth = 0;
  let closed = false;
  let topLevel = "";
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "{") {
      depth++;
      if (depth === 1) continue; // the literal's own opening brace
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        closed = true;
        break;
      }
    }
    if (depth === 1) topLevel += ch;
  }
  if (!closed) throw new Error(`\`${opener}\` object literal is unterminated`);

  // Comments are stripped rather than depth-skipped: a `//` line inside the literal is at depth
  // 1, so prose in it would otherwise read as a key exactly the way the file docstring did.
  const code = topLevel.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return [...code.matchAll(/([A-Za-z_]\w*)[ \t?]*[:(]/g)].map((m) => m[1]!);
}
