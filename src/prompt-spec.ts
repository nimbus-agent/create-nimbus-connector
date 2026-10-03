/**
 * The interactive questionnaire's answers, turned into a spec.
 *
 * Split out of src/prompts.ts for the reason src/cli-args.ts was split out of src/cli.ts. The
 * questionnaire is driven through the real binary in a subprocess, so src/prompts.ts is excluded
 * from the coverage metric — but this half reads no stdin: test/cli.test.ts calls `buildSpec`
 * directly, and while it lived in the excluded file the per-file floor never graded those tests.
 */

import { type ConnectorSpec, parseSpec } from "./spec.ts";

export type AuthKind = "bearer" | "token" | "basic";

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
