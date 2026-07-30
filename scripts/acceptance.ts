import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFiles } from "../src/cli.ts";
import { generate } from "../src/emit/index.ts";
import { formatAll } from "../src/format.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { parseSpec } from "../src/spec.ts";

const NAME = "zzscratch";
const scriptDir = dirname(fileURLToPath(import.meta.url));

function run(cmd: string[], cwd: string): { ok: boolean; output: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: r.exitCode === 0,
    output: `${r.stdout.toString()}${r.stderr.toString()}`.trim(),
  };
}

const root = resolveNimbusRoot({
  flag: process.argv[2],
  env: process.env["NIMBUS_ROOT"],
  scriptDir,
});
const outDir = join(root, "packages", "mcp-connectors", NAME);

const checks: { name: string; ok: boolean; output: string }[] = [];

try {
  const spec = parseSpec(
    JSON.parse(await Bun.file(join(scriptDir, "..", "fixtures", `${NAME}.spec.json`)).text()),
  );
  await writeFiles(formatAll(generate(spec)), outDir);

  checks.push({ name: "tsc --noEmit", ...run(["bunx", "tsc", "--noEmit"], outDir) });
  checks.push({
    name: "biome check",
    ...run(["bunx", "biome", "check", `packages/mcp-connectors/${NAME}/src/`], root),
  });
  checks.push({
    name: "audit:package-readmes",
    ...run(["bun", "run", "audit:package-readmes"], root),
  });
} finally {
  // Runs even if generation threw or a check crashed. Never leave the monorepo dirty.
  await rm(outDir, { recursive: true, force: true });
}

const status = run(["git", "status", "--short", "packages/mcp-connectors/"], root);
checks.push({
  name: "monorepo working tree clean",
  ok: status.output === "",
  output: status.output,
});

for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.ok && c.output !== "") console.log(c.output);
}

if (checks.some((c) => !c.ok)) process.exit(1);
console.log("\nAll acceptance checks passed.");
