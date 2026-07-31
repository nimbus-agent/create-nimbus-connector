import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFiles } from "../src/cli.ts";
import { generate } from "../src/emit/index.ts";
import {
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../src/format.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { run } from "../src/golden/run.ts";
import { parseSpec } from "../src/spec.ts";

const NAME = "zzscratch";
const scriptDir = dirname(fileURLToPath(import.meta.url));

const root = resolveNimbusRoot({
  flag: process.argv[2],
  env: process.env.NIMBUS_ROOT,
  scriptDir,
});
const outDir = join(root, "packages", "mcp-connectors", NAME);

const checks: { name: string; ok: boolean; output: string }[] = [];

await initFormatter();
if (!formatterAvailable()) {
  throw new Error(
    "@biomejs/biome is required here — byte-exactness is the point of this check, and " +
      "unformatted output would produce spurious diffs that look like emitter regressions. " +
      formatterUnavailableReason(),
  );
}

try {
  const spec = parseSpec(
    JSON.parse(await Bun.file(join(scriptDir, "..", "fixtures", `${NAME}.spec.json`)).text()),
  );
  await writeFiles(formatAll(generate(spec)), outDir);

  checks.push(
    { name: "tsc --noEmit", ...run(["bunx", "tsc", "--noEmit"], outDir) },
    {
      name: "biome check",
      ...run(["bunx", "biome", "check", `packages/mcp-connectors/${NAME}/src/`], root),
    },
    {
      name: "audit:package-readmes",
      ...run(["bun", "run", "audit:package-readmes"], root),
    },
  );
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
