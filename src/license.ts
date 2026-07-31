/**
 * The license a monorepo-target connector carries, unconditionally. The package sits inside
 * the AGPL Nimbus repo and imports AGPL code from `../../shared/*`, and its `package.json`
 * is byte-locked against 94 real connectors. This is not configurable.
 */
export const MONOREPO_LICENSE = "AGPL-3.0-only";

/**
 * The license a standalone connector carries when `--license` is not given.
 *
 * A standalone package is the user's own code, produced by an MIT tool and depending only
 * on the MIT SDK — nothing about it obliges copyleft, so it must not inherit the monorepo's
 * AGPL stamp. `UNLICENSED` is npm's marker for "no license granted": it is the honest
 * default for a package whose author has not chosen one yet, and it is a deliberate
 * non-choice rather than a wrong choice made on the author's behalf.
 */
export const DEFAULT_STANDALONE_LICENSE = "UNLICENSED";

export function defaultLicenseFor(target: "monorepo" | "standalone"): string {
  return target === "standalone" ? DEFAULT_STANDALONE_LICENSE : MONOREPO_LICENSE;
}

/** An SPDX short identifier or license-exception id, e.g. MIT, Apache-2.0, LicenseRef-Acme. */
const SPDX_TOKEN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
/** SPDX operators are case-sensitive and uppercase. */
const OPERATORS = new Set(["AND", "OR", "WITH"]);

const SYNTAX_HINT =
  'Expected an SPDX identifier or expression, e.g. "MIT", "Apache-2.0", ' +
  '"AGPL-3.0-only", "MIT OR Apache-2.0", or "UNLICENSED".';

/**
 * Validate a `--license` value and return it trimmed.
 *
 * Deliberately a plausibility check, not a full SPDX license-list lookup: this tool has no
 * business shipping and ageing a copy of the SPDX registry, and a private
 * `LicenseRef-<name>` is legitimate and would fail such a lookup. What it does guarantee is
 * that a malformed value fails here rather than landing in a generated `package.json`,
 * where npm would reject it long after the fact.
 */
export function validateLicense(raw: string): string {
  const value = raw.trim();

  if (value === "") {
    throw new Error(`--license requires a non-empty value. ${SYNTAX_HINT}`);
  }

  // npm accepts this form, but it is not SPDX and the flag is documented as taking one.
  // Catch it by name rather than letting it fail as a generic parse error.
  if (/^SEE\s+LICENSE\s+IN\b/i.test(value)) {
    throw new Error(
      `--license does not accept npm's "SEE LICENSE IN <file>" form — it is not an SPDX ` +
        `expression. Generate with an SPDX identifier and edit package.json afterwards if ` +
        `you need that form. ${SYNTAX_HINT}`,
    );
  }

  const illegal = [...new Set(value.replace(/[A-Za-z0-9.+()\s-]/g, ""))];
  if (illegal.length > 0) {
    throw new Error(
      `--license value ${JSON.stringify(raw)} contains characters that cannot appear in an ` +
        `SPDX expression: ${illegal.map((c) => JSON.stringify(c)).join(", ")}. ${SYNTAX_HINT}`,
    );
  }

  const tokens = value
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter((t) => t !== "");

  const bad = (why: string): never => {
    throw new Error(
      `--license value ${JSON.stringify(raw)} is not a valid SPDX expression: ${why}. ${SYNTAX_HINT}`,
    );
  };

  let depth = 0;
  let expectOperand = true;
  for (const t of tokens) {
    if (t === "(") {
      if (!expectOperand) bad('"(" where an operator was expected');
      depth++;
    } else if (t === ")") {
      if (expectOperand) bad('")" where a license identifier was expected');
      depth--;
      if (depth < 0) bad('unbalanced ")"');
    } else if (OPERATORS.has(t)) {
      if (expectOperand) bad(`"${t}" where a license identifier was expected`);
      expectOperand = true;
    } else if (!expectOperand) {
      // Two identifiers in a row. Overwhelmingly this is a lowercase operator, since SPDX
      // requires AND/OR/WITH uppercase — say so instead of just "unexpected token".
      if (OPERATORS.has(t.toUpperCase())) {
        bad(`operator "${t}" must be uppercase ("${t.toUpperCase()}")`);
      }
      bad(`"${t}" where an operator (AND, OR, WITH) was expected`);
    } else if (!SPDX_TOKEN.test(t)) {
      bad(`"${t}" is not a valid license identifier`);
    } else {
      expectOperand = false;
    }
  }

  if (depth !== 0) bad('unbalanced "("');
  if (expectOperand) bad("it ends with an operator");

  return value;
}
