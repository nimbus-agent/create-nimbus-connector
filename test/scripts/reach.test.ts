import { describe, expect, it } from "bun:test";
import { histogram, selectConnectors, summaryLines, tierFor } from "../../scripts/_lib/reach.ts";

const SPEC = { name: "x" };
const OK = { ok: true as const, spec: SPEC };
const BLOCKED = {
  ok: false as const,
  blockers: [{ kind: "import-from:./tools.ts", detail: "…", line: 3 }],
};

const files = (server: string, readme: string) => [
  { path: ["src", "server.ts"], content: server },
  { path: ["README.md"], content: readme },
];
const real = (server: string, readme: string) =>
  new Map([
    ["src/server.ts", server],
    ["README.md", readme],
  ]);

describe("tierFor", () => {
  it("is blocked when derivation failed", () => {
    expect(tierFor({ derivation: BLOCKED })).toBe("blocked");
  });

  it("is emits when nothing was generated to compare", () => {
    expect(tierFor({ derivation: OK })).toBe("emits");
  });

  it("is emits when server.ts differs", () => {
    expect(tierFor({ derivation: OK, generated: files("a", "r"), real: real("b", "r") })).toBe(
      "emits",
    );
  });

  it("is server-identical when server.ts matches but another file does not", () => {
    expect(tierFor({ derivation: OK, generated: files("a", "r1"), real: real("a", "r2") })).toBe(
      "server-identical",
    );
  });

  it("is all-identical when every generated file matches", () => {
    expect(tierFor({ derivation: OK, generated: files("a", "r"), real: real("a", "r") })).toBe(
      "all-identical",
    );
  });

  it("is server-identical, not all-identical, when a generated file is absent upstream", () => {
    expect(
      tierFor({
        derivation: OK,
        generated: files("a", "r"),
        real: new Map([["src/server.ts", "a"]]),
      }),
    ).toBe("server-identical");
  });
});

describe("histogram", () => {
  it("counts buckets most common first and names examples", () => {
    const results = [
      { name: "snyk", tier: "blocked" as const, blockers: BLOCKED.blockers },
      { name: "wiz", tier: "blocked" as const, blockers: BLOCKED.blockers },
      {
        name: "zoom",
        tier: "blocked" as const,
        blockers: [{ kind: "call:safeCliArg", detail: "…", line: 1 }],
      },
    ];
    expect(histogram(results)).toEqual([
      { kind: "import-from:./tools.ts", count: 2, examples: ["snyk", "wiz"] },
      { kind: "call:safeCliArg", count: 1, examples: ["zoom"] },
    ]);
  });

  it("counts a connector once per distinct bucket, not once per blocker", () => {
    const results = [
      {
        name: "a",
        tier: "blocked" as const,
        blockers: [
          { kind: "k", detail: "1", line: 1 },
          { kind: "k", detail: "2", line: 2 },
        ],
      },
    ];
    expect(histogram(results)).toEqual([{ kind: "k", count: 1, examples: ["a"] }]);
  });
});

describe("selectConnectors", () => {
  it("returns every connector when no names are given", () => {
    expect(selectConnectors([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns the named connectors when names are given", () => {
    expect(selectConnectors(["b"], ["a", "b"])).toEqual(["b"]);
  });

  it("refuses an empty corpus rather than reporting a reach number over nothing", () => {
    expect(() => selectConnectors([], [])).toThrow(/nothing measured/i);
  });
});

describe("summaryLines", () => {
  it("reports each tier as a cumulative count, headline marked", () => {
    const results = [
      { name: "a", tier: "all-identical" as const, blockers: [] },
      { name: "b", tier: "server-identical" as const, blockers: [] },
      { name: "c", tier: "emits" as const, blockers: [] },
      { name: "d", tier: "blocked" as const, blockers: [] },
    ];
    expect(summaryLines(results).join("\n")).toContain("REACH  2/4");
  });
});
