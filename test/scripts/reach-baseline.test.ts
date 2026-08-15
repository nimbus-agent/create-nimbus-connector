import { describe, expect, it } from "bun:test";
import {
  assertComparable,
  baselineScopeRefusal,
  buildBaseline,
  compareBaseline,
  connectorsTreeRefusal,
  requireDeriveToolchain,
  resolveComparableTree,
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

describe("resolveComparableTree", () => {
  // The comparability preamble, hoisted here so `scripts/reach.ts` (which compares against the
  // baseline) and `scripts/reach-baseline.ts` (which writes it) cannot disagree about whether a
  // checkout may be compared at all. Both harnesses need a Nimbus checkout and neither runs in
  // CI — but `git` is injected, precisely so the decision logic is reachable without one.
  const fakeGit =
    (responses: Record<string, { value: string; error: string }>) =>
    (_root: string, args: string[]) =>
      responses[args.join(" ")] ?? { value: "", error: `unstubbed: ${args.join(" ")}` };

  const CLEAN = {
    "rev-parse HEAD": { value: "abc1234", error: "" },
    "status --porcelain -- packages/mcp-connectors": { value: "", error: "" },
    "rev-parse HEAD:packages/mcp-connectors": { value: "f4e9d93d", error: "" },
  };

  it("returns the tree and HEAD for a clean, readable checkout", () => {
    expect(resolveComparableTree("/nimbus", fakeGit(CLEAN))).toEqual({
      connectorsTree: "f4e9d93d",
      head: "abc1234",
    });
  });

  it("refuses a dirty packages/mcp-connectors rather than measuring it", () => {
    const result = resolveComparableTree(
      "/nimbus",
      fakeGit({
        ...CLEAN,
        "status --porcelain -- packages/mcp-connectors": {
          value: " M packages/mcp-connectors/sentry/src/server.ts",
          error: "",
        },
      }),
    );
    expect(result).toHaveProperty("refusal");
  });

  it("routes a FAILED git status to the refusal, never reading it as clean", () => {
    // The bug this preserves through the hoist: `status.value` is "" both when the tree is
    // clean and when the command failed, so `status.error` — not just `head.error` — has to
    // reach assertComparable. Miss it and the dirty gate silently disappears.
    const result = resolveComparableTree(
      "/nimbus",
      fakeGit({
        ...CLEAN,
        "status --porcelain -- packages/mcp-connectors": {
          value: "",
          error: "fatal: not a git repository",
        },
      }),
    );
    expect(result).toHaveProperty("refusal");
    expect((result as { refusal: string }).refusal).toMatch(/not a git repository/);
  });

  it("refuses when HEAD itself cannot be read", () => {
    const result = resolveComparableTree(
      "/nimbus",
      fakeGit({ ...CLEAN, "rev-parse HEAD": { value: "", error: "fatal: bad revision" } }),
    );
    expect(result).toHaveProperty("refusal");
  });

  it("refuses when the connectors tree object cannot be resolved", () => {
    // Otherwise the tree key becomes "", which reads as a valid key on both sides.
    const result = resolveComparableTree(
      "/nimbus",
      fakeGit({
        ...CLEAN,
        "rev-parse HEAD:packages/mcp-connectors": {
          value: "",
          error: "fatal: not a valid object name",
        },
      }),
    );
    expect(result).toHaveProperty("refusal");
    expect((result as { refusal: string }).refusal).toMatch(/packages\/mcp-connectors/);
  });
});

describe("requireDeriveToolchain", () => {
  it("resolves when Biome and Babel are both present", async () => {
    // Both are devDependencies, so this is the path every real run takes. It is worth pinning
    // because the alternative is silent: without the parser every connector derives as
    // blocked:parse-error, and `reach:baseline` would WRITE that false 0/94 as the baseline.
    expect(await requireDeriveToolchain()).toBeUndefined();
  });

  const working = {
    initFormatter: async () => undefined,
    formatterAvailable: () => true,
    formatterUnavailableReason: () => "unused",
    initParser: async () => undefined,
    parserAvailable: () => true,
    parserUnavailableReason: () => "unused",
  };

  it("refuses without Biome, naming the byte-compare reason", async () => {
    // Not interchangeable with the parser refusal below: an absent formatter makes the
    // byte-comparison report spurious diffs that read as REACH REGRESSIONS, so the message
    // has to say so or a developer chases a corpus change that never happened.
    await expect(
      requireDeriveToolchain({
        ...working,
        formatterAvailable: () => false,
        formatterUnavailableReason: () => "biome not installed",
      }),
    ).rejects.toThrow(/@biomejs\/biome is required here[\s\S]*biome not installed/);
  });

  it("refuses without Babel before deriving anything", async () => {
    // The dangerous one. Without the parser every connector derives as blocked:parse-error,
    // so `reach:baseline` would RECORD a corpus-wide zero as the baseline and every later
    // run would compare green against it. Failing loudly here is what prevents that.
    await expect(
      requireDeriveToolchain({
        ...working,
        parserAvailable: () => false,
        parserUnavailableReason: () => "babel not installed",
      }),
    ).rejects.toThrow(/@babel\/parser is required here[\s\S]*babel not installed/);
  });

  it("checks the formatter FIRST, so the parser is never initialised without it", async () => {
    let parserInitialised = false;
    await expect(
      requireDeriveToolchain({
        ...working,
        formatterAvailable: () => false,
        formatterUnavailableReason: () => "biome not installed",
        initParser: async () => {
          parserInitialised = true;
          return undefined;
        },
      }),
    ).rejects.toThrow(/@biomejs/);
    expect(parserInitialised).toBe(false);
  });
});
