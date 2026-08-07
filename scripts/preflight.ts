/**
 * `bun run preflight` — the local gate sequence, in one command.
 *
 * The gates were always separate commands, four of them need a checkout of the AGPL Nimbus
 * monorepo, and the order between two of them matters. That is a sequence a person runs from
 * memory or a list, which means the failure mode is not a gate going red but a gate quietly not
 * being run at all.
 *
 * This is the driver only. Which gate runs, in what order, whether the run may call itself fully
 * verified, and which of PASS/FAIL/SKIP each gate is printed as are all decided in
 * scripts/_lib/preflight.ts, where a test reaches them with an injected `run` and nothing spawns
 * — read that file's header for why an AGGREGATOR is the most dangerous shape in this repository,
 * and what stops it printing a whole run's words over a half run. `toCheck` in particular used to
 * live here, which put the SKIP-vs-PASS label on the untested side of that seam.
 *
 * What stays here is what needs subprocesses: spawning each command with inherited stdio, so the
 * gate's own output — `diff:golden`'s per-fixture counts above all — reaches the screen as it
 * would have if it had been run directly. A preflight that swallowed that output and printed
 * PASS would be asking to be trusted about the very thing the underlying gate exists to show.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCheckLines } from "./_lib/checks.ts";
import { GATE_COUNT, parseArgs, runPreflight, toCheck, verdict } from "./_lib/preflight.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function main(argv: readonly string[]): void {
  const { nimbusRoot } = parseArgs(argv);

  console.log(`Preflight: ${GATE_COUNT} gates, in order.`);
  console.log(
    nimbusRoot === undefined
      ? "Nimbus root: none given — the four gates that need the monorepo will SKIP.\n"
      : `Nimbus root: ${nimbusRoot}\n`,
  );

  const report = runPreflight({
    nimbusRoot,
    run: (cmd) => {
      // Echoed before it runs, so the wall of inherited output that follows is attributable to a
      // gate. It also puts the exact command line on screen for a reader who wants to re-run one
      // of them on its own.
      console.log(`\n$ ${cmd.join(" ")}`);
      const r = Bun.spawnSync(cmd, {
        cwd: repoRoot,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      // A gate killed by a signal — a Ctrl-C, an OOM kill mid-corpus — has no exit code worth
      // reading, so it is a failure whatever landed in `exitCode`. Bun types `exitCode` as
      // non-nullable and `?? 1` guards a value the type says cannot occur; `?? 0` in either
      // position would be the quietest available way to turn a killed gate green.
      return { exitCode: r.signalCode === undefined ? (r.exitCode ?? 1) : 1 };
    },
  });

  console.log("");
  for (const line of formatCheckLines(report.results.map(toCheck))) console.log(line);

  // Which sentence this is — and in particular that the fully-verified one is unreachable unless
  // every gate passed — is decided in _lib/preflight.ts's `verdict`, under test. Printed before
  // the exit so a failing run also ends with a line saying what happened, rather than with the
  // last gate's stderr.
  console.log(`\n${verdict(report)}`);

  if (report.results.some((r) => r.status === "fail")) process.exit(1);
}

// Guarded as every other driver here is, so importing this file does not run eight subprocesses
// and call process.exit. `bun scripts/preflight.ts [--nimbus-root <path>]` is unaffected —
// import.meta.main is true for the entry point.
if (import.meta.main) {
  main(process.argv.slice(2));
}
