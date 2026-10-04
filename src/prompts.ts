import { type AuthKind, buildSpec } from "./prompt-spec.ts";
import { type ConnectorSpec, capitalize } from "./spec.ts";

/**
 * Bun implements the browser `prompt(message, default)`: synchronous, prints
 * the ` [default]` hint itself, and returns the default on empty input or EOF.
 * Verified on Bun 1.3.14.
 *
 * Deliberately NOT `for await (const line of console)`: Bun does make `console`
 * async-iterable, but each call opens a fresh iterator over the same stdin
 * stream, and returning early closes it — a real hazard across nine
 * sequential questions. `prompt()` avoids the whole class of problem.
 */
function ask(question: string, fallback = ""): string {
  return prompt(question, fallback) ?? fallback;
}

/**
 * Bounded, NOT `while (true)`.
 *
 * Bun's `prompt()` returns the default on EOF, so a piped or redirected stdin answers every
 * question identically and forever. An unbounded re-prompt would hang the CLI outright in
 * exactly the situation where nobody is watching — CI, a script, `echo | npx ...`. Three
 * attempts, then a message naming the field and the last value seen.
 */
const MAX_ATTEMPTS = 3;

function askValidated(
  question: string,
  fallback: string,
  validate: (value: string) => string | undefined,
): string {
  let last = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = ask(question, fallback);
    const problem = validate(last);
    if (problem === undefined) return last;
    console.error(`  ${problem}`);
  }
  throw new Error(
    `${question}: no valid answer after ${MAX_ATTEMPTS} attempts (last: ${JSON.stringify(last)}). ` +
      "If you are not answering interactively, write a spec file and pass --spec instead.",
  );
}

/** The schema's own rule, restated here so the prompt rejects what parseSpec would reject. */
const CONNECTOR_NAME = /^[a-z0-9-]+$/;

const AUTH_KINDS: readonly AuthKind[] = ["bearer", "token", "basic"];

/**
 * Case and whitespace are forgiven; an unrecognised value is not.
 *
 * This used to fall back to "bearer" for anything it did not recognise, so a user answering
 * "oauth" got a bearer connector and no indication that their answer had been discarded —
 * the same silent-wrong-output shape as the `{id}` path template. Returns undefined so the
 * caller can re-ask.
 */
function normalizeAuthKind(raw: string): AuthKind | undefined {
  const lower = raw.trim().toLowerCase();
  return (AUTH_KINDS as readonly string[]).includes(lower) ? (lower as AuthKind) : undefined;
}

/**
 * Each answer is validated where it is given, not all at once at the end.
 *
 * The name is why. Every later default is derived from it — the base URL, the env var, the
 * tool name — so an empty or malformed name used to produce a cascade of derived garbage
 * (`https://api..com`, `_TOKEN`) and surface as four simultaneous schema errors after the
 * last question, with nothing pointing at the one answer that caused them. buildSpec still
 * validates everything, and remains the authority; this only moves the common failures to
 * the moment they can still be corrected.
 */
export function promptForSpec(seedName?: string): ConnectorSpec {
  const name =
    seedName ??
    askValidated("Connector name (lower-kebab-case)", "", (v) =>
      CONNECTOR_NAME.test(v.trim())
        ? undefined
        : `"${v}" is not lower-kebab-case — letters, digits and hyphens only, e.g. "acme-crm".`,
    ).trim();

  const nonEmpty = (label: string) => (v: string) =>
    v.trim() === "" ? `${label} cannot be empty.` : undefined;

  const displayName = askValidated("Display name", capitalize(name), nonEmpty("Display name"));
  const serviceLabel = askValidated(
    "Service label used in error messages",
    displayName,
    nonEmpty("Service label"),
  );
  const description = askValidated(
    "Description",
    `${displayName} connector. Read-focused.`,
    nonEmpty("Description"),
  );
  const baseUrl = askValidated("Base API URL", `https://api.${name}.com`, (v) => {
    try {
      new URL(v.trim());
      return undefined;
    } catch {
      return `"${v}" is not a URL — include the scheme, e.g. "https://api.acme.com".`;
    }
  });
  const authKind = normalizeAuthKind(
    askValidated("Auth type (bearer | token | basic)", "bearer", (v) =>
      normalizeAuthKind(v) === undefined
        ? `"${v}" is not one of: ${AUTH_KINDS.join(", ")}.`
        : undefined,
    ),
  );
  // Unreachable: askValidated only returns a value normalizeAuthKind accepts.
  if (authKind === undefined) throw new Error("unreachable: auth kind passed validation");

  const envVar = askValidated(
    "Credential env var",
    `${name.toUpperCase().replaceAll("-", "_")}_TOKEN`,
    (v) =>
      /^[A-Z][A-Z0-9_]*$/.test(v.trim())
        ? undefined
        : `"${v}" is not an environment variable name — upper snake case, e.g. "ACME_TOKEN".`,
  ).trim();
  const headerName =
    authKind === "bearer"
      ? ""
      : askValidated("Header name", "X-Api-Key", nonEmpty("Header name")).trim();

  const splitTools = (csv: string) =>
    csv
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");

  const toolCsv = askValidated("Read tool names (comma-separated)", `${name}_list`, (v) =>
    splitTools(v).length === 0 ? "At least one tool name is required." : undefined,
  );
  const toolNames = splitTools(toolCsv);

  return buildSpec({
    name,
    displayName,
    serviceLabel,
    description,
    baseUrl,
    authKind,
    envVar,
    headerName,
    toolNames,
  });
}
