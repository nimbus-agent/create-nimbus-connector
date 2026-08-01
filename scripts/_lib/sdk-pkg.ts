/**
 * Resolves the `@nimbus-dev/sdk` package a generated connector should depend on.
 *
 * Shared by the two harnesses that install a generated package — standalone-acceptance.ts
 * and runtime-acceptance.ts — which each carried a byte-identical copy of this block at
 * MODULE SCOPE, for the same reason scripts/_lib/stdio-rpc.ts was lifted out: two copies of
 * one decision drift.
 *
 * Module scope is the part that mattered. `parseSdkArgs(process.argv.slice(2))` ran on
 * import, so importing either harness to reach any helper inside it consumed the importer's
 * argv — a test runner's flags, in practice — and then tried to resolve an SDK checkout that
 * machine may not have. Nothing in either file could be reached from a test. Taking argv and
 * the environment as parameters makes this callable from the entry point instead, and
 * testable on its own.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseSdkArgs, resolveSdkRoot } from "../../src/golden/sdk-root.ts";

/**
 * The local SDK package directory, or `undefined` in `--registry` mode.
 *
 * `undefined` is not a failure: it is the signal to leave the emitted `"@nimbus-dev/sdk":
 * "^x.y.z"` dependency exactly as generated so bun resolves it from npm, which is what makes
 * `--registry` answer "does the published tarball satisfy the contract?".
 *
 * @param argv      the harness's arguments, already sliced past the interpreter and script
 * @param env       the value of $NIMBUS_SDK_ROOT, or undefined when it is unset
 * @param scriptDir the calling script's directory; sibling checkouts are probed from here
 */
export function resolveSdkPkg(
  argv: readonly string[],
  env: string | undefined,
  scriptDir: string,
): string | undefined {
  const { registry, flag } = parseSdkArgs(argv);
  if (registry) return undefined;
  return join(
    resolveSdkRoot({
      ...(flag === undefined ? {} : { flag }),
      env,
      scriptDir,
    }),
    "sdks",
    "typescript",
  );
}

/**
 * Refuse to run against an unbuilt local SDK checkout.
 *
 * standalone-acceptance's `bunx tsc --noEmit` resolves the kit's types from
 * dist/connector-kit/index.d.ts, and its node_modules existence check needs
 * dist/connector-kit/index.js on disk. That is genuine dist coverage for types and for
 * install-time existence — but NOT for runtime JS execution: the two tools/list checks spawn
 * `bun`, and Bun applies the SDK's "bun" export condition, which points every entry point
 * (including ./connector-kit) at TypeScript source. So both `bun src/server.ts` and
 * `bun dist/server.js` run the kit from source, not from the built dist JS. The dist JS
 * runtime path a Node consumer takes is exercised by the SDK's own node-smoke CI job, not by
 * this harness.
 *
 * In `--registry` mode (`sdkPkg === undefined`) there is nothing local to build: the
 * published tarball either carries dist or it does not, which the node_modules check decides.
 * That is why an undefined package is a no-op here rather than an error.
 */
export function assertLocalSdkBuilt(sdkPkg: string | undefined): void {
  if (sdkPkg !== undefined && !existsSync(join(sdkPkg, "dist", "connector-kit", "index.js"))) {
    throw new Error(
      `${sdkPkg}/dist/connector-kit/index.js is missing — run \`bun run build\` in the SDK first. ` +
        "`bunx tsc --noEmit` below resolves the kit's types from dist/connector-kit/index.d.ts, " +
        "and the node_modules check asserts dist/connector-kit/index.js is on disk, so neither " +
        "can be verified against an unbuilt SDK.",
    );
  }
}

/**
 * The banner naming which of the two modes this run is answering for.
 *
 *   local checkout (default) — the generated dependency is rewritten to
 *     file:<sdk-root>/sdks/typescript. Answers "does an unreleased SDK branch satisfy the
 *     contract?", which is the pre-release gate: it can be pointed at a branch that is not
 *     on npm and cannot be, so it stays useful after every future SDK change.
 *
 *   --registry (sdkPkg undefined) — the generated "^1.11.0" is left alone and bun resolves
 *     it from npm. Answers "does the artifact actually on the registry satisfy the
 *     contract?" — which the local mode cannot, because a local checkout has files the
 *     published tarball may not. A `dist` missing from the published `files` array surfaces
 *     here and nowhere else.
 */
export function modeBanner(sdkPkg: string | undefined): string {
  return sdkPkg === undefined
    ? "Mode:        registry (@nimbus-dev/sdk resolved from npm, generated dependency unmodified)"
    : `Mode:        local checkout (${sdkPkg})`;
}
