/**
 * Unit tests for the acceptance harnesses' shared verdict report.
 *
 * scripts/acceptance.ts and scripts/standalone-acceptance.ts both collect a `Check[]` and
 * both print it; the loop that turns one into the other was duplicated inline at module
 * scope in each, which is why neither copy had ever been tested. What it decides is small
 * but load-bearing: a PASS/FAIL word, and whether the underlying command's output is shown.
 * Get the second wrong and a red run prints nothing about why it failed.
 */

import { describe, expect, it } from "bun:test";
import { type Check, formatCheckLines } from "../../scripts/_lib/checks.ts";

describe("formatCheckLines", () => {
  it("prints nothing for an empty check list", () => {
    expect(formatCheckLines([])).toEqual([]);
  });

  it("labels a passing check PASS and says nothing else about it", () => {
    // A passing command's stdout is noise — `bun install`'s output on a green run is dozens
    // of lines nobody reads, and printing it buries the failures further down.
    const checks: Check[] = [{ name: "bun install", ok: true, output: "installed 41 packages" }];

    expect(formatCheckLines(checks)).toEqual(["PASS  bun install"]);
  });

  it("labels a failing check FAIL and prints what the command said", () => {
    const checks: Check[] = [{ name: "tsc --noEmit", ok: false, output: "error TS2322: nope" }];

    expect(formatCheckLines(checks)).toEqual(["FAIL  tsc --noEmit", "error TS2322: nope"]);
  });

  it("does not emit a blank line for a failing check that printed nothing", () => {
    // An empty string pushed here reads as a message that went missing — a reader sees FAIL
    // followed by whitespace and looks for output that was never produced. `run()` returns
    // "" for a command that failed silently, so this is a real input, not a hypothetical.
    const checks: Check[] = [{ name: "bun run build", ok: false, output: "" }];

    expect(formatCheckLines(checks)).toEqual(["FAIL  bun run build"]);
  });

  it("keeps the checks in the order they were collected", () => {
    // The harnesses push checks in execution order and the report is read as a timeline:
    // "install passed, tsc passed, lint failed" localises the break. Sorting or grouping
    // would destroy that.
    const checks: Check[] = [
      { name: "bun install", ok: true, output: "" },
      { name: "tsc --noEmit", ok: false, output: "boom" },
      { name: "bun run lint", ok: true, output: "" },
    ];

    expect(formatCheckLines(checks)).toEqual([
      "PASS  bun install",
      "FAIL  tsc --noEmit",
      "boom",
      "PASS  bun run lint",
    ]);
  });
});
