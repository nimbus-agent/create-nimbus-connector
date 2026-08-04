import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  histogram,
  selectConnectors,
  summaryLines,
  tierFor,
  walkConnector,
} from "../../scripts/_lib/reach.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

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

describe("walkConnector", () => {
  it("walks nested real directories and keys their contents by forward-slash relative path", () => {
    const dir = tmp.make("cnc-reach-walk-");
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    writeFileSync(join(dir, "src", "server.ts"), "export {};\n", "utf8");
    writeFileSync(join(dir, "test", "sandbox.test.ts"), "// t\n", "utf8");

    const files = walkConnector(dir);

    expect(files.get("README.md")).toBe("hello\n");
    expect(files.get("src/server.ts")).toBe("export {};\n");
    expect(files.get("test/sandbox.test.ts")).toBe("// t\n");
    expect(files.size).toBe(3);
  });

  it("skips a node_modules directory entirely, including its contents", () => {
    // Every one of the 94 real connectors carries a bun-install node_modules that is not part
    // of its authored source; on Windows the workspace-package entries under it are junctions
    // that crash a naive recursive read (EISDIR), which is exactly what this skip guards
    // against. Asserted here rather than only observed live, per the reviewer's finding.
    const dir = tmp.make("cnc-reach-walk-nm-");
    mkdirSync(join(dir, "node_modules", "@nimbus-dev", "sdk"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "@nimbus-dev", "sdk", "package.json"), "{}\n", "utf8");
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");

    const files = walkConnector(dir);

    expect(files.has("README.md")).toBe(true);
    expect([...files.keys()].some((k) => k.startsWith("node_modules"))).toBe(false);
    expect(files.size).toBe(1);
  });

  it("normalises CRLF to LF on the read side only", () => {
    // The emitter always writes LF; a Nimbus checkout on Windows with core.autocrlf=true has
    // CRLF on disk. Without this normalisation every real file would look different from the
    // generated one regardless of content, making the harness useless on half its platforms.
    const dir = tmp.make("cnc-reach-walk-crlf-");
    writeFileSync(join(dir, "README.md"), "line one\r\nline two\r\n", "utf8");

    const files = walkConnector(dir);

    expect(files.get("README.md")).toBe("line one\nline two\n");
  });
});
