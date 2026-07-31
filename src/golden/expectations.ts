import { readFileSync } from "node:fs";

/**
 * How a fixture's actual set of byte-identical files compares to the set declared in
 * fixtures/expectations.json. "pass" is the only non-failing verdict — "improved" is
 * deliberately still a failure (see classify's doc below).
 */
export type Verdict = "pass" | "regressed" | "improved" | "changed";

/** What actually differs between the declared and observed sets, for the failure line. */
export type Comparison = {
  readonly verdict: Verdict;
  /** Declared identical, but no longer identical. */
  readonly lost: readonly string[];
  /** Newly identical, but not declared. */
  readonly gained: readonly string[];
};

/**
 * Compare the set of byte-identical file paths a fixture actually produced against the
 * set declared in fixtures/expectations.json.
 *
 * This compares *which* files match, not how many. A count alone is a false-green hole:
 * for a partial fixture such as discord (3 of 6), a change that newly matches README.md
 * while breaking package.json holds the count at 3 and reports PASS, even though two
 * files changed behaviour.
 *
 * This is intentionally NOT an allow-list: a fixture that matches *more* than declared is
 * a failure ("improved"), not a pass. The harness's job is to assert that the checked-in
 * gap report (expectations.json + the design doc's criterion-2 section) matches reality —
 * in either direction. A silent improvement would let the design doc's documented-gap
 * prose drift out of date without anyone noticing.
 *
 * When files are both lost and gained the verdict is "changed": neither "regressed" nor
 * "improved" describes it, and collapsing it into either would mislabel the failure.
 */
export function classify(actual: readonly string[], expected: readonly string[]): Comparison {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const lost = [...expectedSet].filter((p) => !actualSet.has(p)).sort();
  const gained = [...actualSet].filter((p) => !expectedSet.has(p)).sort();

  let verdict: Verdict;
  if (lost.length === 0 && gained.length === 0) verdict = "pass";
  else if (gained.length === 0) verdict = "regressed";
  else if (lost.length === 0) verdict = "improved";
  else verdict = "changed";

  return { verdict, lost, gained };
}

/** Fixture name -> the sorted list of file paths expected to be byte-identical. */
export type Expectations = Readonly<Record<string, readonly string[]>>;

/**
 * Load fixtures/expectations.json. Throws — does not default silently — if the file is
 * missing, unparseable, or contains anything other than an array of unique non-empty
 * strings, since a bad expectations file must not let every fixture pass by accident.
 */
export function loadExpectations(path: string): Expectations {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read expectations file at ${path}: ${(err as Error).message}. ` +
        "Every checked-in fixture must have a declared set of byte-identical files.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Could not parse expectations file at ${path} as JSON: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Expectations file at ${path} must be a JSON object mapping fixture name -> array of ` +
        "file paths expected to be byte-identical.",
    );
  }

  const out: Record<string, readonly string[]> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
      throw new Error(
        `Expectations file at ${path}: "${name}" must map to an array of non-empty file-path ` +
          `strings, got ${JSON.stringify(value)}. (The old shape — a bare identical-file count — ` +
          "no longer distinguishes which files matched; list the paths instead.)",
      );
    }
    const paths = value as string[];
    if (new Set(paths).size !== paths.length) {
      throw new Error(
        `Expectations file at ${path}: "${name}" lists a duplicate file path — ` +
          "each expected path must appear once.",
      );
    }
    out[name] = paths;
  }
  return out;
}
