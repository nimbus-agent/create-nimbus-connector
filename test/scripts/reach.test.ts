import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  histogram,
  measure,
  parseArgs,
  selectConnectors,
  summaryLines,
  tierFor,
  walkConnector,
} from "../../scripts/_lib/reach.ts";
import { initFormatter } from "../../src/format.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

beforeAll(async () => {
  await initFormatter();
});

describe("reach.ts parseArgs", () => {
  it("returns no names, no root, and both flags unset for an empty argv", () => {
    expect(parseArgs([])).toEqual({
      names: [],
      nimbusRoot: undefined,
      baseline: false,
      verbose: false,
    });
  });

  it("collects bare arguments as connector names, in order", () => {
    expect(parseArgs(["newrelic", "datadog"]).names).toEqual(["newrelic", "datadog"]);
  });

  it("reads --nimbus-root's value and does not also treat it as a connector name", () => {
    const parsed = parseArgs(["--nimbus-root", "/some/path", "newrelic"]);
    expect(parsed).toEqual({
      names: ["newrelic"],
      nimbusRoot: "/some/path",
      baseline: false,
      verbose: false,
    });
  });

  it("rejects --nimbus-root with nothing after it rather than silently using undefined", () => {
    // Before this fix, a trailing --nimbus-root assigned `undefined`, and resolveNimbusRoot
    // then fell through to $NIMBUS_ROOT or sibling probing — silently measuring a checkout the
    // caller never named. See src/golden/resolve-root.ts's header for why a flag value must
    // fail loudly rather than fall through.
    expect(() => parseArgs(["--nimbus-root"])).toThrow("--nimbus-root requires a value");
  });

  it("rejects an unknown flag instead of collecting it as a connector name", () => {
    expect(() => parseArgs(["--nimbus-rot", "x"])).toThrow("Unknown flag: --nimbus-rot");
  });

  it("sets baseline and verbose independently of the root and names", () => {
    expect(parseArgs(["--baseline", "--verbose"])).toEqual({
      names: [],
      nimbusRoot: undefined,
      baseline: true,
      verbose: true,
    });
  });
});

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

describe("measure", () => {
  // A minimal but genuine hand-rolled connector this repository's own recognizers derive
  // successfully — every field deriveManifest and deriveSpec require, and nothing more.
  const MANIFEST = JSON.stringify({
    displayName: "X Connector",
    description: "A test connector.",
    permissions: { network: ["api.example.com"] },
    syncInterval: 3600,
    minNimbusVersion: "1.0.0",
  });

  function validServer(fetchHelperLocal: string): string {
    return [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      'import { z } from "zod";',
      'import { createRegisterSimpleTool, createZodToolRegistrar, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";',
      'const mcp = new McpServer({ name: "nimbus-x", version: "0.1.0" });',
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      `async function ${fetchHelperLocal}(path: string): Promise<unknown> {`,
      "  const res = await fetch(`https://api.example.com${path}`, {",
      '    headers: { "X-Api-Key": "abc123", Accept: "application/json" },',
      "  });",
      "  const text = await res.text();",
      "  if (!res.ok) {",
      "    throw new Error(`X ${String(res.status)}: ${text.slice(0, 400)}`);",
      "  }",
      "  return JSON.parse(text) as unknown;",
      "}",
      `reg("x_list", "List things.", z.object({}), async () => jsonResult(await ${fetchHelperLocal}("/things")));`,
      "const transport = new StdioServerTransport();",
      "await mcp.connect(transport);",
    ].join("\n");
  }

  it("blocks with no-server/no-manifest when a required file is missing", () => {
    const result = measure("x", new Map([["src/server.ts", validServer("xGet")]]));
    expect(result.tier).toBe("blocked");
    expect(result.blockers).toEqual([{ kind: "no-manifest", detail: "x", line: 0 }]);
  });

  it("blocks with kind rejected-by-validate when the derived spec fails parseSpec/validateSpec", () => {
    // "fetch" is a RESERVED_IDENTIFIERS entry (it is the global the emitted helper itself
    // calls) — a fetch helper genuinely named "fetch" derives structurally fine, then trips
    // validateSpec's identifier-collision claim.
    const files = new Map([
      ["src/server.ts", validServer("fetch")],
      ["nimbus.extension.json", MANIFEST],
    ]);

    const result = measure("x", files);

    expect(result.tier).toBe("blocked");
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.kind).toBe("rejected-by-validate");
    expect(result.blockers[0]?.detail).toMatch(/reserved emitter identifier/);
  });

  it("reports the expected tier for a clean derive", () => {
    const files = new Map([
      ["src/server.ts", validServer("xGet")],
      ["nimbus.extension.json", MANIFEST],
    ]);

    const result = measure("x", files);

    // `files` above is hand-written, not the emitter's own byte-exact output, and it carries
    // none of the OTHER generated files (README.md, package.json, …), so "all-identical" is
    // unreachable here regardless — the point of this test is that a normal derive+emit
    // succeeds end to end with no blockers, exercising the path Task 12's contract is about and
    // that no test previously imported. Not pinned to one exact tier: whether the hand-written
    // src/server.ts happens to come out byte-identical to Biome's formatted regeneration is an
    // accident of formatting, not something this test should assert either way.
    expect(result.tier).not.toBe("blocked");
    expect(result.tier).not.toBe("all-identical");
    expect(result.blockers).toEqual([]);
  });

  it("blocks with kind emitter-error when generate()/formatAll() throws, without crashing the sweep", () => {
    // The seam is Biome itself: mock.module replaces "@biomejs/js-api/nodejs" with a fake
    // whose formatContent() always reports a fatal diagnostic, which is exactly how a genuine
    // emitter defect (syntactically invalid emitted TypeScript) surfaces in production. Run in
    // a subprocess, same rationale as test/format.test.ts's own mock.module tests: a fresh
    // module registry, and mock.module's effect is process-global.
    const server = JSON.stringify(validServer("xGet"));
    const manifest = JSON.stringify(MANIFEST);
    const script =
      'const { mock } = await import("bun:test");' +
      'mock.module("@biomejs/js-api/nodejs", () => ({' +
      "  Biome: class {" +
      "    openProject() { return { projectKey: 1 }; }" +
      "    applyConfiguration() {}" +
      "    formatContent() {" +
      '      return { content: "", diagnostics: [{ severity: "error", description: "boom: injected formatter bug" }] };' +
      "    }" +
      "  }," +
      "}));" +
      'const { initFormatter } = await import("./src/format.ts");' +
      "await initFormatter();" +
      'const { measure } = await import("./scripts/_lib/reach.ts");' +
      `const files = new Map([["src/server.ts", ${server}], ["nimbus.extension.json", ${manifest}]]);` +
      'const result = measure("x", files);' +
      'if (result.tier !== "blocked") throw new Error("tier=" + result.tier);' +
      'if (result.blockers.length !== 1 || result.blockers[0].kind !== "emitter-error") {' +
      '  throw new Error("blockers=" + JSON.stringify(result.blockers));' +
      "}" +
      'console.log("ok");';
    const r = Bun.spawnSync(["bun", "-e", script], {
      cwd: `${import.meta.dir}/../..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toMatch(/ok/);
  });
});
