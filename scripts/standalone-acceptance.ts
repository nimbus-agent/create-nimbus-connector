import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFiles } from "../src/cli.ts";
import { generate } from "../src/emit/index.ts";
import {
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../src/format.ts";
import { run } from "../src/golden/run.ts";
import { parseSdkArgs, resolveSdkRoot } from "../src/golden/sdk-root.ts";
import { parseSpec } from "../src/spec.ts";

/**
 * Both emission styles, because they import the kit differently and only one of them was
 * ever proven against a real SDK.
 *
 * rest-kit imports `makeRestToolRegistrar`; hand-rolled imports `mcpJsonResult as
 * jsonResult` and builds its own fetch helper. A kit export that the hand-rolled branch
 * needs and the rest-kit branch does not would have typechecked here and failed for a
 * user — every generated file is emitted from the same code path, so "one style works"
 * says nothing about the other.
 */
const FIXTURES = [
  "zzstandalone",
  "zzstandalonehand",
  "zzwrite",
  // A hand-rolled connector whose ONLY tool mutates. It is here because it is the one shape
  // that must NOT emit a read fetch helper: a write tool calls `<local>Send`, so an
  // unconditionally-emitted `<local>` has no call site, and the generated package's own
  // `bun run typecheck` (noUnusedLocals) and `bun run lint` (noUnusedVariables) both reject
  // it. Nothing else in this project compiles a write-only package, which is how that
  // shipped. Its boolean arg covers the paired hoist defect from the same fix wave.
  "zzwriteonly",
  "zzwriterest",
] as const;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const { registry, flag } = parseSdkArgs(process.argv.slice(2));

/**
 * Two modes, answering two different questions. Both run the identical check list.
 *
 *   local checkout (default) — rewrite the generated dependency to
 *     file:<sdk-root>/sdks/typescript. Answers "does an unreleased SDK branch satisfy the
 *     contract?", which is the pre-release gate: it can be pointed at a branch that is not
 *     on npm and cannot be, so it stays useful after every future SDK change.
 *
 *   --registry — leave the generated "^1.11.0" alone and let bun resolve it from npm.
 *     Answers "does the artifact actually on the registry satisfy the contract?" — which
 *     the local mode cannot, because a local checkout has files the published tarball may
 *     not. A `dist` missing from the published `files` array surfaces here and nowhere
 *     else.
 */
const sdkPkg = registry
  ? undefined
  : join(
      resolveSdkRoot({
        ...(flag === undefined ? {} : { flag }),
        env: process.env["NIMBUS_SDK_ROOT"],
        scriptDir,
      }),
      "sdks",
      "typescript",
    );

// The local SDK must be built before any of this runs: `bunx tsc --noEmit` below resolves
// the kit's types from dist/connector-kit/index.d.ts, and the node_modules existence check
// below needs dist/connector-kit/index.js on disk. That is genuine dist coverage for
// types and for install-time existence — but NOT for runtime JS execution: the two
// tools/list checks spawn `bun`, and Bun applies the SDK's "bun" export condition, which
// points every entry point (including ./connector-kit) at TypeScript source
// (src/connector-kit/index.ts). So both `bun src/server.ts` and `bun dist/server.js` run
// the kit from source, not from the built dist JS. The dist JS runtime path a Node
// consumer takes is exercised by the SDK's own node-smoke CI job
// (sdks/typescript/scripts/smoke-esm.mjs, run under Node via .github/workflows/ci.yml),
// not by this harness. In --registry mode there is nothing local to build: the published
// tarball either carries dist or it does not, which the node_modules check below decides.
if (sdkPkg !== undefined && !existsSync(join(sdkPkg, "dist", "connector-kit", "index.js"))) {
  throw new Error(
    `${sdkPkg}/dist/connector-kit/index.js is missing — run \`bun run build\` in the SDK first. ` +
      "`bunx tsc --noEmit` below resolves the kit's types from dist/connector-kit/index.d.ts, " +
      "and the node_modules check asserts dist/connector-kit/index.js is on disk, so neither " +
      "can be verified against an unbuilt SDK.",
  );
}

type Check = { name: string; ok: boolean; output: string };

/** Generate, install, build and drive one fixture. Its temp tree is removed either way. */
async function runFixture(NAME: string): Promise<Check[]> {
  // realpathSync normalises a Windows short (8.3) path such as C:\Users\ASAFG~1\... to its
  // long form. It does not differ on every machine — it did not on the one this plan was
  // written on — but a mismatch between the path we write to and the path tooling resolves
  // shows up as confusing module-resolution failures, and one call removes the class.
  const outDir = realpathSync(mkdtempSync(join(tmpdir(), "cnc-standalone-")));
  const checks: Check[] = [];

  try {
    await initFormatter();
    if (!formatterAvailable()) {
      throw new Error(`@biomejs/biome is required for this check. ${formatterUnavailableReason()}`);
    }

    const spec = parseSpec(
      JSON.parse(await Bun.file(join(scriptDir, "..", "fixtures", `${NAME}.spec.json`)).text()),
    );
    await writeFiles(formatAll(generate(spec, { target: "standalone" })), outDir);

    const pkgPath = join(outDir, "package.json");
    const declaredSdkDep = JSON.parse(readFileSync(pkgPath, "utf8")).dependencies[
      "@nimbus-dev/sdk"
    ];

    if (sdkPkg === undefined) {
      // --registry: install exactly what the generator emitted. No rewrite, so a failure
      // here is a real consumer's failure.
      console.log(`  ${NAME}: installing @nimbus-dev/sdk ${declaredSdkDep} as emitted`);
      checks.push({ name: "bun install", ...run(["bun", "install"], outDir) });
    } else {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      pkg.dependencies["@nimbus-dev/sdk"] = `file:${sdkPkg.replaceAll("\\", "/")}`;
      writeFileSync(pkgPath, `${JSON.stringify(pkg, undefined, 2)}\n`);

      // --force so a rebuilt SDK at the same path and version is not served from bun's cache.
      // The temp dir is fresh so node_modules is empty, but the cached *file:* package is not.
      checks.push({ name: "bun install", ...run(["bun", "install", "--force"], outDir) });
    }

    // Prove the built kit actually landed. In local mode this catches a stale --force; in
    // registry mode it is the check that catches `dist` missing from the published tarball's
    // `files` array, which nothing else in this project can see.
    const installedKit = join(
      outDir,
      "node_modules",
      "@nimbus-dev",
      "sdk",
      "dist",
      "connector-kit",
      "index.js",
    );
    checks.push({
      name: "connector-kit present in node_modules",
      ok: existsSync(installedKit),
      output: existsSync(installedKit)
        ? installedKit
        : `${installedKit} is missing — the SDK installed without the connector-kit build output`,
    });

    checks.push({ name: "tsc --noEmit", ...run(["bunx", "tsc", "--noEmit"], outDir) });

    // Run the generated package's OWN scripts, not equivalents. Both were unrunnable in a
    // standalone package until the emitted devDependencies and biome.json landed, and this
    // harness did not notice: it resolves them through node_modules, exactly as a consumer
    // does. `bun run lint` additionally re-checks the emitted formatting and import order
    // against the emitted biome.json, so a drift between the two fails here.
    checks.push(
      { name: "bun run typecheck", ...run(["bun", "run", "typecheck"], outDir) },
      { name: "bun run lint", ...run(["bun", "run", "lint"], outDir) },
    );

    // Scoped to src/ specifically, not the whole package: the generated test/sandbox.test.ts
    // legitimately contains "../../" (it resolves from test/ up to the package root), so
    // scanning outDir as a whole would flag correct code. src/ is where an escaping relative
    // import would actually matter.
    const escaping = findEscapingImports(join(outDir, "src"));
    checks.push({
      name: "no relative import escapes the package",
      ok: escaping.trim() === "",
      output: escaping,
    });

    const expectedTools = spec.tools.map((t) => t.name);

    // src/server.ts is what `bun run dev` runs — worth proving on its own, independent of
    // the bundler.
    checks.push({
      name: "tools/list over stdio (src)",
      ...(await toolsListCheck(outDir, "src/server.ts", expectedTools)),
    });

    // nimbus.extension.json declares entrypoint: "dist/server.js", which is what the Nimbus
    // Gateway actually launches. Nothing else in this project builds or runs that artifact,
    // so prove `bun run build` produces it before trusting the source-level checks above.
    checks.push({ name: "bun run build", ...run(["bun", "run", "build"], outDir) });
    const builtServer = join(outDir, "dist", "server.js");
    checks.push({
      name: "dist/server.js exists after build",
      ok: existsSync(builtServer),
      output: existsSync(builtServer)
        ? builtServer
        : `${builtServer} is missing — \`bun run build\` did not produce the entrypoint the Gateway launches`,
    });

    // The build check above only proves the artifact exists, not that it runs. A bundler
    // can externalize or strip an import in a way that leaves every source-level check
    // green while dist/server.js is broken — so drive the actual Gateway-launched file
    // over stdio too, not just the unbundled source.
    checks.push({
      name: "tools/list over stdio (dist/server.js)",
      ...(await toolsListCheck(outDir, "dist/server.js", expectedTools)),
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  return checks;
}

console.log(
  sdkPkg === undefined
    ? "Mode:        registry (@nimbus-dev/sdk resolved from npm, generated dependency unmodified)"
    : `Mode:        local checkout (${sdkPkg})`,
);
console.log(`Fixtures:    ${FIXTURES.join(", ")}\n`);

const checks: Check[] = [];
for (const fixture of FIXTURES) {
  const result = await runFixture(fixture);
  // Prefixed so a failure names the style that produced it. Both fixtures emit the same
  // check list, so an unprefixed report would show two identically-named failures.
  checks.push(...result.map((c) => ({ ...c, name: `[${fixture}] ${c.name}` })));
}

for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.ok && c.output !== "") console.log(c.output);
}

if (checks.some((c) => !c.ok)) process.exit(1);
console.log("\nAll standalone acceptance checks passed.");

/**
 * Pure-Bun replacement for `grep -rn "\.\./\.\." <dir>`: no external binary, so it works
 * identically under PowerShell and Git Bash. Recurses through dir and returns one
 * "path:line:content" entry per matching line (grep's -n format), or "" if none match.
 */
function findEscapingImports(dir: string): string {
  const matches: string[] = [];

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const lines = readFileSync(full, "utf8").split("\n");
        for (const [i, line] of lines.entries()) {
          if (line.includes("../..")) {
            matches.push(`${relative(dir, full).replaceAll("\\", "/")}:${i + 1}:${line}`);
          }
        }
      }
    }
  };

  if (existsSync(dir)) walk(dir);
  return matches.join("\n");
}

async function toolsListCheck(
  cwd: string,
  entryPath: string,
  expected: readonly string[],
): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bun", entryPath], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // No credential env vars are set. Accessors are only called inside tool handlers,
    // so a clean tools/list proves the server starts and describes itself without secrets.
  });

  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "standalone-acceptance", version: "0.0.0" },
      },
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let sawInitialized = false;

    // Read until the tools/list response (id 2) arrives, the process exits, or the timeout kills it.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      const lines = buffered.split("\n");
      buffered = lines.pop() ?? ""; // keep the trailing partial fragment

      for (const line of lines) {
        if (line.trim() === "") continue;
        let msg: { id?: unknown; result?: { tools?: Array<{ name?: string }> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a warning or other non-JSON output — not a protocol error
        }

        if (msg.id === 1 && !sawInitialized) {
          sawInitialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
          continue;
        }

        if (msg.id === 2) {
          const names = (msg.result?.tools ?? []).map((t) => t.name);
          const missing = expected.filter((n) => !names.includes(n));
          return {
            ok: missing.length === 0,
            output:
              missing.length === 0
                ? `tools/list returned ${names.join(", ")}`
                : `tools/list missing ${missing.join(", ")}; got ${names.join(", ") || "(none)"}`,
          };
        }
      }
    }

    const stderr = await new Response(proc.stderr).text();
    return { ok: false, output: `server exited before answering tools/list.\n${stderr.trim()}` };
  } finally {
    clearTimeout(timer);
    proc.kill();
    // kill() only signals. Without awaiting exit, this returns while the server is still
    // running, and the caller's `rmSync(outDir)` races it — on Windows, removing a
    // directory whose files a live process still holds open fails outright. Four servers
    // are spawned per run now that both fixtures are exercised.
    await proc.exited;
  }
}
