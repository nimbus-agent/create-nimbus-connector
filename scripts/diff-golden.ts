import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../src/emit/index.ts";
import { biomeVersion, formatAll } from "../src/format.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { parseSpec } from "../src/spec.ts";
import { displayPath, type GeneratedFile } from "../src/types.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, "..", "fixtures");

function parseArgs(argv: string[]): { names: string[]; nimbusRoot?: string } {
  const names: string[] = [];
  let nimbusRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nimbus-root") {
      nimbusRoot = argv[++i];
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

function main(): void {
  const { names, nimbusRoot } = parseArgs(process.argv.slice(2));
  const root = resolveNimbusRoot({
    flag: nimbusRoot,
    env: process.env["NIMBUS_ROOT"],
    scriptDir,
  });

  const all = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".spec.json"))
    .map((f) => f.replace(/\.spec\.json$/, ""));
  const selected = names.length > 0 ? names : all;

  console.log(`Nimbus root: ${root}`);
  console.log(`Biome:       ${biomeVersion()}\n`);

  let failures = 0;

  for (const name of selected) {
    const spec = parseSpec(
      JSON.parse(readFileSync(join(fixturesDir, `${name}.spec.json`), "utf8")),
    );
    const files: GeneratedFile[] = formatAll(generate(spec));
    const realDir = join(root, "packages", "mcp-connectors", name);

    const stubs = spec.tools.filter((t) => t.impl === "stub").length;
    let identical = 0;
    const problems: string[] = [];

    for (const f of files) {
      const rel = displayPath(f.path);
      let expected: string;
      try {
        expected = readFileSync(join(realDir, ...f.path), "utf8").replaceAll("\r\n", "\n");
      } catch {
        problems.push(`  MISSING  ${rel} — not present in the real connector`);
        continue;
      }
      if (expected === f.content) {
        identical++;
      } else {
        problems.push(`  DIFF     ${rel}\n${unifiedDiff(expected, f.content)}`);
      }
    }

    const ok = problems.length === 0;
    if (!ok) failures++;
    const stubNote = stubs > 0 ? `, ${stubs} stub tool(s)` : "";
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}  ${identical}/${files.length} files identical${stubNote}`,
    );
    for (const p of problems) console.log(p);
  }

  if (failures > 0) {
    console.log(`\n${failures} fixture(s) differ.`);
    process.exit(1);
  }
  console.log("\nAll fixtures byte-identical.");
}

main();
