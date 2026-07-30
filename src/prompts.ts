import { type ConnectorSpec, capitalize, parseSpec } from "./spec.ts";

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

export type AuthKind = "bearer" | "token" | "basic";

const AUTH_KINDS: readonly AuthKind[] = ["bearer", "token", "basic"];

function normalizeAuthKind(raw: string): AuthKind {
  const lower = raw.trim().toLowerCase();
  return (AUTH_KINDS as readonly string[]).includes(lower) ? (lower as AuthKind) : "bearer";
}

/** Raw answers collected from the interactive session, before spec construction. */
export type PromptAnswers = {
  name: string;
  displayName: string;
  serviceLabel: string;
  description: string;
  baseUrl: string;
  authKind: AuthKind;
  envVar: string;
  /** Header name; only meaningful (and only asked for) when authKind is "token" or "basic". */
  headerName: string;
  toolNames: readonly string[];
};

/**
 * Pure spec construction from collected answers — no stdin access, so this is
 * the part unit tests exercise directly.
 *
 * The schema (Tasks 9–13) requires a rest-kit connector to declare exactly one
 * env entry with auth: "bearer" and a single var — makeRestToolRegistrar
 * resolves the token itself. Only the "bearer" auth choice satisfies that
 * shape, so it alone maps to style: "rest-kit". "token" and "basic" both map
 * to style: "hand-rolled" with a single auth: "headers" env entry naming one
 * header, wired through fetchHelper.headers (the accessor's own `local`).
 *
 * Prompted tools are all impl: "stub" — the CLI cannot know a service's URL
 * paths, and emitting a stub the author fills in is honest where guessing a
 * path would not be.
 */
/** Parse a URL, throwing a message that names the offending field and value. */
function parseBaseUrl(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch {
    throw new Error(
      `Base API URL "${baseUrl}" is not a valid URL — include the scheme, ` +
        `e.g. https://api.example.com`,
    );
  }
}

export function buildSpec(answers: PromptAnswers): ConnectorSpec {
  const fetchLocal = `${answers.name.replaceAll("-", "")}Fetch`;
  const tools = answers.toolNames.map((name) => ({
    name,
    description: `TODO: describe ${name}.`,
    impl: "stub" as const,
  }));

  const shared = {
    name: answers.name,
    title: answers.displayName,
    displayName: answers.displayName,
    description: answers.description,
    serviceLabel: answers.serviceLabel,
    network: [parseBaseUrl(answers.baseUrl).host],
    tools,
  };

  if (answers.authKind === "bearer") {
    return parseSpec({
      ...shared,
      style: "rest-kit",
      env: [{ vars: [answers.envVar], local: "authHeaders", auth: "bearer" }],
      fetchHelper: { local: fetchLocal, base: answers.baseUrl },
    });
  }

  return parseSpec({
    ...shared,
    style: "hand-rolled",
    env: [
      {
        vars: [answers.envVar],
        local: "headers",
        auth: "headers",
        headerNames: [answers.headerName],
      },
    ],
    fetchHelper: { local: fetchLocal, base: answers.baseUrl, headers: "headers" },
  });
}

export function promptForSpec(seedName?: string): ConnectorSpec {
  const name = seedName ?? ask("Connector name (lower-kebab-case)");
  const displayName = ask("Display name", capitalize(name));
  const serviceLabel = ask("Service label used in error messages", displayName);
  const description = ask("Description", `${displayName} connector. Read-focused.`);
  const baseUrl = ask("Base API URL", `https://api.${name}.com`);
  const authKind = normalizeAuthKind(ask("Auth type (bearer | token | basic)", "bearer"));
  const envVar = ask("Credential env var", `${name.toUpperCase().replaceAll("-", "_")}_TOKEN`);
  const headerName = authKind === "bearer" ? "" : ask("Header name", "X-Api-Key");
  const toolCsv = ask("Read tool names (comma-separated)", `${name}_list`);

  const toolNames = toolCsv
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");

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
