/**
 * `bun scripts/check-changelog.ts` — refuse a release whose `## Unreleased` section still holds
 * notes.
 *
 * The driver only. The rule is scripts/_lib/changelog-gate.ts's `unreleasedProblems`, where
 * test/scripts/changelog-gate.test.ts reaches it with no file and no subprocess; what stays here
 * is reading the file and choosing an exit code.
 *
 * Reads CHANGELOG.md relative to the repository root rather than to the process's cwd, so the
 * check cannot silently grade a different file — or no file — depending on where it was invoked
 * from. `.github/workflows/release.yml` runs it directly after Bun is installed and before the
 * ten minutes of typecheck/lint/test/pack below it, and long before `npm publish`: npm cannot
 * unpublish after 72 hours, so a check that runs afterwards reports damage instead of preventing
 * it. That ordering is asserted in test/release-workflow-guard.test.ts.
 *
 * It needs no `bun install`: the only imports are node builtins and one local module.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unreleasedProblems } from "./_lib/changelog-gate.ts";

const CHANGELOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");

function main(): void {
  const problems = unreleasedProblems(readFileSync(CHANGELOG_PATH, "utf8"));
  for (const problem of problems) console.log(problem);

  if (problems.length > 0) {
    // The recovery path is written beside the step in release.yml, where someone reading a failed
    // job will be looking. Repeating it here would be a second copy to go stale.
    console.log(
      "::error::Move the notes under their version and let release-please cut the next patch. " +
        "Publishing by hand loses the provenance attestation and is not the fix.",
    );
    process.exit(1);
  }

  console.log("changelog ok: the Unreleased section holds nothing but its placeholder");
}

// Guarded as every other driver here is, so importing this file neither reads CHANGELOG.md nor
// calls process.exit.
if (import.meta.main) {
  main();
}
