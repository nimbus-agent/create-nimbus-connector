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

/**
 * runCli always passes --spec, which --from-connector refuses to combine with — so this is a
 * bare sibling rather than an extension. Kept as two separate streams (not merged the way
 * runCli's `output` is) because --from-connector's stdout is a JSON spec meant to be parsed on
 * its own; interleaving stderr notes into it would make every caller re-split them back apart.
 */
function runCliBare(
  args: readonly string[],
  cwd: string,
): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync([process.execPath, cliPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString() };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = tmp.make("cnc-cli-");
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A directory that passes --gateway-wiring's checkout test. The CLI refuses to scaffold a
 * Gateway tree into a directory that is not a Nimbus checkout, so a bare temp dir is no
 * longer a valid target — which is the point: these tests now model the real destination
 * rather than any writable path.
 */
function makeFakeNimbusRoot(dir: string): string {
  const root = join(dir, "fake-nimbus-root");
  const markerDir = join(root, "packages", "mcp-connectors", "shared");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, "mcp-tool-kit.ts"), "// marker\n", "utf8");
  return root;
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
      const nimbusRoot = makeFakeNimbusRoot(dir);
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
      const nimbusRoot = makeFakeNimbusRoot(dir);
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
      const nimbusRoot = makeFakeNimbusRoot(dir);
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

  it("rejects --standalone with --gateway-wiring, writing nothing anywhere", () => {
    withTempDir((dir) => {
      const nimbusRoot = makeFakeNimbusRoot(dir);
      const { exitCode, output } = runCli(["--standalone", "--gateway-wiring", nimbusRoot], dir);
      expect(exitCode).toBe(1);
      expect(output).toContain("monorepo target only");
      // The root itself now pre-exists (it has to, to pass the checkout test), so the
      // meaningful assertion is that no Gateway tree was scaffolded inside it.
      expect(existsSync(join(nimbusRoot, "packages", "gateway"))).toBe(false);
      expect(existsSync(join(dir, CONNECTOR))).toBe(false);
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

describe("CLI surface", () => {
  it("--version prints the package version", () => {
    withTempDir((dir) => {
      const { exitCode, output } = runCli(["--version"], dir);
      expect(exitCode).toBe(0);
      expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  it("suggests the intended flag on a near-miss typo", () => {
    withTempDir((dir) => {
      const { exitCode, output } = runCli(["--standlone"], dir);
      expect(exitCode).toBe(1);
      expect(output).toContain("Did you mean --standalone?");
    });
  });

  it("points a wildly wrong flag at --help rather than guessing", () => {
    // A suggestion that is merely the closest of a short list, rather than actually close,
    // sends people to the wrong flag with confidence.
    withTempDir((dir) => {
      const { output } = runCli(["--xyzzy-nonsense"], dir);
      expect(output).toContain("--help");
      expect(output).not.toContain("Did you mean");
    });
  });

  it("names the flag and the file when --spec cannot be read", () => {
    withTempDir((dir) => {
      const { exitCode, output } = runCli(["--spec", "no-such-file.json"], dir);
      expect(exitCode).toBe(1);
      expect(output).toContain("--spec: cannot read");
      expect(output).not.toContain("ENOENT");
    });
  });

  it("names the file when --spec is not valid JSON", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "bad.json"), "{ not json", "utf8");
      const { exitCode, output } = runCli(["--spec", join(dir, "bad.json")], dir);
      expect(exitCode).toBe(1);
      expect(output).toContain("bad.json is not valid JSON");
    });
  });

  it("refuses --gateway-wiring at a directory that is not a Nimbus checkout", () => {
    // The whole point: a typo'd path used to silently scaffold packages/gateway/src/
    // connectors/ inside whatever directory was named, and report success.
    withTempDir((dir) => {
      const notNimbus = join(dir, "not-nimbus");
      mkdirSync(notNimbus, { recursive: true });
      const { exitCode, output } = runCli(["--gateway-wiring", notNimbus], dir);
      expect(exitCode).toBe(1);
      expect(output).toContain("does not look like a Nimbus checkout");
      expect(existsSync(join(notNimbus, "packages"))).toBe(false);
    });
  });
});

describe("--from-connector", () => {
  it("prints the spec derived from a connector this CLI just generated (monorepo target)", () => {
    withTempDir((dir) => {
      expect(runCli([], dir).exitCode).toBe(0);
      const connectorDir = join(dir, "packages", "mcp-connectors", CONNECTOR);

      const { exitCode, stdout, stderr } = runCliBare(["--from-connector", connectorDir], dir);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const spec = JSON.parse(stdout);
      expect(spec.name).toBe(CONNECTOR);
    });
  });

  // I3 (final whole-branch review): src/derive/from-connector.ts recovers `target` and
  // src/cli.ts prints a stderr note when it is "standalone" — but nothing end-to-end reached
  // either the field or the branch that reads it. A prior fix-wave verification hardcoded
  // `target = "monorepo"` AND deleted this note branch entirely, and the full suite (525 tests)
  // still passed. This is the test that closes that gap: it drives the real binary through both
  // halves of the round trip (generate --standalone, then --from-connector on the result) and
  // pins the on-screen signal a user relies on to know which --target to regenerate with.
  it("notes the standalone target on stderr for a connector this CLI generated with --standalone", () => {
    withTempDir((dir) => {
      expect(runCli(["--standalone"], dir).exitCode).toBe(0);
      const connectorDir = join(dir, CONNECTOR);

      const { exitCode, stdout, stderr } = runCliBare(["--from-connector", connectorDir], dir);
      expect(exitCode).toBe(0);
      const spec = JSON.parse(stdout);
      expect(spec.name).toBe(CONNECTOR);
      expect(stderr).toContain(
        "note: read from a standalone package — generate with --standalone.",
      );
    });
  });

  it("prints a blocker report and exits 1 for a directory with no connector in it", () => {
    withTempDir((dir) => {
      const empty = join(dir, "not-a-connector");
      mkdirSync(empty, { recursive: true });

      const { exitCode, stdout, stderr } = runCliBare(["--from-connector", empty], dir);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("cannot read");
      expect(stderr).toContain("src/server.ts");
      // Not mangled by the top-level single-line catcher: the multi-line report is printed by
      // main() itself, and only a short summary is thrown to carry the exit code.
      expect(stderr).not.toMatch(/create-nimbus-connector:.*\n.*missing-file/s);
    });
  });

  it("rejects --from-connector combined with --spec before touching the filesystem", () => {
    withTempDir((dir) => {
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-connector", dir, "--spec", specPath],
        dir,
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("--from-connector");
      expect(stderr).toContain("--spec");
    });
  });
});
