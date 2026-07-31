import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./support/tmp.ts";

// withTempDir already removes each directory in a finally; this is the backstop for a
// directory that outlives it (a rmSync that lost a race with a still-open handle).
const tmp = tempDirs();
afterAll(tmp.cleanup);

/**
 * End-to-end coverage for main() in src/cli.ts — specifically the two lines where
 * --standalone stops being a parsed boolean and becomes behaviour:
 *
 *   const target = opts.standalone ? "standalone" : "monorepo";
 *   const outDir = opts.outDir ?? (opts.standalone ? spec.name : join("packages", ...));
 *
 * Nothing else reaches them. test/cli.test.ts imports parseCliArgs and renderTree only,
 * and both acceptance scripts import writeFiles/generate and pass {target} themselves.
 * So these tests spawn the real binary and assert on the bytes it puts on disk.
 *
 * Every expected path below is written out literally rather than derived from the
 * expression under test — a helper that recomputed `join("packages", ...)` would pass
 * just as happily with the ternary inverted.
 */

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
/** A rest-kit spec whose "name" field is "zzstandalone" — the default out-dir depends on it. */
const specPath = join(repoRoot, "fixtures", "zzstandalone.spec.json");
const CONNECTOR = "zzstandalone";

function runCli(args: readonly string[], cwd: string): { exitCode: number; output: string } {
  // process.execPath is the bun binary already running this test — no PATH assumption.
  const r = Bun.spawnSync([process.execPath, cliPath, "--spec", specPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode,
    output: `${r.stdout.toString()}${r.stderr.toString()}`.trim(),
  };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = tmp.make("cnc-cli-");
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bun src/cli.ts (the real binary)", () => {
  it("--standalone writes a package that imports the published kit", () => {
    withTempDir((dir) => {
      const { exitCode, output } = runCli(["--standalone"], dir);
      expect(output).not.toContain("create-nimbus-connector:");
      expect(exitCode).toBe(0);

      const server = join(dir, CONNECTOR, "src", "server.ts");
      expect(existsSync(server)).toBe(true);
      const src = readFileSync(server, "utf8");
      expect(src).toContain('from "@nimbus-dev/sdk/connector-kit"');
      expect(src).not.toContain("../../shared/");
      // biome.json is standalone-only, so its presence is a second, independent witness
      // that main() actually selected target: "standalone".
      expect(existsSync(join(dir, CONNECTOR, "biome.json"))).toBe(true);
    });
  });

  it("without --standalone writes a monorepo package with relative shared imports", () => {
    withTempDir((dir) => {
      const { exitCode, output } = runCli([], dir);
      expect(output).not.toContain("create-nimbus-connector:");
      expect(exitCode).toBe(0);

      const server = join(dir, "packages", "mcp-connectors", CONNECTOR, "src", "server.ts");
      expect(existsSync(server)).toBe(true);
      const src = readFileSync(server, "utf8");
      expect(src).toContain('from "../../shared/');
      expect(src).not.toContain("@nimbus-dev/sdk/connector-kit");
      expect(existsSync(join(dir, "packages", "mcp-connectors", CONNECTOR, "biome.json"))).toBe(
        false,
      );
    });
  });

  it("defaults the out-dir to <name>/ for standalone and packages/mcp-connectors/<name>/ otherwise", () => {
    withTempDir((dir) => {
      expect(runCli(["--standalone"], dir).exitCode).toBe(0);
      // The standalone run must not have created the monorepo tree...
      expect(existsSync(join(dir, CONNECTOR, "package.json"))).toBe(true);
      expect(existsSync(join(dir, "packages"))).toBe(false);
    });

    withTempDir((dir) => {
      expect(runCli([], dir).exitCode).toBe(0);
      // ...and the monorepo run must not have created the standalone one.
      expect(existsSync(join(dir, "packages", "mcp-connectors", CONNECTOR, "package.json"))).toBe(
        true,
      );
      expect(existsSync(join(dir, CONNECTOR))).toBe(false);
    });
  });

  it("stamps standalone output UNLICENSED by default, not the monorepo's AGPL", () => {
    withTempDir((dir) => {
      expect(runCli(["--standalone"], dir).exitCode).toBe(0);
      const pkg = JSON.parse(readFileSync(join(dir, CONNECTOR, "package.json"), "utf8"));
      expect(pkg.license).toBe("UNLICENSED");
      const readme = readFileSync(join(dir, CONNECTOR, "README.md"), "utf8");
      expect(readme).toContain("UNLICENSED");
      expect(readme).not.toContain("AGPL");
    });
  });

  it("--license lands in both package.json and the README", () => {
    withTempDir((dir) => {
      expect(runCli(["--standalone", "--license", "MIT"], dir).exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, CONNECTOR, "package.json"), "utf8")).license).toBe(
        "MIT",
      );
      expect(readFileSync(join(dir, CONNECTOR, "README.md"), "utf8")).toContain(
        "## License\n\nMIT\n",
      );
    });
  });

  it("leaves monorepo output on AGPL-3.0-only", () => {
    withTempDir((dir) => {
      expect(runCli([], dir).exitCode).toBe(0);
      const base = join(dir, "packages", "mcp-connectors", CONNECTOR);
      expect(JSON.parse(readFileSync(join(base, "package.json"), "utf8")).license).toBe(
        "AGPL-3.0-only",
      );
      expect(readFileSync(join(base, "README.md"), "utf8")).toContain("## License\n\nAGPL-3.0\n");
    });
  });

  it("fails loudly on --license without --standalone, writing nothing", () => {
    withTempDir((dir) => {
      const { exitCode, output } = runCli(["--license", "MIT"], dir);
      expect(exitCode).toBe(1);
      expect(output).toContain("--license applies to --standalone output only");
      expect(output).toContain("AGPL-3.0-only");
      // Not silently ignored, and nothing was written before the error.
      expect(existsSync(join(dir, "packages"))).toBe(false);
    });
  });

  it("rejects a malformed --license value before anything is written", () => {
    withTempDir((dir) => {
      const { exitCode, output } = runCli(["--standalone", "--license", "MIT or Apache-2.0"], dir);
      expect(exitCode).toBe(1);
      expect(output).toMatch(/uppercase/);
      expect(existsSync(join(dir, CONNECTOR))).toBe(false);
    });
  });

  it("--gateway-wiring writes the two wiring files and prints the paste-able registration lines", () => {
    withTempDir((dir) => {
      const nimbusRoot = join(dir, "fake-nimbus-root");
      const { exitCode, output } = runCli(["--gateway-wiring", nimbusRoot], dir);
      expect(exitCode).toBe(0);

      const connectorsDir = join(nimbusRoot, "packages", "gateway", "src", "connectors");
      const syncFile = join(connectorsDir, "zzstandalone-sync.ts");
      const mappingFile = join(connectorsDir, "zzstandalone-mapping.ts");
      expect(existsSync(syncFile)).toBe(true);
      expect(existsSync(mappingFile)).toBe(true);

      const sync = readFileSync(syncFile, "utf8");
      expect(sync).toContain("export function createZzstandaloneSyncable(): Syncable");
      expect(sync).toContain('"zzstandalone_item_list"');

      const mapping = readFileSync(mappingFile, "utf8");
      expect(mapping).toContain("throw new Error(");

      // The normal connector package is still written — wiring is additive, not a replacement.
      expect(existsSync(join(dir, "packages", "mcp-connectors", CONNECTOR, "package.json"))).toBe(
        true,
      );

      // The two lines to paste, plus the corrected second-file guidance (see wiring.ts's doc
      // comment: the original brief named gateway-syncable-ids.ts, which is wrong).
      expect(output).toContain(
        'import { createZzstandaloneSyncable } from "../connectors/zzstandalone-sync.ts";',
      );
      expect(output).toContain("syncScheduler.register(createZzstandaloneSyncable());");
      expect(output).toContain("connector-catalog.ts");
      expect(output).not.toContain("GATEWAY_SYNCABLE_SERVICE_IDS");
    });
  });

  it("without --gateway-wiring writes nothing outside outDir and prints no wiring instructions", () => {
    withTempDir((dir) => {
      const { exitCode, output } = runCli([], dir);
      expect(exitCode).toBe(0);
      expect(output).not.toContain("Gateway wiring");
      expect(output).not.toContain("assemble-sync-registrations.ts");
    });
  });

  it("--gateway-wiring refuses to overwrite an existing target file, and writes nothing else", () => {
    withTempDir((dir) => {
      const nimbusRoot = join(dir, "fake-nimbus-root");
      const connectorsDir = join(nimbusRoot, "packages", "gateway", "src", "connectors");
      mkdirSync(connectorsDir, { recursive: true });
      // Stand in for a hand-authored real connector (or previously filled-in wiring) sitting
      // where this run would write — exactly the newrelic-sync.ts / datadog-sync.ts collision
      // CRITICAL 2 named.
      const preexisting = join(connectorsDir, "zzstandalone-sync.ts");
      writeFileSync(preexisting, "// hand-authored, do not touch\n", "utf8");

      const { exitCode, output } = runCli(["--gateway-wiring", nimbusRoot], dir);
      expect(exitCode).toBe(1);
      expect(output).toContain("zzstandalone-sync.ts");
      expect(output).toContain("already exists");
      expect(output).toContain("--force");
      // Untouched — refusal happens before any write, including the connector package itself.
      expect(readFileSync(preexisting, "utf8")).toBe("// hand-authored, do not touch\n");
      expect(existsSync(join(connectorsDir, "zzstandalone-mapping.ts"))).toBe(false);
      expect(existsSync(join(dir, "packages", "mcp-connectors", CONNECTOR))).toBe(false);
    });
  });

  it("--gateway-wiring --force overwrites an existing target file", () => {
    withTempDir((dir) => {
      const nimbusRoot = join(dir, "fake-nimbus-root");
      const connectorsDir = join(nimbusRoot, "packages", "gateway", "src", "connectors");
      mkdirSync(connectorsDir, { recursive: true });
      const preexisting = join(connectorsDir, "zzstandalone-sync.ts");
      writeFileSync(preexisting, "// stale content\n", "utf8");

      const { exitCode } = runCli(["--gateway-wiring", nimbusRoot, "--force"], dir);
      expect(exitCode).toBe(0);
      const rewritten = readFileSync(preexisting, "utf8");
      expect(rewritten).not.toBe("// stale content\n");
      expect(rewritten).toContain("export function createZzstandaloneSyncable(): Syncable");
    });
  });

  it("rejects --force without --gateway-wiring, writing nothing", () => {
    withTempDir((dir) => {
      const { exitCode, output } = runCli(["--force"], dir);
      expect(exitCode).toBe(1);
      expect(output).toContain("--gateway-wiring");
      expect(existsSync(join(dir, "packages"))).toBe(false);
    });
  });

  it("--out-dir overrides the default for both targets, without changing the target", () => {
    withTempDir((dir) => {
      const explicit = join(dir, "elsewhere");
      expect(runCli(["--standalone", "--out-dir", explicit], dir).exitCode).toBe(0);
      expect(readFileSync(join(explicit, "src", "server.ts"), "utf8")).toContain(
        "@nimbus-dev/sdk/connector-kit",
      );
      expect(existsSync(join(dir, CONNECTOR))).toBe(false);
    });
  });
});
