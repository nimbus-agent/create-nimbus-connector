import { describe, expect, it } from "bun:test";
import {
  assertComparable,
  baselineScopeRefusal,
  buildBaseline,
  compareBaseline,
  connectorsTreeRefusal,
} from "../../scripts/_lib/reach-baseline.ts";

const results = [
  { name: "newrelic", tier: "all-identical" as const, blockers: [] },
  { name: "netlify", tier: "emits" as const, blockers: [] },
];

describe("buildBaseline", () => {
  it("records the connectors tree and every connector's tier", () => {
    expect(buildBaseline("f4e9d93d", results)).toEqual({
      connectorsTree: "f4e9d93d",
      tiers: { newrelic: "all-identical", netlify: "emits" },
    });
  });
});

describe("assertComparable", () => {
  it("allows a clean checkout", () => {
    expect(assertComparable({ commit: "f4e9d93d", dirty: false })).toBeUndefined();
  });

  it("refuses a dirty checkout, because the commit would describe bytes that are not there", () => {
    expect(assertComparable({ commit: "f4e9d93d", dirty: true })).toMatch(/dirty/i);
  });

  it("refuses when the root is not a git checkout", () => {
    expect(assertComparable({ commit: "", dirty: false })).toMatch(/not a git checkout/i);
  });

  it("names git itself as the problem when git could not run at all", () => {
    const message = assertComparable({ commit: "", dirty: false, gitError: "spawn git ENOENT" });
    expect(message).toMatch(/spawn git ENOENT/);
    expect(message).not.toMatch(/not a git checkout/i);
  });
});

describe("compareBaseline", () => {
  const baseline = buildBaseline("f4e9d93d", results);

  it("refuses to compare across connector trees rather than producing a verdict", () => {
    const out = compareBaseline(baseline, results, "0000000");
    expect(out.refusal).toMatch(/f4e9d93d/);
    expect(out.regressions).toEqual([]);
  });

  it("reports nothing when every tier holds", () => {
    expect(compareBaseline(baseline, results, "f4e9d93d")).toEqual({ regressions: [] });
  });

  it("reports a connector that lost a tier", () => {
    const worse = [{ name: "newrelic", tier: "emits" as const, blockers: [] }, results[1]!];
    expect(compareBaseline(baseline, worse, "f4e9d93d").regressions).toEqual([
      { name: "newrelic", from: "all-identical", to: "emits" },
    ]);
  });

  it("does not report an improvement as a regression", () => {
    const better = [
      results[0]!,
      { name: "netlify", tier: "server-identical" as const, blockers: [] },
    ];
    expect(compareBaseline(baseline, better, "f4e9d93d").regressions).toEqual([]);
  });

  it("treats a connector missing from the run as a regression to blocked", () => {
    const out = compareBaseline(baseline, [results[0]!], "f4e9d93d");
    expect(out.regressions).toEqual([{ name: "netlify", from: "emits", to: "blocked" }]);
  });
});

describe("baselineScopeRefusal", () => {
  // compareBaseline's own "treats a connector missing from the run as a regression to blocked"
  // test above is exactly the mechanism this guards against: `bun run reach --baseline
  // newrelic` measures ONLY newrelic, so every other baselined connector is "missing from the
  // run" and compareBaseline reads each one as having regressed — invented regressions from a
  // legal, narrower invocation.
  it("allows --baseline with no connector names", () => {
    expect(baselineScopeRefusal([], true)).toBeUndefined();
  });

  it("allows connector names when --baseline is not set", () => {
    expect(baselineScopeRefusal(["newrelic"], false)).toBeUndefined();
  });

  it("refuses --baseline combined with one or more connector names", () => {
    const message = baselineScopeRefusal(["newrelic"], true);
    expect(message).toMatch(/--baseline/);
    expect(message).toMatch(/newrelic/);
  });

  it("names every connector given, not just the first", () => {
    expect(baselineScopeRefusal(["newrelic", "datadog"], true)).toMatch(/newrelic, datadog/);
  });
});

describe("connectorsTreeRefusal", () => {
  it("allows a successful lookup", () => {
    expect(connectorsTreeRefusal("")).toBeUndefined();
  });

  it("refuses a failed lookup rather than letting an empty tree key through silently", () => {
    // A swallowed error here becomes the tree key "" — which reach-baseline.ts would then
    // WRITE as the baseline's connectorsTree and reach.ts would then COMPARE against, an
    // empty string being a valid-looking key rather than a visible failure.
    const message = connectorsTreeRefusal("fatal: not a valid object name HEAD");
    expect(message).toMatch(/fatal: not a valid object name HEAD/);
    expect(message).toMatch(/packages\/mcp-connectors/);
  });
});
