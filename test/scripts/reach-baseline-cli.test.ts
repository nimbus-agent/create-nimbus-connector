/**
 * Unit tests for scripts/reach-baseline.ts's own argument parsing.
 *
 * `main()` is not covered here and cannot be, the same reason golden-diff.test.ts's own comment
 * gives for scripts/diff-golden.ts: it needs a real Nimbus checkout and calls process.exit.
 * `parseArgs` is a plain function guarded behind `import.meta.main`, so importing this module in
 * a test does not run it — matching the existing scripts/diff-golden.ts precedent.
 *
 * Before the fix this test pins, reach-baseline.ts reused scripts/reach.ts's permissive
 * `parseArgs` and only ever read its `nimbusRoot` field — so `bun run reach:baseline newrelic`
 * or `bun run reach:baseline --verbose` silently dropped the name/flag and rewrote the FULL
 * baseline anyway, looking like a scoped run that never happened. This command always measures
 * and records the whole corpus; there is no scoped-baseline format for it to honor, so it now
 * refuses anything besides `--nimbus-root`.
 */

import { describe, expect, it } from "bun:test";
import { parseArgs } from "../../scripts/_lib/reach-baseline.ts";

describe("reach-baseline.ts parseArgs", () => {
  it("returns no root for an empty argv", () => {
    expect(parseArgs([])).toEqual({ nimbusRoot: undefined });
  });

  it("reads --nimbus-root's value", () => {
    expect(parseArgs(["--nimbus-root", "/some/path"])).toEqual({ nimbusRoot: "/some/path" });
  });

  it("rejects --nimbus-root with nothing after it rather than silently using undefined", () => {
    expect(() => parseArgs(["--nimbus-root"])).toThrow("--nimbus-root requires a value");
  });

  it("rejects a positional connector name instead of silently measuring the full corpus anyway", () => {
    expect(() => parseArgs(["newrelic"])).toThrow(/reach:baseline accepts only --nimbus-root/);
  });

  it("rejects --baseline, which reach.ts accepts but this command has no use for", () => {
    expect(() => parseArgs(["--baseline"])).toThrow(/reach:baseline accepts only --nimbus-root/);
  });

  it("rejects --verbose", () => {
    expect(() => parseArgs(["--verbose"])).toThrow(/reach:baseline accepts only --nimbus-root/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--nimbus-rot"])).toThrow(/reach:baseline accepts only --nimbus-root/);
  });
});
