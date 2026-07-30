import { readFileSync } from "node:fs";

/**
 * How a fixture's actual identical-file count compares to its declared expectation.
 * "pass" is the only non-failing verdict — "improved" is deliberately still a failure
 * (see classify doc below).
 */
export type Verdict = "pass" | "regressed" | "improved";

/**
 * Compare an actual identical-file count against the count declared in
 * fixtures/expectations.json.
 *
 * This is intentionally NOT an allow-list: an actual count *above* the declared
 * expectation is a failure ("improved"), not a pass. The harness's job is to assert
 * that the checked-in gap report (expectations.json + the design doc's criterion-2
 * section) matches reality — in either direction. A silent improvement would let the
 * design doc's documented-gap prose drift out of date without anyone noticing.
 */
export function classify(actual: number, expected: number): Verdict {
  if (actual === expected) return "pass";
  return actual < expected ? "regressed" : "improved";
}

export type Expectations = Readonly<Record<string, number>>;

/**
 * Load fixtures/expectations.json. Throws — does not default silently — if the file
 * is missing, unparseable, or contains a non-integer/negative value, since a bad
 * expectations file must not let every fixture pass by accident.
 */
export function loadExpectations(path: string): Expectations {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read expectations file at ${path}: ${(err as Error).message}. ` +
        "Every checked-in fixture must have a declared expected identical-file count.",
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
      `Expectations file at ${path} must be a JSON object mapping fixture name -> expected identical-file count.`,
    );
  }

  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(
        `Expectations file at ${path}: "${name}" must map to a non-negative integer, got ${JSON.stringify(value)}.`,
      );
    }
    out[name] = value;
  }
  return out;
}
