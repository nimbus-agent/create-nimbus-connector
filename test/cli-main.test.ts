import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpec } from "../src/spec.ts";
import { ZZ_WIDGETS_YAML } from "./support/openapi-doc.ts";
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

/**
 * --from-openapi / --list-operations, driven through the real binary for the same reason
 * everything else in this file is: src/cli.ts is excluded from the coverage metric because Bun
 * cannot instrument a child process, and spawning the shipped entry point is the stronger test.
 * The parse-level rules live in test/cli.test.ts; these assert what reaches stdout.
 *
 * The document is the shared synthetic one — see test/support/openapi-doc.ts, which explains why
 * it is not hand-duplicated here.
 */
const DOC = ZZ_WIDGETS_YAML;

/** Shared by both --from-openapi blocks: the listing tests and the assembly tests. */
function writeDoc(dir: string, text: string, name = "widgets.yaml"): string {
  const path = join(dir, name);
  writeFileSync(path, text, "utf8");
  return path;
}

describe("--from-openapi --list-operations", () => {
  it("prints one line per operation in document order and exits 0", () => {
    withTempDir((dir) => {
      const doc = writeDoc(dir, DOC);
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--list-operations"],
        dir,
      );
      expect(exitCode).toBe(0);
      // Each line carries the operationId, the method and the path — everything --op needs.
      expect(stdout.split("\n").map((l) => l.trim().split(/\s+/))).toEqual([
        ["listWidgets", "GET", "/widgets"],
        ["createWidget", "POST", "/widgets"],
        ["getWidget", "GET", "/widgets/{widgetId}"],
      ]);
      expect(stderr).toContain("3 operation(s)");
      expect(stderr).toContain("yaml");
    });
  });

  it("reads the same document as JSON and reports the source it used", () => {
    withTempDir((dir) => {
      const doc = writeDoc(
        dir,
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "ZZ Widgets", version: "1.0.0" },
          paths: { "/widgets": { get: { operationId: "listWidgets" } } },
        }),
        "widgets.json",
      );
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--list-operations"],
        dir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("listWidgets  GET    /widgets");
      expect(stderr).toContain("json");
    });
  });

  // A HEAD beside three mappable operations must not take the document down with it — this
  // command exists to pick one operation out of many. Named on stderr, so stdout stays a list of
  // --op arguments that can be copied whole.
  it("lists the rest and notes an operation it cannot offer, still exiting 0", () => {
    withTempDir((dir) => {
      const doc = writeDoc(dir, DOC.replace("    post:", "    head:"));
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--list-operations"],
        dir,
      );
      expect(exitCode).toBe(0);
      expect(stdout.split("\n").map((l) => l.trim().split(/\s+/)[0])).toEqual([
        "listWidgets",
        "getWidget",
      ]);
      expect(stdout).not.toContain("head");
      expect(stderr).toContain("skipped head /widgets");
      expect(stderr).toContain("unsupported-method");
      // The operationId is what --op names it by, so the note carries it: without it this line
      // and the refusal `--op createWidget` produces describe one operation in two vocabularies,
      // and connecting them is the reader's problem.
      expect(stderr).toContain("operationId: createWidget");
    });
  });

  // The refusal that fails quietly if it is not made at resolution: a missing lookup yields
  // undefined, which reaches a mapper as an absent field rather than an error.
  it("exits 1 naming a dangling $ref, printing nothing to stdout", () => {
    withTempDir((dir) => {
      const doc = writeDoc(
        dir,
        [
          DOC.trimEnd(),
          "      requestBody:",
          "        content:",
          "          application/json:",
          "            schema:",
          '              $ref: "#/components/schemas/NoSuchThing"',
          "",
        ].join("\n"),
      );
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--list-operations"],
        dir,
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("$ref-dangling");
      expect(stderr).toContain("NoSuchThing");
    });
  });

  it("exits 1 naming the file it could not read", () => {
    withTempDir((dir) => {
      const missing = join(dir, "nope.yaml");
      const { exitCode, stderr } = runCliBare(
        ["--from-openapi", missing, "--list-operations"],
        dir,
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--from-openapi");
      expect(stderr).toContain("nope.yaml");
    });
  });

  // The pinned answer to "what does a bare --from-openapi do": it refuses, because the tool set
  // is the author's choice. Both flags that give it something to do are named, so neither half of
  // the decision is guesswork for the reader — see src/cli.ts's own message for the reasoning.
  it("exits 1 naming both --op and --list-operations for a bare --from-openapi", () => {
    withTempDir((dir) => {
      const doc = writeDoc(dir, DOC);
      const { exitCode, stdout, stderr } = runCliBare(["--from-openapi", doc], dir);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("--list-operations");
      expect(stderr).toContain("--op");
      // The provisional wording Task 1 left behind said only "pass --list-operations to see the
      // operations this document declares", which described a command that could not yet assemble
      // a spec rather than a decision. It must not survive as the pinned answer.
      expect(stderr).not.toContain("pass --list-operations to see");
    });
  });

  it("exits 1 for --list-operations with no document, naming the missing flag", () => {
    withTempDir((dir) => {
      const { exitCode, stderr } = runCliBare(["--list-operations"], dir);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--from-openapi");
    });
  });
});

/**
 * `--from-openapi <doc> --op <id>` — the whole pipeline through the real binary: read, select,
 * map, assemble, print.
 *
 * The assertion on the happy path is that the printed text PARSES and survives the real
 * `parseSpec`, not that it contains some substring: a spec printed with a stray note in it, or
 * with `\r\n` mangling, would pass a `toContain` and fail the only use the output has.
 */
describe("--from-openapi --op", () => {
  /**
   * The shared synthetic document, extended with the two things assembling a SPEC needs that
   * listing operations does not:
   *
   * - a `securitySchemes` entry, because `assembleSpec` refuses `no-security-scheme` rather than
   *   assume an API is anonymous;
   * - a declaration for the `{widgetId}` the templated path carries, because an undeclared path
   *   variable is `undeclared-path-parameter`.
   *
   * Appended to the shared constant rather than folded into it, for the reason
   * `test/support/openapi-doc.ts` gives: the listing tests describe the document as it is there,
   * and this block is exactly the difference between listing it and assembling from it.
   */
  const ASSEMBLABLE = [
    DOC.trimEnd(),
    "      parameters:",
    "        - name: widgetId",
    "          in: path",
    "          required: true",
    "          schema:",
    "            type: string",
    "components:",
    "  securitySchemes:",
    "    bearerAuth:",
    "      type: http",
    "      scheme: bearer",
    "",
  ].join("\n");

  it("prints a spec the real parseSpec accepts, in the order the operations were selected", () => {
    withTempDir((dir) => {
      const doc = writeDoc(dir, ASSEMBLABLE);
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--op", "listWidgets", "--op", "getWidget"],
        dir,
      );
      expect(stderr).not.toContain("create-nimbus-connector:");
      expect(exitCode).toBe(0);

      // The assertion the brief asks for: parse it, then run it through the real spec language.
      const spec = parseSpec(JSON.parse(stdout));
      expect(spec.name).toBe("zz-widgets");
      expect(spec.tools.map((t) => t.name)).toEqual(["listWidgets", "getWidget"]);
      expect(spec.fetchHelper.base).toBe("https://api.zzwidgets.test/v1");
      expect(spec.network).toEqual(["api.zzwidgets.test"]);

      // What was read, and that the printed file is a draft — neither of which the spec on
      // stdout can say about itself.
      expect(stderr).toContain("assembled 2 operation(s) from yaml");
      expect(stderr).toContain('"TODO:"');

      // Nothing is written: this command prints a spec and generates no package. The document
      // the test itself wrote is the only file that may be in the directory.
      expect(readdirSync(dir)).toEqual(["widgets.yaml"]);
    });
  });

  // The stdout/stderr split, proved on a document that produces a note: `--from-openapi … >
  // spec.json` must leave a file that parses while the note stays visible on the terminal.
  it("keeps notes on stderr and the spec alone on stdout", () => {
    withTempDir((dir) => {
      const doc = writeDoc(dir, ASSEMBLABLE);
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--op", "createWidget"],
        dir,
      );
      expect(exitCode).toBe(0);
      // A note leaking into stdout would break this parse, which is the point of asserting it
      // here rather than asserting stdout "starts with {".
      const spec = parseSpec(JSON.parse(stdout));
      expect(spec.tools.map((t) => t.name)).toEqual(["createWidget"]);
      expect(stderr).toContain("note: ");
      expect(stderr).toContain("createWidget");
      expect(stderr).toContain('"effect"');
      expect(stdout).not.toContain("note: ");
    });
  });

  it("exits 1 naming the operationId it could not find and the ones it could", () => {
    withTempDir((dir) => {
      const doc = writeDoc(dir, ASSEMBLABLE);
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--op", "listGadgets"],
        dir,
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("listGadgets");
      for (const available of ["listWidgets", "createWidget", "getWidget"]) {
        expect(stderr).toContain(available);
      }
    });
  });

  /**
   * The obligation Task 1 handed forward, and the only gate it has.
   *
   * `head`/`options`/`trace` and a mis-cased method key are REPORTED by the reader and omitted
   * from the selectable set rather than refusing the document — so an `--op` naming one would
   * otherwise fall through to the missing-operation path and report "no such operation" for an
   * operation the user is looking at in their own document. Different diagnosis, different fix.
   */
  it("refuses an --op naming an unsupported-method operation as unsupported, not as missing", () => {
    withTempDir((dir) => {
      const head = ASSEMBLABLE.replace("    post:", "    head:");
      expect(head).not.toBe(ASSEMBLABLE);
      const doc = writeDoc(dir, head);
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--op", "createWidget"],
        dir,
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("unsupported-method");
      expect(stderr).toContain("createWidget");
      expect(stderr).toContain("head /widgets");
      // The wrong diagnosis this exists to prevent.
      expect(stderr).not.toContain("no-such-operation");
    });
  });

  it("refuses an --op naming a mis-cased method key by saying what to write instead", () => {
    withTempDir((dir) => {
      const miscased = ASSEMBLABLE.replace("    post:", "    POST:");
      expect(miscased).not.toBe(ASSEMBLABLE);
      const doc = writeDoc(dir, miscased);
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--op", "createWidget"],
        dir,
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("mis-cased-method");
      expect(stderr).toContain('"post:"');
      expect(stderr).not.toContain("no-such-operation");
    });
  });

  /**
   * The second inherited obligation. `assembleSpec` refuses an empty selection with
   * `no-operations`, whose message ends "run --list-operations and pass one or more --op" — advice
   * that is circular for a document with no operation this reader can offer. The reason the set is
   * empty is in hand at selection, so it is what gets printed.
   */
  it("names why a document offers nothing to select rather than telling the user to select", () => {
    withTempDir((dir) => {
      const doc = writeDoc(
        dir,
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "ZZ Widgets", version: "1.0.0" },
          servers: [{ url: "https://api.zzwidgets.test/v1" }],
          paths: { "/health": { head: { operationId: "ping" } } },
          components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
        }),
        "health.json",
      );
      const { exitCode, stdout, stderr } = runCliBare(["--from-openapi", doc, "--op", "ping"], dir);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("unsupported-method");
      expect(stderr).toContain("head /health");
      // assembleSpec's own no-operations advice, which would send the user back to a listing
      // that prints nothing to select.
      expect(stderr).not.toContain("pass one or more --op");
    });
  });

  it("prints every refusal by name when the selected operations cannot be mapped", () => {
    withTempDir((dir) => {
      const doc = writeDoc(
        dir,
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "ZZ Widgets", version: "1.0.0" },
          servers: [{ url: "https://api.zzwidgets.test/v1" }],
          paths: {
            "/a": {
              get: {
                operationId: "getA",
                parameters: [{ name: "X-Trace", in: "header", schema: { type: "string" } }],
              },
            },
            "/b": {
              get: {
                operationId: "getB",
                parameters: [{ name: "shape", in: "query", schema: { type: "array" } }],
              },
            },
          },
          components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
        }),
        "unmappable.json",
      );
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--op", "getA", "--op", "getB"],
        dir,
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      // Both, not just the first: one run names every construct standing in the way, rather than
      // turning into a sequence of one-at-a-time discoveries.
      //
      // A mapper refusal identifies its operation by METHOD and PATH, not by the operationId the
      // --op argument used — those are the second and third columns of the --list-operations line
      // the id was copied from, so the refusal is findable, but the vocabulary is the mapper's.
      expect(stderr).toContain("parameter-location");
      expect(stderr).toContain("GET /a");
      expect(stderr).toContain("schema-type");
      expect(stderr).toContain("GET /b");
    });
  });

  it("prints the document-level refusal by name when the document itself cannot supply a spec", () => {
    withTempDir((dir) => {
      // The same document the happy path uses, minus its security scheme — one construct.
      const anonymous = ASSEMBLABLE.slice(0, ASSEMBLABLE.indexOf("components:"));
      expect(anonymous).not.toBe(ASSEMBLABLE);
      const doc = writeDoc(dir, anonymous);
      const { exitCode, stdout, stderr } = runCliBare(
        ["--from-openapi", doc, "--op", "listWidgets"],
        dir,
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("no-security-scheme");
      expect(readdirSync(dir)).toEqual(["widgets.yaml"]);
    });
  });
});
