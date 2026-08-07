import type { z } from "zod";
import type { ConnectorSpec, EnvSchema } from "../../spec.ts";

type EnvEntry = z.infer<typeof EnvSchema>;

const STRIP = String.raw`replace(/\/$/, "")`;

/** A header name that needs no quotes as an object key. */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The shared trailing-slash helper, byte-identical in all 13 corpus connectors that use it
 * (airflow, argocd, dagster, databricks, dbt, dependencytrack, looker, metabase, mlflow,
 * prefect, superset, tableau, zendesk), hence a constant rather than a template. Emitted
 * once per connector however many accessors call it — see renderEnvAccessors.
 */
export const TRIM_TRAILING_SLASH_FN = [
  "function trimTrailingSlash(s: string): string {",
  '  return s.endsWith("/") ? s.slice(0, -1) : s;',
  "}",
].join("\n");

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

/** The transform applied to a binding, or the bare binding when none is set. */
function transformed(e: EnvEntry, binding: string): string {
  if (e.transform === "stripTrailingSlash") return `${binding}.${STRIP}`;
  if (e.transform === "trimTrailingSlashFn") return `trimTrailingSlash(${binding})`;
  return binding;
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
    // A key that is a valid identifier is emitted bare, the way `Authorization` and
    // `Accept` are written everywhere in the corpus; `"DD-API-KEY"` and `"x-auth-token"`
    // have to stay quoted.
    const field = (i: number) => {
      const header = e.headerNames![i]!;
      const key = IDENTIFIER_RE.test(header) ? header : JSON.stringify(header);
      return `${key}: ${bindingOf(e, i)}`;
    };
    // One custom header plus Accept fits on one line, and that is what every corpus
    // connector with a single header writes (bitrise's `{ Authorization: t, … }`,
    // `{ "x-api-key": k, … }`, `{ "X-Api-Key": k, … }`). Two or more expand — datadog,
    // intercom, snowflake — with no counterexample either way.
    if (e.vars.length === 1) {
      return [`  return { ${field(0)}, Accept: "application/json" };`];
    }
    const entries = e.vars.map((_, i) => `    ${field(i)},`);
    return ["  return {", ...entries, `    Accept: "application/json",`, "  };"];
  }
  return [`  return ${wrapped(e, transformed(e, bindingOf(e, 0)))};`];
}

/**
 * The token exchange, hoisted to module scope so `cachedToken` and `tokenExpiresAt` survive
 * across calls. Self-contained: it reads and guards its own two vars rather than sharing the
 * accessor's locals, because `token()` is called as `await token()` — no arguments —
 * everywhere it is used (the accessor below, and nowhere else).
 *
 * The cache is EXPIRY-AWARE, and that is the one place this deliberately departs from the
 * corpus. ramp and wiz cache for the process lifetime and never refresh, which is correct
 * only while a connector is spawned per invocation and is short-lived; a long-lived one
 * would keep using a stale token. So the emitted `token()` reads `expires_in` and renews a
 * little early — the skew halved for short-lived tokens, which would otherwise read as
 * already expired and be re-exchanged on every call.
 *
 * The corpus behaviour survives as the FALLBACK, not as the rule: a response carrying no
 * usable `expires_in` sets `tokenExpiresAt` to `Number.POSITIVE_INFINITY`, because treating
 * its absence as "expired" would re-exchange on every call instead.
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
    "let tokenExpiresAt = 0;",
    "",
    "async function token(): Promise<string> {",
    "  if (cachedToken !== null && Date.now() < tokenExpiresAt) return cachedToken;",
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
    "  const parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };",
    '  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {',
    `    throw new Error(${missingTokenMessage});`,
    "  }",
    "  cachedToken = parsed.access_token;",
    "  // Renew a little early so a token cannot expire mid-flight between this check and the",
    "  // request that uses it. The skew is halved for short-lived tokens, which would",
    "  // otherwise be treated as already expired and re-exchanged on every call.",
    '  const ttl = typeof parsed.expires_in === "number" && parsed.expires_in > 0',
    "    ? parsed.expires_in - Math.min(60, Math.floor(parsed.expires_in / 2))",
    "    : undefined;",
    "  tokenExpiresAt = ttl === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttl * 1000;",
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
 * HTTP Basic, the airflow/zendesk shape: each variable read and guarded on its own, with
 * its own message naming just that variable, then one multi-line header object.
 *
 * Deliberately NOT the combined `a === "" || b === ""` guard `guardLines` builds for
 * auth: "headers". A basic credential is two independently-supplied secrets — telling the
 * user "ZENDESK_EMAIL and ZENDESK_API_TOKEN must be set" when only one is missing is worse
 * diagnostics, and it is not what any of the four corpus connectors wrote.
 */
function renderBasic(e: EnvEntry): string {
  const readAndGuard = e.vars.flatMap((v, i) => {
    const b = bindingOf(e, i);
    // Built here rather than inline, for the reason renderTokenFunction's missingTokenMessage
    // is: a template literal nested inside a JSON.stringify() inside the emitted line's own
    // template is unreadable.
    const missingMessage = JSON.stringify(`${v} is not set`);
    return [
      `  const ${b} = process.env[${JSON.stringify(v)}]?.trim();`,
      `  if (${b} === undefined || ${b} === "") {`,
      `    throw new Error(${missingMessage});`,
      "  }",
    ];
  });
  // prefix/suffix decorate the username only — see EnvSchema's refine. `wrapped` returns
  // the bare binding when neither is set, which is airflow's form.
  const user = wrapped(e, bindingOf(e, 0));
  return [
    `function ${e.local}(): Record<string, string> {`,
    ...readAndGuard,
    "  return {",
    `    Authorization: encodeBasicAuthHeader(${user}, ${bindingOf(e, 1)}),`,
    '    Accept: "application/json",',
    "  };",
    "}",
  ].join("\n");
}

/**
 * The two-function form of a bearer accessor: a `(): string` reader named by `tokenLocal`
 * that carries the read and the guard, and `local` reduced to the header wrapper that calls
 * it. Nothing else changes — the reader's body is `readLines`/`guardLines` verbatim, so a
 * spec that adds `tokenLocal` to an existing entry only splits the code it already emitted.
 *
 * **12 corpus connectors** are byte-reproducible by `tokenLocal`: canva, figma, hubspot,
 * mercury, miro, netlify, raindrop, salesforce, stackoverflow, stripe, vercel, zoom.
 *
 * The criterion is stated here rather than left to the eye, because "splits the accessor in
 * two" is fuzzy and counting against it produced three wrong numbers in a row (once naming
 * testflight and dbt, which have no split at all; once naming 15 with three wrong members
 * and stripe missing). It is the text this function emits, and every clause of it is
 * hardcoded below, so anything a connector does differently is a byte the field cannot
 * produce:
 *
 *   1. a wrapper FUNCTION returning `Record<string, string>` — not an inline use of the
 *      reader at a call site (mendeley reads `Bearer ${accessToken()}` straight into the
 *      fetch helper's headers option, with no wrapper: OUT);
 *   2. whose entire body is one `return` of a ONE-LINE object literal;
 *   3. with exactly two keys, `Authorization` then `Accept: "application/json"` — a third
 *      header cannot be emitted (intercom adds `"Intercom-Version": "2.11"`: OUT);
 *   4. whose Authorization value is exactly `` `Bearer ${reader()}` `` — the literal
 *      `Bearer ` prefix (readwise writes `` `Token ${apiToken()}` ``: OUT) and a CALL to
 *      the reader, in a header (dagster passes `apiToken()` to a custom
 *      `"Dagster-Cloud-Api-Token"` header and pipedrive splices it into a query string:
 *      both OUT);
 *   5. plus a reader of that name matching `readLines` + `guardLines` for one required var.
 *
 * Counted mechanically over all 95 connector directories, not by eye; the script and its
 * output are in the task-10 report's fix-round-2 section.
 */
function renderSplitBearer(e: EnvEntry): string {
  const binding = bindingOf(e, 0);
  return [
    `function ${e.tokenLocal}(): string {`,
    ...readLines(e),
    ...guardLines(e),
    `  return ${binding};`,
    "}",
    "",
    `function ${e.local}(): Record<string, string> {`,
    `  return { Authorization: \`Bearer \${${e.tokenLocal}()}\`, Accept: "application/json" };`,
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
  if (e.auth === "basic") {
    return renderBasic(e);
  }
  // EnvSchema guarantees tokenLocal implies auth === "bearer".
  if (e.tokenLocal !== undefined) {
    return renderSplitBearer(e);
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

/**
 * Renders every env accessor for a spec, in declaration order, preceded by the shared
 * trailing-slash helper when any of them calls it. Emitted once however many accessors do
 * — two declarations of `trimTrailingSlash` in one module is a redeclaration error, and no
 * corpus connector emits it twice.
 */
export function renderEnvAccessors(spec: ConnectorSpec): string {
  const accessors = spec.env.map((e) => renderEnvAccessor(e, spec.serviceLabel));
  const needsTrim = spec.env.some((e) => e.transform === "trimTrailingSlashFn");
  return (needsTrim ? [TRIM_TRAILING_SLASH_FN, ...accessors] : accessors).join("\n\n");
}
