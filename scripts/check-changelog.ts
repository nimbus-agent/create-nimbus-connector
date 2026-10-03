/**
 * `bun scripts/check-changelog.ts` — refuse a release whose `## Unreleased` section still holds
 * notes.
 *
 * The driver only. The rule and the verdict — every line printed, and the exit code — are
 * scripts/_lib/changelog-gate.ts's `changelogVerdict`, where test/scripts/changelog-gate.test.ts
 * reaches them with no file and no subprocess; what stays here is reading the file, printing, and
 * exiting with the code the verdict chose.
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
import { changelogVerdict } from "./_lib/changelog-gate.ts";

const CHANGELOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");

function main(): void {
  const { lines, exitCode } = changelogVerdict(readFileSync(CHANGELOG_PATH, "utf8"));
  for (const line of lines) console.log(line);
  if (exitCode !== 0) process.exit(exitCode);
}

// Guarded as every other driver here is, so importing this file neither reads CHANGELOG.md nor
// calls process.exit.
if (import.meta.main) {
  main();
}
