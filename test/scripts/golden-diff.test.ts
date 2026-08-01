/**
 * Unit tests for the byte-diff harness's decision logic.
 *
 * `diff:golden` is the check this project leans on hardest — it is the only thing that
 * compares generated output against the real hand-written connectors in the Nimbus
 * monorepo — and until scripts/diff-golden.ts was guarded behind `import.meta.main`, not one
 * line of it could be reached from a test. Importing it generated every fixture and could
 * call `process.exit`.
 *
 * The parts under test here are the ones that decide PASS or FAIL: which fixtures get
 * compared, which files count as identical, and what the verdict line says. A harness that
 * mis-decides any of those reports green while the emitter has regressed, which is the exact
 * failure this repo keeps designing against. `main()` is not covered and is not here — it
 * needs an AGPL Nimbus checkout that CI does not have, which is why diff:golden is a script
 * rather than a test in the first place, and why the logic below lives in scripts/_lib/.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareFixture,
  deltaNote,
  diffAgainstReal,
  parseArgs,
  passNote,
  readFixtureSpec,
  selectFixtures,
  unifiedDiff,
  verdictLine,
} from "../../scripts/_lib/golden-diff.ts";
import { generate } from "../../src/emit/index.ts";
import {
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../../src/format.ts";
import type { Comparison } from "../../src/golden/expectations.ts";
import { parseSpec } from "../../src/spec.ts";
import type { GeneratedFile } from "../../src/types.ts";
import { displayPath } from "../../src/types.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

const fixturesDir = join(import.meta.dir, "..", "..", "fixtures");

describe("parseArgs", () => {
  it("returns no names and no root for an empty argv", () => {
    expect(parseArgs([])).toEqual({ names: [], nimbusRoot: undefined });
  });

  it("collects bare arguments as fixture names, in order", () => {
    expect(parseArgs(["discord", "sentry"]).names).toEqual(["discord", "sentry"]);
  });

  it("reads --nimbus-root's value and does not also treat it as a fixture name", () => {
    // The `++i` that consumes the value is the whole point: without it the path would be
    // pushed onto `names` and the harness would try to compare a fixture called
    // "/some/path", failing with a message that names the wrong thing.
    const parsed = parseArgs(["--nimbus-root", "/some/path", "discord"]);

    expect(parsed).toEqual({ names: ["discord"], nimbusRoot: "/some/path" });
  });

  it("rejects --nimbus-root with nothing after it rather than silently using undefined", () => {
    expect(() => parseArgs(["--nimbus-root"])).toThrow("--nimbus-root requires a value");
  });

  it("rejects an unknown flag instead of collecting it as a fixture name", () => {
    // A typo'd flag that fell through to `names` would produce "No fixture named
    // --nimbus-rot", which reads like a missing fixture rather than a mistyped flag.
    expect(() => parseArgs(["--nimbus-rot", "x"])).toThrow("Unknown flag: --nimbus-rot");
  });
});

describe("unifiedDiff", () => {
  it("prints nothing when the two texts agree", () => {
    expect(unifiedDiff("a\nb\nc", "a\nb\nc")).toBe("");
  });

  it("prints the expected line then the actual line for each differing line", () => {
    expect(unifiedDiff("a\nold\nc", "a\nnew\nc")).toBe("    - old\n    + new");
  });

  it("prints only + lines for text the actual output has and the expected does not", () => {
    // `e[i]` is undefined past the end of the shorter side; printing "- undefined" there
    // would read as a line the real connector has, which is the opposite of the truth.
    expect(unifiedDiff("a", "a\nextra")).toBe("    + extra");
  });

  it("prints only - lines for text the expected output has and the actual does not", () => {
    expect(unifiedDiff("a\ndropped", "a")).toBe("    - dropped");
  });

  it("caps the report at 40 lines so one rewritten file cannot bury the others", () => {
    const expected = Array.from({ length: 100 }, (_, i) => `old-${i}`).join("\n");
    const actual = Array.from({ length: 100 }, (_, i) => `new-${i}`).join("\n");

    const out = unifiedDiff(expected, actual).split("\n");

    expect(out).toHaveLength(40);
    expect(out[0]).toBe("    - old-0");
    expect(out.at(-1)).toBe("    + new-19");
  });
});

describe("passNote", () => {
  it("adds nothing when the fixture is fully declared and has no stubs", () => {
    expect(passNote(6, 6, 0)).toBe("");
  });

  it("marks a fixture whose declared identical set is smaller than the file count", () => {
    expect(passNote(3, 6, 0)).toBe(" (expected partial)");
  });

  it("counts stub tools", () => {
    expect(passNote(6, 6, 2)).toBe(" (2 stub tool(s))");
  });

  it("joins both notes into one parenthetical", () => {
    expect(passNote(3, 6, 2)).toBe(" (expected partial, 2 stub tool(s))");
  });
});

describe("deltaNote", () => {
  it("says nothing when nothing moved", () => {
    expect(deltaNote([], [])).toBe("");
  });

  it("names the files that stopped matching", () => {
    expect(deltaNote(["package.json"], [])).toBe("no longer matching package.json");
  });

  it("names the files that started matching", () => {
    expect(deltaNote([], ["README.md"])).toBe("newly matching README.md");
  });

  it("reports both halves of a two-way change, separated", () => {
    // This is the case a bare identical-file COUNT cannot distinguish from a pass, which is
    // why classify() compares sets. The note has to name both halves or the failure is not
    // actionable.
    expect(deltaNote(["a.ts", "b.ts"], ["c.ts"])).toBe(
      "no longer matching a.ts, b.ts; newly matching c.ts",
    );
  });
});

describe("selectFixtures", () => {
  it("compares exactly the fixtures named on the command line", () => {
    expect(selectFixtures(["sentry"], ["datadog", "discord", "sentry"])).toEqual(["sentry"]);
  });

  it("compares every discovered fixture when none is named", () => {
    expect(selectFixtures([], ["datadog", "discord"])).toEqual(["datadog", "discord"]);
  });

  it("copies rather than aliasing the caller's array", () => {
    const all = ["datadog"];

    const selected = selectFixtures([], all);
    selected.push("mutated");

    expect(all).toEqual(["datadog"]);
  });

  it("refuses to report a pass when there is nothing to compare", () => {
    // The silent-pass failure mode this harness exists to prevent, reached through an empty
    // fixture directory rather than a missing monorepo: returning [] here would make main()
    // print "All fixtures match their declared expectations" having compared none.
    expect(() => selectFixtures([], [])).toThrow(/Refusing to report a pass with nothing compared/);
  });

  it("passes an unrecognised name straight through rather than rejecting it here", () => {
    // Pinning what the code DOES, which is not what its "No fixture name(s) matched anything
    // to run" branch suggests. That throw is unreachable: a non-empty `names` is returned by
    // the early return above it, so a mistyped fixture surfaces one level down instead, as
    // readFixtureSpec's `No fixture named "discrod"`.
    //
    // Asserting the reachable behaviour is what keeps this honest — an assertion aimed at
    // the dead branch could never fail, and would read as coverage of a check that is not
    // actually there.
    expect(selectFixtures(["discrod"], ["datadog", "discord"])).toEqual(["discrod"]);
  });
});

describe("readFixtureSpec", () => {
  it("parses a checked-in fixture spec", () => {
    const spec = readFixtureSpec("discord", join(fixturesDir, "discord.spec.json"));

    expect(spec.name).toBe("discord");
    expect(spec.tools.length).toBeGreaterThan(0);
  });

  it("names the fixture and the path it looked for when the spec is not there", () => {
    const path = join(fixturesDir, "nosuchfixture.spec.json");

    expect(() => readFixtureSpec("nosuchfixture", path)).toThrow(
      `No fixture named "nosuchfixture" — expected ${path}`,
    );
  });

  it("lets a malformed spec surface as a parse error rather than 'no fixture named'", () => {
    // Only readFileSync is wrapped. A spec file that exists but is corrupt is a different
    // problem from a missing one, and reporting it as "No fixture named x" would send the
    // reader looking for a file that is sitting right there.
    const dir = tmp.make("cnc-diffgolden-badspec-");
    const path = join(dir, "broken.spec.json");
    writeFileSync(path, "{ not json", "utf8");

    expect(() => readFixtureSpec("broken", path)).not.toThrow(/No fixture named/);
    expect(() => readFixtureSpec("broken", path)).toThrow();
  });
});

describe("diffAgainstReal", () => {
  const files: GeneratedFile[] = [
    { path: ["README.md"], content: "same\n" },
    { path: ["src", "server.ts"], content: "generated\n" },
    { path: ["tsconfig.json"], content: "{}\n" },
  ];

  function realTree(): string {
    const dir = tmp.make("cnc-diffgolden-real-");
    writeFileSync(join(dir, "README.md"), "same\n", "utf8");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "server.ts"), "hand-written\n", "utf8");
    return dir;
  }

  it("reports byte-identical files by their forward-slash display path", () => {
    const { identicalPaths } = diffAgainstReal(files, realTree());

    expect(identicalPaths).toEqual(["README.md"]);
  });

  it("reports a differing file as DIFF, with the diff body", () => {
    const { problems } = diffAgainstReal(files, realTree());

    expect(problems).toContain("  DIFF     src/server.ts\n    - hand-written\n    + generated");
  });

  it("reports a file the real connector does not have as MISSING", () => {
    const { problems } = diffAgainstReal(files, realTree());

    expect(problems).toContain("  MISSING  tsconfig.json — not present in the real connector");
  });

  it("does not count a CRLF real file as differing from LF generated output", () => {
    // The emitter always writes LF. A Nimbus checkout on Windows with core.autocrlf=true
    // has CRLF on disk, so without the normalisation EVERY file in EVERY fixture would
    // report DIFF and the harness would be useless on half its supported platforms.
    const dir = tmp.make("cnc-diffgolden-crlf-");
    writeFileSync(join(dir, "README.md"), "line one\r\nline two\r\n", "utf8");

    const { identicalPaths, problems } = diffAgainstReal(
      [{ path: ["README.md"], content: "line one\nline two\n" }],
      dir,
    );

    expect(identicalPaths).toEqual(["README.md"]);
    expect(problems).toEqual([]);
  });
});

describe("verdictLine", () => {
  const pass: Comparison = { verdict: "pass", lost: [], gained: [] };

  it("reports a pass with the identical-file count", () => {
    expect(
      verdictLine({
        name: "sentry",
        identical: 6,
        total: 6,
        stubs: 0,
        expectedCount: 6,
        comparison: pass,
      }),
    ).toBe("PASS  sentry  6/6 files identical");
  });

  it("carries the partial and stub notes onto the pass line", () => {
    expect(
      verdictLine({
        name: "discord",
        identical: 3,
        total: 6,
        stubs: 2,
        expectedCount: 3,
        comparison: pass,
      }),
    ).toBe("PASS  discord  3/6 files identical (expected partial, 2 stub tool(s))");
  });

  it("reports a regression without telling the reader to update expectations.json", () => {
    // A regression is the emitter's fault, not the expectations file's. Advising an
    // expectations edit here would be advising someone to paper over a real defect.
    const line = verdictLine({
      name: "sentry",
      identical: 5,
      total: 6,
      stubs: 0,
      expectedCount: 6,
      comparison: { verdict: "regressed", lost: ["package.json"], gained: [] },
    });

    expect(line).toBe(
      "FAIL  sentry  5/6 files identical — regressed: no longer matching package.json",
    );
  });

  it("tells the reader to update expectations.json when the emitter improved", () => {
    const line = verdictLine({
      name: "discord",
      identical: 4,
      total: 6,
      stubs: 1,
      expectedCount: 3,
      comparison: { verdict: "improved", lost: [], gained: ["README.md"] },
    });

    expect(line).toBe(
      "FAIL  discord  4/6 files identical, 1 stub tool(s) — improved: newly matching README.md; " +
        "update fixtures/expectations.json and the design doc's criterion-2 gap report",
    );
  });

  it("names both halves of a two-way change", () => {
    const line = verdictLine({
      name: "grafana",
      identical: 3,
      total: 6,
      stubs: 0,
      expectedCount: 3,
      comparison: { verdict: "changed", lost: ["a.ts"], gained: ["b.ts"] },
    });

    expect(line).toContain("changed: no longer matching a.ts; newly matching b.ts");
    expect(line.startsWith("FAIL  grafana  3/6 files identical — ")).toBe(true);
  });
});

describe("compareFixture", () => {
  beforeAll(async () => {
    await initFormatter();
    if (!formatterAvailable()) {
      throw new Error(
        "@biomejs/biome is required here — compareFixture runs the generated files through " +
          `formatAll, and unformatted output would not be the bytes the harness compares. ${formatterUnavailableReason()}`,
      );
    }
  });

  /**
   * A root with no connector in it. Every generated file then comes back MISSING, which is a
   * real, fully determined outcome — the same one a wrong --nimbus-root produces — rather
   * than a stand-in, so the composition can be asserted without an AGPL Nimbus checkout.
   */
  const emptyRoot = () => tmp.make("cnc-diffgolden-root-");

  it("passes when the declared expectation is that nothing matches", () => {
    const result = compareFixture("discord", emptyRoot(), { discord: [] });

    expect(result.failed).toBe(false);
    expect(result.line.startsWith("PASS  discord  0/")).toBe(true);
  });

  it("reports every generated file as MISSING against a root with no connector", () => {
    const result = compareFixture("discord", emptyRoot(), { discord: [] });

    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.every((p) => p.startsWith("  MISSING  "))).toBe(true);
    expect(result.problems.some((p) => p.includes("src/server.ts"))).toBe(true);
  });

  it("fails when a file declared identical is not", () => {
    const result = compareFixture("discord", emptyRoot(), { discord: ["package.json"] });

    expect(result.failed).toBe(true);
    expect(result.line).toContain("regressed: no longer matching package.json");
  });

  it("looks for the real connector under packages/mcp-connectors/<name>", () => {
    // Without this the harness could read the right bytes from the wrong place and still
    // look correct against an empty root — every file comes back MISSING either way. So
    // plant one generated file at the exact path compareFixture is supposed to compute and
    // require it to be found: pointing realDir anywhere else turns this back into MISSING.
    const root = tmp.make("cnc-diffgolden-planted-");
    const spec = parseSpec(
      JSON.parse(readFileSync(join(fixturesDir, "discord.spec.json"), "utf8")),
    );
    const generated = formatAll(generate(spec));
    const readme = generated.find((f) => displayPath(f.path) === "README.md")!;
    const connectorDir = join(root, "packages", "mcp-connectors", "discord");
    mkdirSync(connectorDir, { recursive: true });
    writeFileSync(join(connectorDir, "README.md"), readme.content, "utf8");

    const result = compareFixture("discord", root, { discord: ["README.md"] });

    expect(result.failed).toBe(false);
    expect(result.problems.some((p) => p.includes("README.md"))).toBe(false);
    // The whole line, so the counts it composes are pinned too: discord declares four tools
    // of which exactly one has impl "stub", and one of its six generated files was planted.
    expect(result.line).toBe(
      `PASS  discord  1/${generated.length} files identical (expected partial, 1 stub tool(s))`,
    );
  });

  it("refuses to compare a fixture that has no declared expectation", () => {
    // An undeclared fixture must not be able to pass by accident: with no entry there is
    // nothing to compare its identical set against, so the only safe answer is to stop.
    expect(() => compareFixture("discord", emptyRoot(), {})).toThrow(
      /No expectation declared for fixture "discord"/,
    );
  });
});
