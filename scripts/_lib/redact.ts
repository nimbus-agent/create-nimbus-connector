/**
 * Describing a credential-bearing value in a harness report WITHOUT reproducing any part of
 * it.
 *
 * CodeQL flagged scripts/runtime-acceptance.ts for clear-text logging of sensitive
 * information, and it was right about more than the line it pointed at: six checks echoed
 * bearer tokens, an API key, and a `client_secret=` form body straight to stdout. The values
 * are synthetic, but a harness whose output is safe only because its inputs are fake is one
 * edit away from not being, and this output lands in CI logs.
 *
 * THE RULE, and it is the whole reason these are functions rather than string interpolation
 * at the call site: every value returned here is a STRING LITERAL selected by a comparison.
 * Nothing is extracted from the credential — no prefix, no length, no regex capture, no
 * parsed key name — because anything derived from the value carries its taint into the log.
 *
 * A first attempt got this wrong in a way worth recording: it returned
 * `${scheme}, unexpected value`, pulling the auth scheme out of the header with a regex.
 * That reads as harmless — a scheme is not a secret — but it is still a value derived from
 * the credential flowing to stdout, and CodeQL re-flagged the file for it. Comparison
 * results are not tainted; substrings of the secret are. Keep the branches, drop the
 * extraction.
 */

/** Whether a credential-bearing header is absent, as expected, or something else. */
export function describeAuth(value: string | undefined, expected: string): string {
  if (value === undefined) return "absent";
  return value === expected ? "present, as expected" : "present, unexpected value";
}

/**
 * Whether a token-exchange body carries exactly the expected form fields — reported as a
 * literal, since even the field NAMES are parsed out of a string containing the secret.
 */
export function describeFormFields(body: string | undefined, expected: readonly string[]): string {
  if (body === undefined || body === "") return "(empty)";
  const params = new URLSearchParams(body);
  const missing = expected.filter((n) => !params.has(n));
  return missing.length === 0 ? "carries the expected fields" : "missing expected field(s)";
}
