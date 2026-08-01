import type { z } from "zod";
import type { ConnectorSpec, EnvSchema } from "../../spec.ts";

type EnvEntry = z.infer<typeof EnvSchema>;

const STRIP = String.raw`replace(/\/$/, "")`;

function camel(varName: string): string {
  const parts = varName.toLowerCase().split("_");
  return (
    parts[0]! +
    parts
      .slice(1)
      .map((p) => p[0]!.toUpperCase() + p.slice(1))
      .join("")
  );
}

function bindingOf(e: EnvEntry, i: number): string {
  return e.bindings?.[i] ?? camel(e.vars[i]!);
}

/** `<binding>.replace(...)` when a transform is set, else the bare binding. */
function transformed(e: EnvEntry, binding: string): string {
  return e.transform === "stripTrailingSlash" ? `${binding}.${STRIP}` : binding;
}

/** Wrap in a template literal only when a prefix or suffix exists. */
function wrapped(e: EnvEntry, expr: string): string {
  const hasAffix = e.prefix !== undefined || e.suffix !== undefined;
  if (!hasAffix) return expr;
  return `\`${e.prefix ?? ""}\${${expr}}${e.suffix ?? ""}\``;
}

function readLines(e: EnvEntry): string[] {
  return e.vars.map((v, i) => {
    const b = bindingOf(e, i);
    const read = `process.env[${JSON.stringify(v)}]?.trim()`;
    return e.default !== undefined
      ? `  const ${b} = ${read} || ${JSON.stringify(e.default)};`
      : `  const ${b} = ${read};`;
  });
}

function guardLines(e: EnvEntry): string[] {
  if (e.default !== undefined) return [];
  const needsGuard = e.required || e.auth !== undefined;
  if (!needsGuard) return [];
  const conds = e.vars
    .map((_, i) => {
      const b = bindingOf(e, i);
      return `${b} === undefined || ${b} === ""`;
    })
    .join(" || ");
  const message =
    e.vars.length === 1 ? `${e.vars[0]} is not set` : `${e.vars.join(" and ")} must be set`;
  return [`  if (${conds}) {`, `    throw new Error(${JSON.stringify(message)});`, `  }`];
}

function returnLines(e: EnvEntry): string[] {
  if (e.auth === "bearer") {
    const b = bindingOf(e, 0);
    return [`  return { Authorization: \`Bearer \${${b}}\`, Accept: "application/json" };`];
  }
  if (e.auth === "headers") {
    const entries = e.vars.map((_, i) => {
      const header = e.headerNames![i]!;
      return `    ${JSON.stringify(header)}: ${bindingOf(e, i)},`;
    });
    return ["  return {", ...entries, `    Accept: "application/json",`, "  };"];
  }
  return [`  return ${wrapped(e, transformed(e, bindingOf(e, 0)))};`];
}

/**
 * The token exchange, hoisted to module scope so `cachedToken` survives across calls.
 * Self-contained: it reads and guards its own two vars rather than sharing the accessor's
 * locals, because `token()` is called as `await token()` — no arguments — everywhere it is
 * used (the accessor below, and nowhere else). Cached for the process lifetime and never
 * refreshed, matching ramp and wiz. Correct only because connectors are spawned per
 * invocation and are short-lived — no connector in the corpus reads expires_in. A
 * long-lived connector would use a stale token.
 */
function renderTokenFunction(e: EnvEntry, serviceLabel: string): string {
  const idBinding = bindingOf(e, 0);
  const secretBinding = bindingOf(e, 1);
  const credentialsIn = e.credentialsIn!;

  // Built incrementally, not as an object literal: URLSearchParams stringifies its
  // values, so `{ scope: undefined }` would send the literal `scope=undefined` to the
  // token endpoint. The `set` lines are emitted only when the spec actually declares them.
  const bodyLines = [
    `  const body = new URLSearchParams({ grant_type: "client_credentials" });`,
    ...(e.scope === undefined ? [] : [`  body.set("scope", ${JSON.stringify(e.scope)});`]),
    ...(credentialsIn === "body"
      ? [`  body.set("client_id", ${idBinding});`, `  body.set("client_secret", ${secretBinding});`]
      : []),
  ];

  const headerLines =
    credentialsIn === "basic"
      ? [
          "    headers: {",
          '      "Content-Type": "application/x-www-form-urlencoded",',
          '      Accept: "application/json",',
          `      Authorization: encodeBasicAuthHeader(${idBinding}, ${secretBinding}),`,
          "    },",
        ]
      : [
          '    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },',
        ];

  // Built here rather than inline at its use site: nesting a template literal inside a
  // JSON.stringify() inside the emitted line's own template is unreadable three ways.
  const missingTokenMessage = JSON.stringify(`${serviceLabel} token response missing access_token`);

  return [
    "let cachedToken: string | null = null;",
    "",
    "async function token(): Promise<string> {",
    "  if (cachedToken !== null) return cachedToken;",
    ...readLines(e),
    ...guardLines(e),
    ...bodyLines,
    `  const res = await fetch(${JSON.stringify(e.tokenUrl)}, {`,
    '    method: "POST",',
    ...headerLines,
    "    body: body.toString(),",
    "  });",
    "  const text = await res.text();",
    "  if (!res.ok) {",
    `    throw new Error(\`${serviceLabel} token exchange \${String(res.status)}: \${text.slice(0, 400)}\`);`,
    "  }",
    "  const parsed = JSON.parse(text) as { access_token?: unknown };",
    '  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {',
    `    throw new Error(${missingTokenMessage});`,
    "  }",
    "  cachedToken = parsed.access_token;",
    "  return cachedToken;",
    "}",
  ].join("\n");
}

function renderClientCredentials(e: EnvEntry, serviceLabel: string): string {
  return [
    renderTokenFunction(e, serviceLabel),
    "",
    `async function ${e.local}(): Promise<Record<string, string>> {`,
    '  return { Authorization: `Bearer ${await token()}`, Accept: "application/json" };',
    "}",
  ].join("\n");
}

/**
 * `serviceLabel` is only read for the `auth: "client-credentials"` branch, where it names
 * the token-exchange error messages the same way `renderFetchHelper`'s error messages are
 * named. It defaults so every other call site — including every existing test — is
 * unaffected.
 */
export function renderEnvAccessor(e: EnvEntry, serviceLabel = "Connector"): string {
  if (e.auth === "client-credentials") {
    return renderClientCredentials(e, serviceLabel);
  }
  const returnType = e.auth === undefined ? "string" : "Record<string, string>";
  return [
    `function ${e.local}(): ${returnType} {`,
    ...readLines(e),
    ...guardLines(e),
    ...returnLines(e),
    "}",
  ].join("\n");
}

/** Renders every env accessor for a spec, in declaration order. */
export function renderEnvAccessors(spec: ConnectorSpec): string {
  return spec.env.map((e) => renderEnvAccessor(e, spec.serviceLabel)).join("\n\n");
}
