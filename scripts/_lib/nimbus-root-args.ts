import { takeValue } from "../../src/cli.ts";

/**
 * The argument parser shared by the two commands whose entire command line is `--nimbus-root`
 * and nothing else: `bun run preflight` and `bun run reach:baseline`.
 *
 * Both held their own copy of this loop, identical but for the sentence they refuse with — and
 * the loop is where the interesting decision lives, not the sentence. An unrecognised argument
 * is REFUSED rather than ignored, which is the whole reason either function exists: a typo such
 * as `--nimbus_root` would otherwise parse as "no root given", and the command would run a
 * quieter job than the caller asked for while reporting success. `bun run reach:baseline
 * newrelic` had exactly that shape before it was fixed — it dropped the name and rewrote the
 * full baseline, looking like a scoped run that never happened.
 *
 * Lives in `_lib` rather than beside either `main()`, on the precedent both copies already
 * cited: an entry point needs a Nimbus checkout and cannot be reached by a test, so parsing
 * left there is parsing nothing measures.
 *
 * `command` and `why` are the two halves the callers still differ on. They are joined into one
 * sentence here so the two commands cannot start refusing in different shapes.
 */
export function parseNimbusRootOnly(
  argv: readonly string[],
  command: string,
  why: string,
): { nimbusRoot?: string } {
  let nimbusRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nimbus-root") {
      nimbusRoot = takeValue(argv, ++i, "--nimbus-root");
    } else {
      throw new Error(`${command} accepts only --nimbus-root; got "${a}". ${why}`);
    }
  }
  return { nimbusRoot };
}
