/**
 * The named-verdict record every acceptance harness collects, and its report format.
 *
 * scripts/acceptance.ts and scripts/standalone-acceptance.ts declared the same type and then
 * printed it with the same four-line loop, inline at module scope. Sharing it is the same
 * move scripts/_lib/stdio-rpc.ts made, for the same reason — and it puts the one piece of
 * pure logic in either driver somewhere a test can reach.
 */

/**
 * One named verdict, with whatever the underlying command printed.
 *
 * `skipped` marks the third state: a check that was not run because the question it asks
 * cannot be answered yet. It is NOT a pass — `ok` stays true only so the exit gate does not
 * fail the run — and every caller that prints a summary must report skips separately, or the
 * skip becomes a silent hole in the gate.
 */
export type Check = { name: string; ok: boolean; output: string; skipped?: boolean };

/**
 * The three-state label for one check.
 *
 * `skipped` is tested FIRST and wins outright: a skipped check deliberately carries `ok: true`
 * (see the `Check` docstring) so the exit gate does not fail the run, so reading `ok` first
 * would print every skip as PASS and hide the hole in the gate.
 */
function verdictLabel(c: Check): string {
  if (c.skipped === true) return "SKIP";
  return c.ok ? "PASS" : "FAIL";
}

/**
 * The report lines for a check list, in the order they are printed.
 *
 * A check's output is shown when it FAILED or was SKIPPED and there is something to show: a
 * passing command's stdout is noise, an empty one would print a blank line that reads like a
 * message went missing, and a skip with no stated reason is worse than either.
 */
export function formatCheckLines(checks: readonly Check[]): string[] {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${verdictLabel(c)}  ${c.name}`);
    if ((c.skipped === true || !c.ok) && c.output !== "") lines.push(c.output);
  }
  return lines;
}

/**
 * The whole report for a standalone-acceptance run — every fixture's checks, prefixed with the
 * fixture that produced them, then the verdict — and the exit code that goes with it.
 *
 * The prefix is there because every fixture emits the same check list: unprefixed, two fixtures
 * failing the same check would print two identical FAIL lines and name neither.
 *
 * **The verdict sentence is the point.** A run with skips exits 0 — the skipped question is
 * unanswerable, not failed — but it must never print the sentence a fully-verified run prints,
 * so it names the fixtures it skipped instead. "All standalone acceptance checks passed" over a
 * silently reduced fixture set is precisely how a gate stops gating without anyone noticing,
 * which is also why a run that checked nothing at all fails rather than reporting success. A run
 * with a failure prints no verdict sentence at all: the FAIL lines are the report.
 */
export function standaloneReport(
  byFixture: ReadonlyArray<{ readonly fixture: string; readonly checks: readonly Check[] }>,
): { lines: string[]; exitCode: 0 | 1 } {
  const lines = formatCheckLines(
    byFixture.flatMap(({ fixture, checks }) =>
      checks.map((c) => ({ ...c, name: `[${fixture}] ${c.name}` })),
    ),
  );
  const all = byFixture.flatMap((f) => f.checks);
  if (all.length === 0) {
    lines.push("", "No standalone acceptance checks ran. Refusing to report a pass.");
    return { lines, exitCode: 1 };
  }
  if (all.some((c) => !c.ok)) return { lines, exitCode: 1 };

  const skipped = byFixture
    .filter((f) => f.checks.some((c) => c.skipped === true))
    .map((f) => f.fixture);
  if (skipped.length > 0) {
    lines.push(
      "",
      `Standalone acceptance passed for every fixture it could run, and SKIPPED ${skipped.length}: ${skipped.join(", ")}.`,
      "Those fixtures are NOT verified against the registry by this run.",
    );
    return { lines, exitCode: 0 };
  }
  lines.push("", "All standalone acceptance checks passed.");
  return { lines, exitCode: 0 };
}

/**
 * Whether a failed `bun install` in --registry mode means "this fixture's declared SDK floor
 * is not published yet" rather than "something is broken".
 *
 * The case is real and recurring: a fixture exercising a not-yet-released SDK export declares
 * the floor that will carry it, and until that release lands there is no version to install.
 * The registry gate's question — "does the artifact on the registry satisfy the contract?" —
 * is genuinely unanswerable for that fixture, and answering "no" would be wrong. Stage D's
 * `zzsearch` and `zzsearchstub` were the first instance: they needed `@nimbus-dev/sdk ^1.15.0`
 * while the search kit was still an unmerged branch.
 *
 * **Deliberately narrow, in the failing direction.** Both the exact declared range and the
 * package name must appear in bun's own unresolvable-range message. A registry outage, a 500,
 * a missing package, a frozen lockfile — none of them match, and all still fail the run. If
 * bun rewords the message this predicate stops matching and the gate goes back to failing,
 * which is the safe way round for a check whose whole value is that it can go red.
 *
 * Self-healing by construction: nothing here names a version or a fixture, so the moment the
 * release lands the install succeeds and the checks run for real, with no edit to re-enable.
 */
export function isUnpublishedFloorFailure(installOutput: string, declaredRange: string): boolean {
  return installOutput.includes(
    `No version matching "${declaredRange}" found for specifier "@nimbus-dev/sdk"`,
  );
}
