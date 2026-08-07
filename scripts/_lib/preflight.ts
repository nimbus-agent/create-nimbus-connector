/**
 * The local gate sequence, as a decision rather than a script: which gate runs, in what order,
 * whether the run may call itself fully verified, and which of PASS/FAIL/SKIP each gate is
 * printed as.
 *
 * ## Why an aggregator is the most dangerous thing in this repository
 *
 * Every gate here exists because something passed while asserting nothing, and several of them
 * were rewritten more than once as the next hole opened. A *preflight* inherits all of that and
 * adds a new failure mode one level up: four of the eight gates need a checkout of the AGPL
 * Nimbus monorepo, which most machines and every CI runner lack, so the obvious implementation —
 * run what you can, print "preflight passed" — reports a HALF run in the words of a whole one.
 * That would not be a gate with a hole in it; it would be a gate that manufactures false greens
 * for four other gates at once.
 *
 * Two things prevent it, and both are asserted in test/scripts/preflight.test.ts rather than
 * trusted:
 *
 *   1. **A missing root SKIPS loudly, by name.** The four gates stay in the report with
 *      `status: "skip"` and a reason naming `--nimbus-root`. They are never dropped from the
 *      results — a gate that vanishes is one nobody notices is missing — and never folded into
 *      the pass count. `scripts/_lib/checks.ts` draws the same three-state distinction for the
 *      same reason, and `scripts/standalone-acceptance.ts` is where the pattern was set.
 *   2. **`fullyVerified` is true only when every gate has `status === "pass"`.** It is the sole
 *      thing `verdict` below is allowed to gate its success sentence on, so "skip" can never
 *      reach a sentence that means "everything ran". Computing it as "nothing failed" would be
 *      the bug: a skip is not a failure, which is exactly why it must not read as a pass either.
 *
 * ## Why the root is not sniffed for
 *
 * `resolveNimbusRoot` finds a sibling `Nimbus/` checkout without being told, and every one of
 * the four gates uses it. Preflight deliberately does not: it runs the four only when the caller
 * names a root. Otherwise the same command means eight gates on one machine and four on the
 * next, and the sentence it prints would mean two different things depending on what happens to
 * sit beside the checkout. An explicit flag makes "preflight is fully verified" one claim.
 *
 * ## Why the driver is a driver
 *
 * Everything decidable from the arguments alone lives here, where a test reaches it with an
 * injected `run` and nothing spawns; `scripts/preflight.ts` keeps only the parts that need a
 * subprocess. That is this directory's standing convention, and `scripts/_lib/build-schema.ts`'s
 * header explains the second reason it matters: a driver no test imports never enters the
 * coverage report at all, so logic left inline behind an `import.meta.main` guard is logic no
 * per-file floor is measuring.
 *
 * The rule is easier to state than to hold to. `verdict` was moved here on it and `toCheck` was
 * left behind, which put the whole PASS/FAIL/SKIP label mapping — the eight lines a reader
 * actually scans — back in the driver where nothing could reach it. See `toCheck`'s docstring for
 * what that cost when it was measured.
 */

import { takeValue } from "../../src/cli.ts";
import type { Check } from "./checks.ts";

export type GateStatus = "pass" | "fail" | "skip";

/** One gate's verdict. `reason` is required in practice for anything that is not a pass. */
export type GateResult = { name: string; status: GateStatus; reason?: string };

export type PreflightReport = { results: GateResult[]; fullyVerified: boolean };

/** The one thing this module cannot decide for itself, injected so tests need no subprocess. */
export type RunGate = (cmd: string[]) => { exitCode: number };

/**
 * A gate, split on whether it needs the monorepo — the discriminant, not a boolean beside an
 * always-present root, so the type system enforces that only a `needsRoot` gate can ask for one
 * and that it cannot be handed an empty placeholder when there is none.
 */
export type Gate =
  | { name: string; needsRoot: false; command: () => string[] }
  | { name: string; needsRoot: true; command: (nimbusRoot: string) => string[] };

/**
 * The sequence, in the order it runs. Order is not cosmetic here:
 *
 * - The three CI gates come first because they are the ones a change breaks most often and the
 *   cheapest to run; a broken typecheck should not cost a corpus regeneration to discover.
 * - `bun test --coverage` is separate from `bun test` rather than replacing it, because the two
 *   fail for different reasons and a single line saying "tests" would conflate them. Bun only
 *   evaluates `bunfig.toml`'s per-file `coverageThreshold` when the run carries `--coverage`
 *   (test/coverage-gate.test.ts pins that), so this entry is the coverage floor and the one
 *   above it is the suite. When this fails and that passed, no test broke — a file dropped below
 *   its floor.
 * - The four monorepo gates come last because they are the slow ones and the ones that can be
 *   skipped, so a run that will skip them still reports the rest at full speed.
 * - `acceptance` comes last of those four on a hard constraint, not a preference: it generates
 *   `zzscratch` into `packages/mcp-connectors/` and removes it again, and `reach --baseline`
 *   REFUSES to compare (exit 2) against a dirty `packages/mcp-connectors`. Run in the other
 *   order, a crashed acceptance leaves a tree that makes the reach gate refuse rather than
 *   measure.
 *
 * `acceptance` takes its root as a POSITIONAL, unlike the other three — see scripts/acceptance.ts's
 * `main`, which reads `argv[0]`. Passing `--nimbus-root` to it would resolve to a directory named
 * `--nimbus-root`, so the command shapes are pinned by name in test/scripts/preflight.test.ts.
 *
 * **Exported because the prose gate lists are graded against it.** Seven Markdown documents and
 * one workflow comment enumerate these gates for a reader, and until test/gate-lists.test.ts
 * existed they were unrelated text that merely happened to agree with this array — which is how
 * `reach --baseline` came to be named in two canonical lists while four others described the
 * local gate set without it. That test derives what each document must name from this array, and
 * from the `needsRoot` split, rather than transcribing the names a second time.
 *
 * Note that test/scripts/preflight.test.ts deliberately does the OPPOSITE and transcribes them
 * independently. The two are not in tension: that file is asking whether this module behaves as
 * specified, where reading the list back would only prove the module agrees with itself, while
 * the docs gate is asking whether two artifacts agree, where a third transcription is just one
 * more thing to drift.
 */
export const GATES: readonly Gate[] = [
  { name: "bun test", needsRoot: false, command: () => ["bun", "test"] },
  { name: "tsc --noEmit", needsRoot: false, command: () => ["bunx", "tsc", "--noEmit"] },
  {
    name: "biome check",
    needsRoot: false,
    command: () => ["bunx", "biome", "check", "src/", "test/", "scripts/"],
  },
  { name: "bun test --coverage", needsRoot: false, command: () => ["bun", "test", "--coverage"] },
  {
    name: "diff:golden",
    needsRoot: true,
    command: (root) => ["bun", "run", "diff:golden", "--nimbus-root", root],
  },
  {
    name: "reach --baseline",
    needsRoot: true,
    command: (root) => ["bun", "run", "reach", "--baseline", "--nimbus-root", root],
  },
  {
    name: "wiring:conformance",
    needsRoot: true,
    command: (root) => ["bun", "run", "wiring:conformance", "--nimbus-root", root],
  },
  { name: "acceptance", needsRoot: true, command: (root) => ["bun", "run", "acceptance", root] },
];

/** The number of gates, for a driver that wants to say how much of the sequence it ran. */
export const GATE_COUNT = GATES.length;

const NO_ROOT_REASON =
  "needs a checkout of the Nimbus monorepo, which this run was not given. Pass " +
  "--nimbus-root <path> to run it. Nothing about this gate is verified by this run.";

/**
 * Run the sequence and report every gate, whatever happened to it.
 *
 * Stops at the first failure — a broken typecheck makes the corpus gates meaningless, and
 * running them anyway buys minutes of output nobody will read — but the gates it did not reach
 * stay in the results as skips naming the gate that stopped them, rather than disappearing. The
 * report is total: eight gates in, eight verdicts out, always.
 */
export function runPreflight(opts: { nimbusRoot?: string; run: RunGate }): PreflightReport {
  const results: GateResult[] = [];
  let stoppedBy: string | undefined;

  for (const gate of GATES) {
    if (stoppedBy !== undefined) {
      results.push({
        name: gate.name,
        status: "skip",
        reason: `not run: ${stoppedBy} failed, and preflight stops at the first failure`,
      });
      continue;
    }

    let cmd: string[];
    if (gate.needsRoot) {
      if (opts.nimbusRoot === undefined) {
        results.push({ name: gate.name, status: "skip", reason: NO_ROOT_REASON });
        continue;
      }
      cmd = gate.command(opts.nimbusRoot);
    } else {
      cmd = gate.command();
    }

    const { exitCode } = opts.run(cmd);
    if (exitCode === 0) {
      results.push({ name: gate.name, status: "pass" });
    } else {
      results.push({
        name: gate.name,
        status: "fail",
        reason: `\`${cmd.join(" ")}\` exited ${exitCode}`,
      });
      stoppedBy = gate.name;
    }
  }

  // Not "nothing failed". A skip is not a failure — the question it asks was never put — but it
  // is emphatically not a pass, and this is the single value the driver's success sentence hangs
  // on. Written the other way, `bun run preflight` with no root would print the sentence that
  // means all eight gates are green while four of them had not run.
  return { results, fullyVerified: results.every((r) => r.status === "pass") };
}

/**
 * The closing paragraph — which is to say, the one sentence in this whole command that a reader
 * will actually quote back as evidence.
 *
 * It lives here rather than in the driver for exactly that reason. Choosing between "fully
 * verified" and "skipped four" IS the false-green decision this module exists to make, and left
 * inline behind the driver's `import.meta.main` guard it would be a decision no test could reach
 * and no coverage floor could see — scripts/_lib/build-schema.ts's header makes the same argument
 * for the same reason. Written here, `test/scripts/preflight.test.ts` can assert the thing that
 * matters most: that the success sentence is unreachable from any report that is not
 * `fullyVerified`, whatever the reason.
 *
 * Total over all three shapes a run can end in, so there is no report the driver could hold for
 * which this returns nothing and the run ends silently.
 */
export function verdict(report: PreflightReport): string {
  const failed = report.results.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    const notRun = report.results.filter((r) => r.status === "skip").length;
    return (
      `Preflight FAILED at ${failed.map((r) => r.name).join(", ")}. ` +
      `${notRun} later gate(s) were not run, so nothing is known about them either.`
    );
  }

  // The `fullyVerified` branch, and the reason the field exists. A run with skips exits 0 — the
  // questions it did not ask are unanswerable here, not failed — and it must never print the
  // sentence a complete run prints. Naming the skipped gates is the point: "preflight passed"
  // over a silently reduced gate set is precisely how a gate stops gating without anyone noticing,
  // which is the wording scripts/standalone-acceptance.ts's own skip path settled on.
  if (!report.fullyVerified) {
    const skipped = report.results.filter((r) => r.status === "skip").map((r) => r.name);
    return (
      `Preflight passed every gate it could run, and SKIPPED ${skipped.length}: ${skipped.join(", ")}.` +
      "\nThose gates are NOT verified by this run. Re-run with --nimbus-root <path> to a Nimbus" +
      " checkout to cover them."
    );
  }

  return (
    `Preflight fully verified: all ${GATE_COUNT} gates ran and passed, including the four that` +
    " need the Nimbus monorepo."
  );
}

/**
 * The other half of the false-green decision: which of PASS / FAIL / SKIP a gate's result is
 * PRINTED as.
 *
 * `verdict` above decides the closing sentence; this decides the eight lines above it, which is
 * what a reader scans and what gets pasted into a pull request. The two are computed from the
 * report independently — nothing makes the list agree with the sentence — so leaving this in the
 * driver left the aggregator's per-gate report on the untested side of the seam this file's header
 * draws. It was measured, not supposed: rewriting `skipped` to a constant `false` printed
 * `PASS  diff:golden` for four gates that never ran, with the whole suite green, because a skip
 * deliberately carries `ok: true` (see `Check`'s docstring) so the exit gate does not fail the
 * run. `formatCheckLines` reads `skipped` before `ok` for exactly that reason, and this is the
 * function that has to hand it something true.
 *
 * Reuses scripts/_lib/checks.ts's three-state record rather than printing a second one, so a SKIP
 * looks the same here as it does in the acceptance harnesses.
 */
export function toCheck(r: GateResult): Check {
  return {
    name: r.name,
    ok: r.status !== "fail",
    output: r.reason ?? "",
    skipped: r.status === "skip",
  };
}

/**
 * `bun run preflight`'s argument parsing, here rather than in the driver on the
 * scripts/_lib/reach-baseline.ts precedent: `main()` cannot be reached by a test without
 * spawning eight subprocesses, so parsing left there is parsing nothing measures.
 *
 * An unrecognised argument is refused rather than ignored, and that is the point of the function
 * existing at all. Silently dropping `--nimbus_root` would produce a run that skips four gates
 * while the caller believes they asked for them — a loud skip is only honest when the caller
 * meant to skip.
 */
export function parseArgs(argv: readonly string[]): { nimbusRoot?: string } {
  let nimbusRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nimbus-root") {
      nimbusRoot = takeValue(argv, ++i, "--nimbus-root");
    } else {
      throw new Error(
        `preflight accepts only --nimbus-root; got "${a}". Without it the four gates that need ` +
          "the Nimbus monorepo are skipped by name, and the run does not report itself as " +
          "fully verified.",
      );
    }
  }
  return { nimbusRoot };
}
