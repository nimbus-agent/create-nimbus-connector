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
