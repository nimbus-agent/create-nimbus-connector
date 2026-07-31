import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeValue } from "../src/cli.ts";
import { generate } from "../src/emit/index.ts";
import { biomeVersion, formatAll, formatterAvailable, initFormatter } from "../src/format.ts";
import { checkBiomeVersion } from "../src/golden/biome-version.ts";
import { classify, loadExpectations } from "../src/golden/expectations.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { parseSpec } from "../src/spec.ts";
import { displayPath, type GeneratedFile } from "../src/types.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, "..", "fixtures");
const expectationsPath = join(fixturesDir, "expectations.json");

function parseArgs(argv: string[]): { names: string[]; nimbusRoot?: string } {
  const names: string[] = [];
  let nimbusRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nimbus-root") {
      nimbusRoot = takeValue(argv, ++i, "--nimbus-root");
    } else if (argv[i]?.startsWith("--")) {
      throw new Error(`Unknown flag: ${argv[i]}`);
    } else {
      names.push(argv[i]!);
    }
  }
  return { names, nimbusRoot };
}

function unifiedDiff(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      if (e[i] !== undefined) out.push(`    - ${e[i]}`);
      if (a[i] !== undefined) out.push(`    + ${a[i]}`);
    }
  }
  return out.slice(0, 40).join("\n");
}

/** Parenthetical note appended after the identical-file count on a PASS line. */
function passNote(expected: number, total: number, stubs: number): string {
  const parts: string[] = [];
  if (expected < total) parts.push("expected partial");
  if (stubs > 0) parts.push(`${stubs} stub tool(s)`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** Names the files that entered or left the identical set, so a FAIL is actionable. */
function deltaNote(lost: readonly string[], gained: readonly string[]): string {
  const parts: string[] = [];
  if (lost.length > 0) parts.push(`no longer matching ${lost.join(", ")}`);
  if (gained.length > 0) parts.push(`newly matching ${gained.join(", ")}`);
  return parts.join("; ");
}

async function main(): Promise<void> {
  await initFormatter();
  if (!formatterAvailable()) {
    throw new Error(
      "@biomejs/biome is required here — byte-exactness is the point of this check, and " +
        "unformatted output would produce spurious diffs that look like emitter regressions. " +
        "Run `bun install` to restore the optional dependency.",
    );
  }

  const { names, nimbusRoot } = parseArgs(process.argv.slice(2));
  const root = resolveNimbusRoot({
    flag: nimbusRoot,
    env: process.env["NIMBUS_ROOT"],
    scriptDir,
  });
  const expectations = loadExpectations(expectationsPath);

  const all = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".spec.json"))
    .map((f) => f.replace(/\.spec\.json$/, ""));
  const selected = names.length > 0 ? names : all;

  // An empty comparison set must never report success: that is the same silent-pass
  // failure mode this harness exists to prevent, just triggered by a hollow fixture
  // list instead of a missing monorepo.
  if (selected.length === 0) {
    if (names.length === 0) {
      throw new Error(
        `No fixtures found in ${fixturesDir} (expected files matching *.spec.json). ` +
          `Refusing to report a pass with nothing compared.`,
      );
    }
    throw new Error(
      `No fixture name(s) matched anything to run in ${fixturesDir}: ${names.join(", ")}`,
    );
  }

  const resolvedBiomeVersion = biomeVersion();
  console.log(`Nimbus root: ${root}`);
  console.log(`Biome:       ${resolvedBiomeVersion}`);
  const versionWarning = checkBiomeVersion(root, resolvedBiomeVersion);
  if (versionWarning !== undefined) console.log(versionWarning);
  console.log();

  let failures = 0;

  for (const name of selected) {
    const specPath = join(fixturesDir, `${name}.spec.json`);
    let specRaw: string;
    try {
      specRaw = readFileSync(specPath, "utf8");
    } catch {
      throw new Error(`No fixture named "${name}" — expected ${specPath}`);
    }
    const spec = parseSpec(JSON.parse(specRaw));
    const files: GeneratedFile[] = formatAll(generate(spec));
    const realDir = join(root, "packages", "mcp-connectors", name);

    const stubs = spec.tools.filter((t) => t.impl === "stub").length;
    const identicalPaths: string[] = [];
    const problems: string[] = [];

    for (const f of files) {
      const rel = displayPath(f.path);
      let expectedContent: string;
      try {
        expectedContent = readFileSync(join(realDir, ...f.path), "utf8").replaceAll("\r\n", "\n");
      } catch {
        problems.push(`  MISSING  ${rel} — not present in the real connector`);
        continue;
      }
      if (expectedContent === f.content) {
        identicalPaths.push(rel);
      } else {
        problems.push(`  DIFF     ${rel}\n${unifiedDiff(expectedContent, f.content)}`);
      }
    }

    const total = files.length;
    const identical = identicalPaths.length;
    const expectedPaths = expectations[name];
    if (expectedPaths === undefined) {
      throw new Error(
        `No expectation declared for fixture "${name}" in ${expectationsPath}. ` +
          `Add an entry listing the file paths that are currently byte-identical (out of ` +
          `${total}) before running the harness — an undeclared fixture must not be able to ` +
          "pass by accident.",
      );
    }

    const { verdict, lost, gained } = classify(identicalPaths, expectedPaths);
    if (verdict !== "pass") failures++;

    const stubNote = stubs > 0 ? `, ${stubs} stub tool(s)` : "";
    let line: string;
    if (verdict === "pass") {
      line = `PASS  ${name}  ${identical}/${total} files identical${passNote(expectedPaths.length, total, stubs)}`;
    } else {
      line =
        `FAIL  ${name}  ${identical}/${total} files identical${stubNote} — ` +
        `${verdict}: ${deltaNote(lost, gained)}` +
        (verdict === "regressed"
          ? ""
          : "; update fixtures/expectations.json and the design doc's criterion-2 gap report");
    }
    console.log(line);
    for (const p of problems) console.log(p);
  }

  if (failures > 0) {
    console.log(`\n${failures} fixture(s) deviate from their declared expectations.`);
    process.exit(1);
  }
  console.log("\nAll fixtures match their declared expectations.");
}

await main();
