/**
 * Generates each standalone fixture into a temp tree, installs a real @nimbus-dev/sdk into
 * it, builds it, and drives the result over stdio.
 *
 * What remains here is everything that needs those subprocesses. The pieces that decide
 * something from their arguments alone live in scripts/_lib/ — sdk-pkg.ts (which SDK, and
 * whether it is built), mcp-frames.ts (reading the tools/list reply), escaping-imports.ts,
 * checks.ts — where they are unit-tested. See scripts/_lib/mcp-frames.ts's header for why
 * the split has to fall exactly there.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { run } from "../src/golden/run.ts";
import { parseSpec } from "../src/spec.ts";
import { type Check, formatCheckLines, isUnpublishedFloorFailure } from "./_lib/checks.ts";
import { findEscapingImports } from "./_lib/escaping-imports.ts";
import { toolsListCheck } from "./_lib/mcp-driver.ts";
import { assertLocalSdkBuilt, modeBanner, resolveSdkPkg } from "./_lib/sdk-pkg.ts";

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
  // The read-only-kit style and the search path, which nothing else here compiles. Three
  // things only a real tsc can decide meet in these two: the inlined runReadOnlyMcpConnector
  // glue (standalone emits it rather than importing it, and it names two SDK types in its
  // signature), the kit import list, and — in zzsearchstub — whether src/search-filter.ts
  // names fieldsFromKeys, makeQueryFilter and SearchFilter and neither more nor less. An
  // over- or under-named import there is a noUnusedLocals error or an unresolved one, and no
  // substring assertion in test/ can see either.
  "zzsearch",
  "zzsearchstub",
  // Stage E's extractor branch, proven against a real SDK for the same reason as the two
  // above: no in-process test can see whether the seven primitives it emits
  // (asObjectish/stringField/nestedString/tagText/tagNamesFromObjects/fieldsFromKeys/
  // makeQueryFilter) actually exist in the published @nimbus-dev/sdk. Two search tools, one
  // taking the fieldsOf extractor branch and one converging onto fieldsFromKeys, so a single
  // registry run proves both import lists resolve.
  "zzextract",
] as const;
const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Generate, install, build and drive one fixture. Its temp tree is removed either way. */
async function runFixture(NAME: string, sdkPkg: string | undefined): Promise<Check[]> {
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
      const install = run(["bun", "install"], outDir);

      // ...with one exception, and only one: the fixture declares a floor that is not
      // published yet. Every later check in this function needs node_modules, so without
      // this a single unresolvable dependency reports as nine further failures that say
      // nothing — which is exactly what Stage D's two search fixtures did while
      // @nimbus-dev/sdk ^1.15.0 sat on an unmerged branch. One SKIP naming the version is
      // the honest report, and main() below refuses to call the run green when it happens.
      if (!install.ok && isUnpublishedFloorFailure(install.output, declaredSdkDep)) {
        return [
          {
            name: `bun install (@nimbus-dev/sdk ${declaredSdkDep})`,
            ok: true,
            skipped: true,
            output:
              `@nimbus-dev/sdk ${declaredSdkDep} is not on the registry yet, so this fixture's ` +
              "10 checks cannot run in --registry mode. Nothing is verified about it here. " +
              "Run the harness against a local SDK checkout to cover it before the release, " +
              "and re-run this mode after the release lands — it needs no edit to re-enable.",
          },
        ];
      }
      checks.push({ name: "bun install", ...install });
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
    // One push, several checks: arguments evaluate left to right, so each `run(...)` still
    // executes in exactly the order written — install-time existence, then tsc, then the
    // package's own scripts.
    checks.push(
      {
        name: "connector-kit present in node_modules",
        ok: existsSync(installedKit),
        output: existsSync(installedKit)
          ? installedKit
          : `${installedKit} is missing — the SDK installed without the connector-kit build output`,
      },
      { name: "tsc --noEmit", ...run(["bunx", "tsc", "--noEmit"], outDir) },
      // Run the generated package's OWN scripts, not equivalents. Both were unrunnable in a
      // standalone package until the emitted devDependencies and biome.json landed, and this
      // harness did not notice: it resolves them through node_modules, exactly as a consumer
      // does. `bun run lint` additionally re-checks the emitted formatting and import order
      // against the emitted biome.json, so a drift between the two fails here.
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

    checks.push(
      // src/server.ts is what `bun run dev` runs — worth proving on its own, independent of
      // the bundler.
      {
        name: "tools/list over stdio (src)",
        ...(await toolsListCheck(outDir, "src/server.ts", expectedTools)),
      },
      // nimbus.extension.json declares entrypoint: "dist/server.js", which is what the Nimbus
      // Gateway actually launches. Nothing else in this project builds or runs that artifact,
      // so prove `bun run build` produces it before trusting the source-level checks above.
      // Evaluated after the await above, since arguments evaluate left to right.
      { name: "bun run build", ...run(["bun", "run", "build"], outDir) },
    );

    const builtServer = join(outDir, "dist", "server.js");
    checks.push(
      {
        name: "dist/server.js exists after build",
        ok: existsSync(builtServer),
        output: existsSync(builtServer)
          ? builtServer
          : `${builtServer} is missing — \`bun run build\` did not produce the entrypoint the Gateway launches`,
      },
      // The build check above only proves the artifact exists, not that it runs. A bundler
      // can externalize or strip an import in a way that leaves every source-level check
      // green while dist/server.js is broken — so drive the actual Gateway-launched file
      // over stdio too, not just the unbundled source.
      {
        name: "tools/list over stdio (dist/server.js)",
        ...(await toolsListCheck(outDir, "dist/server.js", expectedTools)),
      },
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  return checks;
}

async function main(argv: readonly string[]): Promise<void> {
  const sdkPkg = resolveSdkPkg(argv, process.env["NIMBUS_SDK_ROOT"], scriptDir);
  assertLocalSdkBuilt(sdkPkg);

  console.log(modeBanner(sdkPkg));
  console.log(`Fixtures:    ${FIXTURES.join(", ")}\n`);

  const checks: Check[] = [];
  for (const fixture of FIXTURES) {
    const result = await runFixture(fixture, sdkPkg);
    // Prefixed so a failure names the style that produced it. Both fixtures emit the same
    // check list, so an unprefixed report would show two identically-named failures.
    checks.push(...result.map((c) => ({ ...c, name: `[${fixture}] ${c.name}` })));
  }

  for (const line of formatCheckLines(checks)) console.log(line);

  if (checks.some((c) => !c.ok)) process.exit(1);

  // A run with skips exits 0 — the skipped question is unanswerable, not failed — but it must
  // never print the same sentence a fully-verified run prints. Naming the fixtures is the
  // point: "all checks passed" over a silently reduced fixture set is precisely how a gate
  // stops gating without anyone noticing.
  const skipped = checks.filter((c) => c.skipped === true);
  if (skipped.length > 0) {
    const names = skipped.map((c) => c.name.replace(/^\[([^\]]+)\].*$/, "$1")).join(", ");
    console.log(
      `\nStandalone acceptance passed for every fixture it could run, and SKIPPED ${skipped.length}: ${names}.` +
        "\nThose fixtures are NOT verified against the registry by this run.",
    );
    return;
  }
  console.log("\nAll standalone acceptance checks passed.");
}

// Guarded exactly as src/cli.ts is. All of the above used to run at module scope: argv was
// consumed on import, an unbuilt SDK threw on import, five fixtures were generated and
// installed on import, and process.exit could be called on import. Nothing in the file could
// be reached from a test. `bun scripts/standalone-acceptance.ts [--registry|<sdk-root>]` is
// unchanged — import.meta.main is true for the entry point.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
