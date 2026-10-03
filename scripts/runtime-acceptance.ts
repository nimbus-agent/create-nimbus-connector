/**
 * Executes a generated connector against a real HTTP server and asserts on the requests it
 * actually makes.
 *
 * Everything else in this repo checks emitted output *statically*: string assertions,
 * `tsc`, `biome`, a byte-diff against the corpus, and `tools/list` — which proves the server
 * starts and describes itself, but never invokes a tool. So until this script existed, no
 * generated connector's `fetch` had ever run. Every belief about runtime behaviour was
 * inference from reading the emitted text.
 *
 * Two of those beliefs were load-bearing and had never been observed:
 *
 *   - that an unset optional boolean reaches the URL as `false` and is *absent* from the
 *     JSON body — the deliberate asymmetry README.md explains under *An unset optional
 *     boolean renders `false` in the URL but is omitted from a JSON body*, decided by
 *     argument and never executed;
 *   - that `client-credentials` performs the token exchange before the API call, and reuses
 *     the cached token for the second call rather than exchanging twice.
 *
 * Both are asserted here against recorded wire traffic.
 *
 * Like the other acceptance harnesses this needs the SDK installed, so it is a deliberately
 * run script rather than a CI test. Unlike them it needs no network beyond the SDK install:
 * the "API" is a Bun.serve on an ephemeral loopback port, and the generated connector's base
 * URL is pointed at it.
 *
 * What stays here is what a unit test cannot run: installing each generated package and driving
 * its server. The scenarios — each connector's spec, its credentials, the calls it is driven
 * through — and the checks that judge its traffic live in scripts/_lib/runtime-scenarios.ts, where
 * test/scripts/runtime-scenarios.test.ts shows every check failing on the traffic of a connector
 * that gets it wrong.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFiles } from "../src/cli.ts";
import { generate } from "../src/emit/index.ts";
import { formatAll, initFormatter } from "../src/format.ts";
import { parseSpec } from "../src/spec.ts";
import type { Check } from "./_lib/checks.ts";
import { type Recorded, startApi } from "./_lib/fake-api.ts";
import { callTools } from "./_lib/mcp-driver.ts";
import { RUNTIME_SCENARIOS, runtimeReport } from "./_lib/runtime-scenarios.ts";
import { resolveSdkPkg, withLocalSdk } from "./_lib/sdk-pkg.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Generate a package into `dir`, point its SDK dependency at the right place, install. */
async function materialize(spec: unknown, dir: string, sdkPkg: string | undefined): Promise<void> {
  const parsed = parseSpec(spec);
  await writeFiles(formatAll(generate(parsed, { target: "standalone" })), dir);
  if (sdkPkg !== undefined) {
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, withLocalSdk(await Bun.file(pkgPath).text(), sdkPkg), "utf8");
  }
  const install = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (install.exitCode !== 0) {
    throw new Error(`bun install failed in ${dir}:\n${install.stderr.toString()}`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const sdkPkg = resolveSdkPkg(argv, process.env["NIMBUS_SDK_ROOT"], scriptDir);

  await initFormatter();
  const recorded: Recorded[] = [];
  const { server, base } = startApi(recorded);
  const root = mkdtempSync(join(tmpdir(), "cnc-runtime-"));
  const checks: Check[] = [];

  try {
    // One scenario at a time against the one fake API. Each judge is handed only the requests
    // made since its own scenario started, which is what keeps "two tool calls, one exchange" a
    // statement about one connector rather than about the whole run. That is why both awaits
    // below stay in the loop rather than going to Promise.all: two scenarios in flight at once
    // would land both connectors' requests in one slice — and materialize's `bun install` is a
    // spawnSync, which Promise.all could not overlap anyway.
    for (const scenario of RUNTIME_SCENARIOS) {
      const dir = join(root, scenario.name);
      await materialize(scenario.spec(base), dir, sdkPkg); // NOSONAR S9382: scenarios share one fake API, so they must not overlap
      const before = recorded.length;
      const results = await callTools(dir, { ...scenario.env }, scenario.calls, scenario.gapMs); // NOSONAR S9382: the judge reads recorded.slice(before)
      checks.push(...scenario.judge(recorded.slice(before), results));
    }
  } finally {
    // `true` closes any connection a connector left open, so this settles at once instead of
    // waiting on a keep-alive.
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }

  const { lines, failure } = runtimeReport(checks);
  for (const line of lines) console.log(line);
  if (failure !== undefined) throw new Error(failure);
}

// Guarded exactly as src/cli.ts is. argv used to be consumed at module scope, so importing
// this file either resolved an SDK checkout the importer did not have or threw on flags it
// never passed. `bun scripts/runtime-acceptance.ts [--registry|--sdk-root <path>]` is unchanged.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
