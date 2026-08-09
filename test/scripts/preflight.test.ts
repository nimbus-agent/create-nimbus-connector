/**
 * `bun run preflight` is a gate AGGREGATOR, so it can go false-green one level up from where
 * every other gate in this repo can: a run that quietly omitted four gates and printed success
 * would be the worst instance of the failure mode this project exists to refuse.
 *
 * So these tests are aimed at the aggregator's own failure modes rather than at the gates it
 * calls: that the four monorepo gates SKIP by name, that `fullyVerified` is false whenever
 * anything did not pass, that a failure stops the sequence, and — the one that is easiest to
 * leave out — that each gate actually runs the command its NAME claims. A gate called
 * "diff:golden" that shelled out to `bun test` would satisfy every other assertion here.
 *
 * `run` is injected, so nothing spawns: the whole decision is a pure function of the exit codes
 * it is handed, which is also what keeps scripts/_lib/preflight.ts inside the per-file coverage
 * floor without a Nimbus checkout.
 */

import { describe, expect, it } from "bun:test";
import { formatCheckLines } from "../../scripts/_lib/checks.ts";
import {
  parseArgs,
  type RunGate,
  runPreflight,
  toCheck,
  verdict,
} from "../../scripts/_lib/preflight.ts";

const ok = () => ({ exitCode: 0 });

/**
 * The gate list, transcribed INDEPENDENTLY of scripts/_lib/preflight.ts's own `GATES`.
 *
 * Reading the implementation's list and checking the report against it would assert only that
 * the module agrees with itself — the self-referential shape test/source-hygiene.test.ts's
 * `MUST_BE_CAUGHT` docstring describes, where mutating the set failed nothing. Written out here,
 * a gate that is added, removed, renamed or reordered fails this file until someone decides that
 * was intended.
 */
const EXPECTED_GATES = [
  "bun test",
  "tsc --noEmit",
  "biome check",
  "bun test --coverage",
  "diff:golden",
  "reach --baseline",
  "wiring:conformance",
  "acceptance",
];

describe("preflight", () => {
  it("reports the four monorepo gates as SKIP, by name, when no root is given", () => {
    const report = runPreflight({ run: ok });
    const skipped = report.results.filter((r) => r.status === "skip").map((r) => r.name);
    expect(skipped).toEqual([
      "diff:golden",
      "reach --baseline",
      "wiring:conformance",
      "acceptance",
    ]);
  });

  it("does NOT claim full verification when anything skipped", () => {
    expect(runPreflight({ run: ok }).fullyVerified).toBe(false);
  });

  it("claims full verification only when every gate ran and passed", () => {
    expect(runPreflight({ nimbusRoot: "/x", run: ok }).fullyVerified).toBe(true);
  });

  it("does not claim full verification when a gate failed", () => {
    const run = (cmd: string[]) => ({ exitCode: cmd.includes("tsc") ? 1 : 0 });
    expect(runPreflight({ nimbusRoot: "/x", run }).fullyVerified).toBe(false);
  });

  it("stops at the first failure, so a broken typecheck does not run the corpus gates", () => {
    const seen: string[] = [];
    const run = (cmd: string[]) => {
      seen.push(cmd.join(" "));
      return { exitCode: cmd.includes("tsc") ? 1 : 0 };
    };
    runPreflight({ nimbusRoot: "/x", run });
    expect(seen.some((c) => c.includes("diff:golden"))).toBe(false);
  });

  it("runs the exact command each gate is NAMED for, threading the root into the four", () => {
    // The assertion the four above cannot make between them. Every one of them is satisfied by
    // eight gates that all shell out to `true`: they check the bookkeeping around the commands,
    // never the commands. This pins what is actually executed, and it is where a wrong flag
    // (`--nimbus-root` where `acceptance` takes a positional, a dropped `--baseline`) shows up.
    const seen: string[][] = [];
    runPreflight({
      nimbusRoot: "/x",
      run: (cmd) => {
        seen.push(cmd);
        return { exitCode: 0 };
      },
    });
    expect(seen.map((c) => c.join(" "))).toEqual([
      "bun test",
      "bunx tsc --noEmit",
      "bunx biome check src/ test/ scripts/",
      "bun test --coverage",
      "bun run diff:golden --nimbus-root /x",
      "bun run reach --baseline --nimbus-root /x",
      "bun run wiring:conformance --nimbus-root /x",
      "bun run acceptance /x",
    ]);
  });

  it("names every gate in the report exactly once, in order, whatever happened", () => {
    // Totality, in both shapes a run can take. A gate that vanishes from the report because it
    // was skipped or because the sequence stopped early is a gate nobody notices is missing —
    // and the aggregator's whole job is that the reader can see all eight verdicts.
    const failEarly = (cmd: string[]) => ({ exitCode: cmd.includes("tsc") ? 1 : 0 });
    for (const report of [
      runPreflight({ run: ok }),
      runPreflight({ nimbusRoot: "/x", run: ok }),
      runPreflight({ nimbusRoot: "/x", run: failEarly }),
    ]) {
      expect(report.results.map((r) => r.name)).toEqual(EXPECTED_GATES);
    }
  });

  it("gives every non-passing gate a reason, so no SKIP is a bare name", () => {
    // A skip with no stated reason is worse than a failure: it reads as an entry someone
    // forgot to fill in. scripts/_lib/checks.ts's formatCheckLines prints the reason line only
    // when there is one, so an empty reason silently prints nothing at all.
    //
    // Swept over BOTH shapes, because the two skips come from different code paths and a
    // failing-run-only check cannot see the missing-root one at all — emptying that reason
    // failed nothing here until this loop was added.
    const reports = [
      runPreflight({ run: ok }),
      runPreflight({ nimbusRoot: "/x", run: (c) => ({ exitCode: c.includes("tsc") ? 1 : 0 }) }),
    ];
    const unexplained = reports
      .flatMap((r) => r.results)
      .filter((r) => r.status !== "pass" && !(r.reason ?? "").trim());
    expect(unexplained.map((r) => r.name)).toEqual([]);
  });

  it("tells a skipping run how to un-skip it, by naming --nimbus-root", () => {
    const skipped = runPreflight({ run: ok }).results.filter((r) => r.status === "skip");
    expect(skipped).toHaveLength(4);
    for (const r of skipped) expect(r.reason).toContain("--nimbus-root");
  });

  it("marks the gates after a failure as not-run rather than as passed", () => {
    const report = runPreflight({
      nimbusRoot: "/x",
      run: (cmd) => ({ exitCode: cmd.includes("tsc") ? 1 : 0 }),
    });
    const byName = new Map(report.results.map((r) => [r.name, r.status]));
    expect(byName.get("tsc --noEmit")).toBe("fail");
    // The three that had already passed keep their verdict; everything after the failure is a
    // skip. If these read "pass", the report would claim four corpus gates ran on a run that
    // never called them.
    expect(byName.get("bun test")).toBe("pass");
    expect(byName.get("biome check")).toBe("skip");
    expect(byName.get("diff:golden")).toBe("skip");
  });

  it("reports the failing gate's exit code, rather than only that it failed", () => {
    const report = runPreflight({
      nimbusRoot: "/x",
      run: (cmd) => ({ exitCode: cmd.includes("tsc") ? 2 : 0 }),
    });
    expect(report.results.find((r) => r.name === "tsc --noEmit")?.reason).toContain("2");
  });
});

/**
 * The sentence, which is the only part of this command anyone will quote as evidence.
 *
 * `runPreflight` deciding `fullyVerified` correctly is worth nothing if the closing paragraph is
 * chosen from something else — which is why that choice is a function here rather than an `if` in
 * the driver, where no test could reach it.
 */
describe("the verdict sentence", () => {
  const FULLY_VERIFIED = /fully verified/i;

  it("claims full verification for a run where every gate passed", () => {
    expect(verdict(runPreflight({ nimbusRoot: "/x", run: ok }))).toMatch(FULLY_VERIFIED);
  });

  it("never claims full verification for a run that skipped or failed anything", () => {
    // The assertion this whole file is built around. It is written as a sweep over every
    // non-verified shape rather than as one case, because the hole would not be "the skip branch
    // is wrong" — it would be a fourth shape nobody wrote a branch for falling through to the
    // success text.
    const failing = (cmd: string[]) => ({ exitCode: cmd.includes("tsc") ? 1 : 0 });
    const shapes = [
      { name: "no root, so four skipped", report: runPreflight({ run: ok }) },
      { name: "a gate failed", report: runPreflight({ nimbusRoot: "/x", run: failing }) },
      { name: "no root AND a gate failed", report: runPreflight({ run: failing }) },
    ];
    for (const s of shapes) expect(s.report.fullyVerified).toBe(false);
    const claimed = shapes.filter((s) => FULLY_VERIFIED.test(verdict(s.report))).map((s) => s.name);
    expect(claimed).toEqual([]);
  });

  it("names the skipped gates, so the hole is on screen rather than implied", () => {
    const text = verdict(runPreflight({ run: ok }));
    for (const gate of ["diff:golden", "reach --baseline", "wiring:conformance", "acceptance"]) {
      expect(text).toContain(gate);
    }
    expect(text).toContain("NOT verified");
  });

  it("names the failing gate, and says the later ones were not run", () => {
    const report = runPreflight({
      nimbusRoot: "/x",
      run: (cmd) => ({ exitCode: cmd.includes("tsc") ? 1 : 0 }),
    });
    expect(verdict(report)).toContain("tsc --noEmit");
    expect(verdict(report)).toContain("not run");
  });
});

/**
 * The eight lines above the sentence — the part a reader actually scans, and the part that gets
 * pasted into a pull request as evidence.
 *
 * `verdict` and this report are computed independently: nothing makes the list agree with the
 * sentence, so a correct sentence is not a guard on a wrong list. `toCheck` lived in
 * `scripts/preflight.ts` until it was measured, and nothing imports that driver, so it was reached
 * by no test at all: rewriting `skipped` to a constant `false` — which reads as a simplification,
 * because a skip already carries `ok: true` — made `bun run preflight` with no `--nimbus-root`
 * print `PASS  diff:golden` for four gates that never ran, with the whole suite green.
 */
describe("the per-gate report", () => {
  const linesFor = (opts: { nimbusRoot?: string; run: RunGate }): string[] =>
    formatCheckLines(runPreflight(opts).results.map(toCheck));

  it("renders a skipped gate as SKIP, never as PASS", () => {
    const lines = linesFor({ run: ok });
    expect(lines.filter((l) => l.startsWith("SKIP  ")).map((l) => l.slice(6))).toEqual([
      "diff:golden",
      "reach --baseline",
      "wiring:conformance",
      "acceptance",
    ]);
    for (const gate of ["diff:golden", "reach --baseline", "wiring:conformance", "acceptance"]) {
      expect(
        lines.some((l) => l === `PASS  ${gate}`),
        `${gate} must not print as PASS`,
      ).toBe(false);
    }
  });

  it("still renders a gate that ran and passed as PASS, so SKIP is not the constant", () => {
    // The other direction, and not decoration: `skipped: true` for everything would satisfy the
    // assertion above while reporting a fully verified run as eight skips.
    const lines = linesFor({ nimbusRoot: "/x", run: ok });
    expect(lines.filter((l) => l.startsWith("PASS  "))).toHaveLength(8);
    expect(lines.some((l) => l.startsWith("SKIP"))).toBe(false);
  });

  it("renders a failed gate as FAIL, and carries its exit code onto the screen", () => {
    const lines = linesFor({
      nimbusRoot: "/x",
      run: (cmd) => ({ exitCode: cmd.includes("tsc") ? 3 : 0 }),
    });
    expect(lines).toContain("FAIL  tsc --noEmit");
    expect(lines.some((l) => l.includes("exited 3"))).toBe(true);
  });

  it("puts every skip's reason on screen, rather than a bare label", () => {
    // `formatCheckLines` prints the output line only when there is one, so a `toCheck` that
    // dropped `reason` would print four unexplained SKIPs and fail nothing else here.
    const lines = linesFor({ run: ok });
    expect(lines.filter((l) => l.includes("--nimbus-root"))).toHaveLength(4);
  });
});

describe("preflight argument parsing", () => {
  it("reads --nimbus-root", () => {
    expect(parseArgs(["--nimbus-root", "C:/gitrep/Nimbus"])).toEqual({
      nimbusRoot: "C:/gitrep/Nimbus",
    });
  });

  it("leaves the root undefined when the flag is absent", () => {
    expect(parseArgs([]).nimbusRoot).toBeUndefined();
  });

  it("refuses an unknown argument instead of ignoring it", () => {
    // The failure this closes: a typo such as --nimbus_root would otherwise parse as "no root",
    // and the run would skip four gates while the caller believed they had asked for them. A
    // loud skip is only honest if the caller meant to skip.
    expect(() => parseArgs(["--nimbus_root", "C:/gitrep/Nimbus"])).toThrow(/--nimbus-root/);
  });

  it("refuses --nimbus-root with no value", () => {
    expect(() => parseArgs(["--nimbus-root"])).toThrow(/requires a value/);
  });
});
