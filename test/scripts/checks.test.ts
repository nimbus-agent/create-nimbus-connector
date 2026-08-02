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
import {
  type Check,
  formatCheckLines,
  isUnpublishedFloorFailure,
} from "../../scripts/_lib/checks.ts";

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

  it("labels a skipped check SKIP and prints why", () => {
    // A skip is neither outcome: the check did not pass, and reporting it as FAIL would make
    // a known-unanswerable question look like a defect. The reason is always printed —
    // a silent skip is how a gate quietly stops gating.
    const checks: Check[] = [
      {
        name: "bun install",
        ok: true,
        skipped: true,
        output: "@nimbus-dev/sdk ^1.15.0 is not on the registry yet",
      },
    ];

    expect(formatCheckLines(checks)).toEqual([
      "SKIP  bun install",
      "@nimbus-dev/sdk ^1.15.0 is not on the registry yet",
    ]);
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

/**
 * The one condition under which a --registry fixture is unanswerable rather than broken: it
 * declares an SDK floor that is not published yet. Narrow on purpose — every other install
 * failure is a real failure, and a predicate that generalised even slightly would turn the
 * registry gate into a gate that passes when the registry is down.
 */
describe("isUnpublishedFloorFailure", () => {
  const real =
    "bun install v1.3.14 (0d9b296a)\n" +
    'error: No version matching "^1.15.0" found for specifier "@nimbus-dev/sdk" (but package exists)\n' +
    "error: @nimbus-dev/sdk@^1.15.0 failed to resolve";

  it("recognises bun's unresolvable-range message for the declared range", () => {
    expect(isUnpublishedFloorFailure(real, "^1.15.0")).toBe(true);
  });

  it("rejects it when the range named is not the one the package declared", () => {
    // Guards against reading someone else's unresolvable dependency as ours and skipping a
    // fixture that genuinely failed.
    expect(isUnpublishedFloorFailure(real, "^1.11.0")).toBe(false);
  });

  it("rejects a message about a different package", () => {
    expect(
      isUnpublishedFloorFailure(
        'error: No version matching "^1.15.0" found for specifier "zod" (but package exists)',
        "^1.15.0",
      ),
    ).toBe(false);
  });

  it("rejects every other install failure", () => {
    for (const other of [
      "error: failed to resolve: ENOTFOUND registry.npmjs.org",
      "error: GET https://registry.npmjs.org/@nimbus-dev/sdk - 500",
      'error: package "@nimbus-dev/sdk" not found',
      "error: lockfile had changes, but lockfile is frozen",
      "",
    ]) {
      expect(isUnpublishedFloorFailure(other, "^1.15.0")).toBe(false);
    }
  });

  it("does not treat a published floor's successful install as a skip", () => {
    expect(isUnpublishedFloorFailure("41 packages installed", "^1.11.0")).toBe(false);
  });
});
