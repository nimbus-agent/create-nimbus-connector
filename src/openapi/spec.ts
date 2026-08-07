/**
 * A whole OpenAPI document plus a selection of its operations → one connector spec.
 *
 * `./document.ts` says what the document contains and `./operation.ts` says what one operation can
 * become; this is the third question — what a CONNECTOR needs that neither of those answers. The
 * spec language requires a name, a display name, a description, a service label, a style, an env
 * entry, a fetch helper and a network permission, and an OpenAPI document states four of those at
 * most. So every field below is one of exactly three things, and keeping them apart is the whole
 * design of this file:
 *
 * 1. **Read from the document** — `name` (slugified `info.title`), `fetchHelper.base` and
 *    `network` (`servers[0].url`), the env auth mode (`components.securitySchemes`), and every
 *    tool. A construct here that this generator cannot express is REFUSED by name; it is never
 *    guessed at, because a guess about the API produces a connector that talks to the wrong place.
 * 2. **A placeholder that parses** — `style`, `syncInterval`, `minNimbusVersion`, `displayName`,
 *    `serviceLabel`, the connector `description`, and a tool description the document leaves out.
 *    These stand in for Nimbus conventions no document states, where any value is provisional and
 *    the author is expected to set it, so they carry a `TODO:` marker wherever the field is prose.
 *    They live in `PLACEHOLDER`, in one place, so the set is readable at a glance.
 * 3. **Derived by this generator's own conventions** — the fetch helper's `local`, the env
 *    accessor's `local`, and the credential variable names, all following the shapes
 *    `src/prompts.ts` already produces for an interactively-authored connector.
 *
 * **The line between 1 and 2, which the four server refusals exist to hold.** A placeholder stands
 * in for something the document has no way to say. A base URL is a FACT about the API that an
 * OpenAPI document is supposed to carry: inventing one emits a spec pointing at an endpoint nobody
 * chose, and `network` would then declare a host the connector never contacts. So an absent
 * `servers`, an empty one, a first entry with no `url`, and a URL carrying OpenAPI server-variable
 * templating are four refusals with four names, not one placeholder.
 *
 * **Every note reaches the output individually.** `MappedTool.notes` is folded into that tool's
 * description, one note per line, and reported to the caller as well. One of those notes is the
 * only record that a generated tool's `min`/`max` is INCLUSIVE where the document's bound was
 * exclusive — Task 2 chose to map and note rather than refuse, and the note is the entire honesty
 * of that trade. Summarising the notes, truncating them, or replacing them with a single
 * "TODO: review" turns a knowing divergence into a silent one.
 *
 * **The refusal kinds**, each naming a construct rather than a symptom:
 *
 *   connector-name             an `info.title` that slugifies to nothing a `name` can hold
 *   derived-identifier         a derived local that is not a usable JS identifier
 *   no-servers                 no `servers` array at all
 *   empty-servers              `servers: []`
 *   multiple-servers           more than one server, so which base URL is meant is unanswered
 *   server-url-missing         a first server declaring no `url`
 *   server-url-templated       a server URL carrying OpenAPI server-variable templating
 *   server-url-not-absolute    a server URL with no origin to read a `network` host from
 *   no-security-scheme         no `components.securitySchemes` to read an auth mode from
 *   multiple-security-schemes  more than one scheme, so which credential is meant is unanswered
 *   security-scheme-shape      a scheme object missing the field its own `type` requires
 *   security-scheme            a scheme the spec language has no env auth mode for
 *   no-operations              nothing to turn into a tool
 *   duplicate-tool-name        two selected operations mapping onto one tool name
 *   spec-rejected              the assembled spec failed the real `parseSpec`/`validateSpec`
 *
 * plus every kind `mapOperation` contributes, unchanged and un-prefixed — those already name their
 * own operation.
 *
 * **`spec-rejected` is a backstop, and it is the reason this file restates almost nothing.** The
 * contract of this task is that what it produces passes the REAL `parseSpec` and `validateSpec`,
 * so it runs them, and a rejection becomes a refusal carrying the real message. That is not
 * belt-and-braces over the named checks above: `validateSpec` claims every hoisted argument's
 * local into ONE module-scope map across all tools, so two operations that each declare a
 * defaulted `limit` collide — a rule no single-operation mapper can see, and one this file would
 * otherwise have to restate (and drift from) to catch. The named refusals exist where a better
 * diagnosis than the schema's own is available; the backstop covers everything else, including
 * rules added to the spec language later.
 *
 * **What is deliberately NOT inferred.** `credentialsIn` — the design lists it as unfillable, and
 * an oauth2 `clientCredentials` flow carries a `tokenUrl` but says nothing about whether the
 * secret goes in a Basic header or in the body, which `EnvSchema` requires. `effect` — Task 2
 * notes each non-GET instead, because the corpus is emphatic that deriving HITL from the method is
 * wrong for a third of connectors. `title` — it reaches emitted identifiers through
 * `registrarName` and `src/emit/wiring.ts`, and `parseSpec` already defaults it from `name`.
 */
import { parseSpec } from "../spec.ts";
import { RESERVED_IDENTIFIERS, validateSpec } from "../validate.ts";
import type { Operation } from "./document.ts";
import { mapOperation, type Refusal } from "./operation.ts";
import { type OpenApiDocument, OpenApiSecuritySchemeSchema } from "./schema.ts";

export type Assembled =
  | { ok: true; spec: Record<string, unknown>; notes: string[] }
  | { ok: false; refusals: Refusal[] };

/**
 * Everything the spec language requires that an OpenAPI document has no way to state.
 *
 * One object rather than literals scattered through the assembly, so the set of things the
 * document cannot supply is readable at a glance — and so that adding a field to the spec language
 * that a document cannot fill has one obvious place to go.
 *
 * The `TODO:` marker is prose-only, and that is a constraint rather than a style choice.
 * `syncInterval` is a positive integer and `style` is an enum, so neither can carry one; they are
 * given a value that PARSES and is obviously provisional instead (and `syncInterval` /
 * `minNimbusVersion` are stated explicitly rather than left to the schema's default, so the author
 * sees them in the printed spec at all). `TODO: describe ${name}.` is `src/prompts.ts`'s exact
 * form, because a connector authored from a document and one authored interactively should leave
 * the same thing behind for their author to finish.
 *
 * `serviceLabel` takes no interpolation on purpose: `src/emit/server/fetch-helper.ts` splices it
 * RAW into an emitted template literal and `src/emit/wiring.ts` into a block comment, so a
 * document-supplied title carrying a backtick, a `${`, or the two characters that close a block
 * comment would land in generated source.
 * `displayName` and `description` reach `nimbus.extension.json` through `JSON.stringify`, where
 * any text is safe, which is why those two carry the document's title and this one does not.
 */
const PLACEHOLDER = {
  style: "hand-rolled",
  syncInterval: 300,
  minNimbusVersion: "0.2.0",
  serviceLabel: "TODO: set the label this connector prints in its error messages",
  displayName: (title: string) =>
    `TODO: set a display name. The document titles this API ${JSON.stringify(title)}.`,
  description: (title: string) => `TODO: describe this connector, generated from ${title}.`,
  toolDescription: (name: string) => `TODO: describe ${name}.`,
} as const;

/**
 * The credential variable names, following `src/prompts.ts`'s `${NAME}_TOKEN` convention.
 *
 * These are placeholders in the sense that no document states them — but they deliberately do NOT
 * carry a `TODO:` marker, because the marker's form is prose and an environment variable name
 * cannot hold a colon or a space. A name derived from the connector's own name is both valid and
 * the one a user would have chosen, so it is derived rather than mangled.
 */
const CREDENTIAL_SUFFIX = {
  bearer: "TOKEN",
  basicUser: "USERNAME",
  basicSecret: "PASSWORD",
  apiKey: "API_KEY",
} as const;

/** The env accessor's name. Fixed, matching `src/prompts.ts` and the grafana fixture. */
const ENV_LOCAL = "authHeaders";

/** The rule `identifierField()` enforces on every `local`, restated here to check against. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED = new Set(RESERVED_IDENTIFIERS);

/**
 * Everything one `assembleSpec` call accumulates.
 *
 * A shared sink rather than a return value per stage, for the reason `mapOperation`'s is: a
 * document with no servers AND an unmappable operation should name both in one run, rather than
 * turning into a sequence of one-at-a-time discoveries.
 */
type Collected = { readonly refusals: Refusal[]; readonly notes: string[] };

function refuse(c: Collected, kind: string, detail: string): undefined {
  c.refusals.push({ kind, detail });
  return undefined;
}

/* ------------------------------------------------------------------------------------------ *
 * The names derived from the document
 * ------------------------------------------------------------------------------------------ */

/**
 * `info.title` as a `ConnectorSpecSchema` name: lower-kebab-case, and nothing else.
 *
 * Emptiness is the ONLY way this can fail, which is why the result is tested for `""` rather than
 * against a restated copy of the schema's `/^[a-z0-9-]+$/`: every character that regex forbids is
 * either lower-cased or collapsed into a separator here, and the separators are then trimmed off
 * both ends. A title of `"!!!"` is the case that survives all of that with nothing left.
 */
function slugifyConnectorName(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/**
 * One derived module-scope name, or `undefined` once it has been refused.
 *
 * Two conditions, one refusal, because they are one question — "can the spec language hold this
 * name". `42 Widgets` slugifies to the perfectly valid connector name `42-widgets` and then to the
 * fetch helper local `42widgetsFetch`, which is not an identifier at all; refusing it here names
 * the title, where letting it through would produce a zod issue about `fetchHelper.local` that
 * says nothing about where the value came from.
 *
 * **The reserved arm cannot be reached from any document today**, and that is a property of
 * `RESERVED_IDENTIFIERS` rather than of this derivation: the only names derived here are
 * `<name>Fetch`, its `Send` sibling and the fixed `authHeaders`, and the list contains none of
 * those shapes. It is kept because that list grows — two waves of additions to it have been missed
 * on this project already — and `test/openapi/spec.test.ts` pins the invariant so a future entry
 * ending in `Fetch` fails there rather than in a generated package.
 */
function derivedIdentifier(candidate: string, owner: string, c: Collected): string | undefined {
  const problem = !IDENTIFIER.test(candidate)
    ? "is not a valid JS identifier, which every emitted module-scope name must be"
    : RESERVED.has(candidate)
      ? "is a name the emitter itself declares at module scope (RESERVED_IDENTIFIERS in " +
        "src/validate.ts)"
      : undefined;
  if (problem === undefined) return candidate;
  return refuse(
    c,
    "derived-identifier",
    `${owner} "${candidate}" ${problem}. Rename the document's info.title, or write the spec by ` +
      "hand.",
  );
}

/* ------------------------------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------------------------------ */

type Server = { readonly base: string; readonly host: string };

/**
 * The one server's URL, as a base for the fetch helper and a host for `network`.
 *
 * Four absences, four names — see this file's header for why none of them is a placeholder. The
 * multi-server arm returns without looking at any URL, deliberately: which server is meant is the
 * question that has not been answered, and adding "and the first one is templated too" invites
 * fixing the wrong one. Same shape as `readPathVariables` skipping the agreement check on a path
 * it could not read.
 *
 * The templating check tests for braces rather than for a `variables` block. The block is what a
 * correct document adds ALONGSIDE the templating, so requiring it would let
 * `https://{tenant}.api.example/v1` with no block through — and `fetchHelper.base` has no
 * equivalent of `parsePathTemplate`'s `FOREIGN_PLACEHOLDER` guard, so those braces would be
 * emitted as literal characters and the connector would request a host that does not exist.
 */
function readServer(doc: OpenApiDocument, c: Collected): Server | undefined {
  const servers = doc.servers;
  if (servers === undefined) {
    return refuse(
      c,
      "no-servers",
      'this document declares no "servers", so it does not say where the API is. Add one, or ' +
        "write the spec by hand.",
    );
  }
  if (servers.length === 0) {
    return refuse(
      c,
      "empty-servers",
      'this document declares "servers": [], so it names no base URL. An empty list is not the ' +
        "same as a default — OpenAPI's default is a server at `/`, which is relative to a host " +
        "this generator has no way to know.",
    );
  }
  if (servers.length > 1) {
    const urls = servers.map((s) => s.url ?? "(no url)").join(", ");
    return refuse(
      c,
      "multiple-servers",
      `this document declares ${servers.length} servers (${urls}). A connector has one base URL ` +
        "and one network permission, and taking the first would point it at an endpoint nobody " +
        "chose. Pass a document with one server, or write the spec by hand.",
    );
  }

  const url = servers[0]?.url;
  if (url === undefined) {
    return refuse(
      c,
      "server-url-missing",
      'the one server declares no "url", so the document names no base URL to fetch from.',
    );
  }
  if (/[{}]/.test(url)) {
    return refuse(
      c,
      "server-url-templated",
      `the server url "${url}" uses OpenAPI server-variable templating. A generated fetch helper ` +
        "does not expand it, so the braces would be sent as literal characters — substitute the " +
        "variables and pass the resulting URL.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse(
      c,
      "server-url-not-absolute",
      `the server url "${url}" is not an absolute URL. A relative server url is resolved against ` +
        "the document's own location, which a spec has no way to record, and there is no host to " +
        'put in "network".',
    );
  }
  // A trailing slash is dropped rather than noted: every tool path begins with "/" (the mapper
  // refuses one that does not), so keeping it would emit "https://api.test/v1//widgets", and the
  // two spellings of the base denote the same thing.
  return { base: url.replaceAll(/\/+$/g, ""), host: parsed.host };
}

/* ------------------------------------------------------------------------------------------ *
 * The credential
 * ------------------------------------------------------------------------------------------ */

/**
 * The auth mode read off a security scheme, WITHOUT the variable names it will be spelled with.
 *
 * Split from the env entry deliberately. The variable names need the connector name, which comes
 * from `info.title`, and a title that slugifies to nothing has no name to build them from — so a
 * `readCredential` that took the prefix could not run at all for such a document, and a document
 * with BOTH a nameless title and no security scheme would report only the first of its two
 * independent faults. Nothing about reading the scheme depends on the name, so nothing here does.
 */
type Credential = {
  readonly auth: "bearer" | "basic" | "headers";
  /** One `CREDENTIAL_SUFFIX` per variable, in the order `EnvSchema` reads them. */
  readonly suffixes: readonly string[];
  readonly headerNames?: readonly string[];
};

/**
 * The one security scheme as an auth mode, or `undefined` once it has been refused.
 *
 * `basic` carries TWO suffixes because `EnvSchema`'s own refine requires exactly two variables for
 * that mode — a username and a password. Refusing a scheme the spec language models natively would
 * be a gap in this mapper rather than a limit of the generator, which is the test applied to every
 * arm here.
 */
function readCredential(doc: OpenApiDocument, c: Collected): Credential | undefined {
  const declared = Object.entries(doc.components?.securitySchemes ?? {});
  if (declared.length === 0) {
    return refuse(
      c,
      "no-security-scheme",
      'this document declares no "components.securitySchemes", so it does not say how the API is ' +
        "authenticated. A connector with no credential would send anonymous requests to an API " +
        "that may well reject them, so the credential is read rather than assumed.",
    );
  }
  if (declared.length > 1) {
    return refuse(
      c,
      "multiple-security-schemes",
      `this document declares ${declared.length} security schemes ` +
        `(${declared.map(([n]) => n).join(", ")}). A connector carries one credential, and this ` +
        "reader does not read the document's `security` requirements to choose between them.",
    );
  }

  const [schemeName, raw] = declared[0] as [string, unknown];
  const parsed = OpenApiSecuritySchemeSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      c,
      "security-scheme-shape",
      `security scheme "${schemeName}" is not a security scheme object ` +
        `(${parsed.error.issues.map((i) => i.message).join("; ")}).`,
    );
  }
  const scheme = parsed.data;
  const where = `security scheme "${schemeName}"`;

  if (scheme.type === "http") return readHttpCredential(scheme, where, c);
  if (scheme.type === "apiKey") return readApiKeyCredential(scheme, where, c);
  return refuse(
    c,
    "security-scheme",
    `${where} is type "${scheme.type}", which has no env auth mode in the spec language. ` +
      (scheme.type === "oauth2"
        ? 'Even a clientCredentials flow, whose tokenUrl the document does carry, needs a "credentialsIn" — ' +
          "whether the client secret is sent as a Basic header or in the body — and " +
          "securitySchemes does not state it, so the entry could not be completed."
        : 'The spec language offers "bearer", "basic" and "headers"; write the env entry by hand.'),
  );
}

type SecurityScheme = { type: string; scheme?: string; in?: string; name?: string };

/**
 * `scheme` is lower-cased before it is matched: RFC 7235 defines an authentication scheme name as
 * case-insensitive, and real documents write both `bearer` and `Bearer`. Matching the raw text
 * would refuse a document that is correct.
 */
function readHttpCredential(
  scheme: SecurityScheme,
  where: string,
  c: Collected,
): Credential | undefined {
  if (scheme.scheme === undefined) {
    return refuse(
      c,
      "security-scheme-shape",
      `${where} is type "http" but names no "scheme", so which HTTP authentication scheme it ` +
        "means is unknown.",
    );
  }
  const named = scheme.scheme.toLowerCase();
  if (named === "bearer") {
    return { auth: "bearer", suffixes: [CREDENTIAL_SUFFIX.bearer] };
  }
  if (named === "basic") {
    return {
      auth: "basic",
      suffixes: [CREDENTIAL_SUFFIX.basicUser, CREDENTIAL_SUFFIX.basicSecret],
    };
  }
  return refuse(
    c,
    "security-scheme",
    `${where} is type "http" with scheme "${scheme.scheme}". The spec language's env auth modes ` +
      'cover "bearer" and "basic"; anything else is a header this generator does not build.',
  );
}

function readApiKeyCredential(
  scheme: SecurityScheme,
  where: string,
  c: Collected,
): Credential | undefined {
  if (scheme.in !== "header") {
    return refuse(
      c,
      "security-scheme",
      `${where} is an apiKey in: ${JSON.stringify(scheme.in ?? "(unstated)")}. A generated fetch ` +
        "helper puts the credential in a header and nowhere else — a key on the query string or " +
        "in a cookie is a different request, not a different spelling of this one.",
    );
  }
  if (scheme.name === undefined) {
    return refuse(
      c,
      "security-scheme-shape",
      `${where} is an apiKey in the header but names no "name", so the header it sets is unknown.`,
    );
  }
  return { auth: "headers", suffixes: [CREDENTIAL_SUFFIX.apiKey], headerNames: [scheme.name] };
}

/**
 * The `EnvSchema` entry itself, once both halves are in hand.
 *
 * `headerNames` is omitted rather than set to `undefined` on the modes that have none, and the
 * honest statement of why is narrow: **nothing rejects the other spelling.** `EnvSchema` declares
 * the field `.optional()`, so zod accepts an explicit `undefined`, and `JSON.stringify` drops the
 * key on the way to the printed spec either way. What the omission buys is that the object's own
 * key set is the one a hand-written spec would carry — which is only checkable by a strict
 * comparison, so `test/openapi/spec.test.ts` uses `toStrictEqual` on all three env entries rather
 * than leaving this as a claim with no gate.
 */
function envEntry(credential: Credential, prefix: string): Record<string, unknown> {
  return {
    vars: credential.suffixes.map((suffix) => `${prefix}_${suffix}`),
    local: ENV_LOCAL,
    auth: credential.auth,
    ...(credential.headerNames === undefined ? {} : { headerNames: credential.headerNames }),
  };
}

/* ------------------------------------------------------------------------------------------ *
 * The tools
 * ------------------------------------------------------------------------------------------ */

/**
 * The tool with its notes folded into its description, one per line.
 *
 * Rebuilt rather than mutated so that `name` and `description` sit in the same two positions
 * whether or not the document supplied a summary — a tool whose description was appended last
 * would read differently in the printed spec for no reason a user could see.
 *
 * `JSON.stringify` is what every emitter writes a description through
 * (`src/emit/server/tools-hand.ts` and its siblings), so a newline reaches generated source as
 * `\n` inside one string literal and no line breaks.
 */
function foldNotes(
  tool: Record<string, unknown>,
  notes: readonly string[],
): Record<string, unknown> {
  const name = String(tool.name);
  const supplied = tool.description;
  const base = typeof supplied === "string" ? supplied : PLACEHOLDER.toolDescription(name);
  const rest = Object.fromEntries(
    Object.entries(tool).filter(([key]) => key !== "name" && key !== "description"),
  );
  return { name: tool.name, description: [base, ...notes].join("\n"), ...rest };
}

/**
 * Every selected operation as a tool, in the order they were selected.
 *
 * A refusing operation contributes its refusals and no tool, and the loop continues — one run
 * names every operation standing in the way. The duplicate check is on the TOOL name rather than
 * on `operationId` because that is the name the spec carries and the one `validateSpec` rejects a
 * repeat of; it is reachable from the CLI rather than only from a hand-built list, since `--op` is
 * repeatable and naming one operation twice hands this function the same operation twice.
 */
function assembleTools(
  doc: OpenApiDocument,
  ops: readonly Operation[],
  c: Collected,
): Record<string, unknown>[] {
  if (ops.length === 0) {
    refuse(
      c,
      "no-operations",
      "no operation was selected, so there is nothing to turn into a tool. A connector with an " +
        "empty tool list registers nothing and is not worth generating — run --list-operations " +
        "and pass one or more --op.",
    );
    return [];
  }

  const tools: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    const mapped = mapOperation(op, doc);
    if (!mapped.ok) {
      c.refusals.push(...mapped.refusals);
      continue;
    }
    const name = String(mapped.mapped.tool.name);
    if (seen.has(name)) {
      refuse(
        c,
        "duplicate-tool-name",
        `two selected operations both map onto the tool name "${name}". Tool names are unique ` +
          "within a connector, so one of them would silently replace the other.",
      );
      continue;
    }
    seen.add(name);
    for (const note of mapped.mapped.notes) c.notes.push(`${name}: ${note}`);
    tools.push(foldNotes(mapped.mapped.tool, mapped.mapped.notes));
  }
  return tools;
}

/* ------------------------------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------------------------------ */

/**
 * A document and the operations selected from it, as a spec — or every reason it could not be one.
 *
 * The returned `spec` is the RAW object, before `parseSpec` applies its defaults and transforms,
 * because the caller prints it for a human to edit. It has nonetheless been through the real
 * `parseSpec` and `validateSpec` by the time it is returned: see `spec-rejected` in this file's
 * header for why that is the backstop rather than a courtesy.
 */
export function assembleSpec(doc: OpenApiDocument, ops: readonly Operation[]): Assembled {
  const c: Collected = { refusals: [], notes: [] };

  const title = doc.info.title;
  const slug = slugifyConnectorName(title);
  const name =
    slug === ""
      ? refuse(
          c,
          "connector-name",
          `info.title ${JSON.stringify(title)} has no letter or digit in it, so there is nothing ` +
            "to make a lower-kebab-case connector name from.",
        )
      : slug;
  // Skipped when the name itself was refused: the fetch helper's local is derived FROM the name,
  // so reporting it as well would be one cause producing two refusals, the second of which
  // describes a value this function invented.
  const local =
    name === undefined
      ? undefined
      : derivedIdentifier(`${name.replaceAll("-", "")}Fetch`, "the fetch helper's local name", c);
  const server = readServer(doc, c);
  // NOT skipped on a refused name, unlike the local above: reading the security scheme needs
  // nothing the name supplies (see `Credential`), so a document with a nameless title AND no
  // security scheme has two independent faults and reports both.
  const credential = readCredential(doc, c);
  const tools = assembleTools(doc, ops, c);

  // Each of the four pushes a refusal on its way out, so this narrowing can never return an empty
  // refusal list. The second check is what catches an operation-level refusal, where all four
  // document-level reads succeeded.
  if (
    name === undefined ||
    local === undefined ||
    server === undefined ||
    credential === undefined
  ) {
    return { ok: false, refusals: c.refusals };
  }
  if (c.refusals.length > 0) return { ok: false, refusals: c.refusals };

  const spec: Record<string, unknown> = {
    name,
    displayName: PLACEHOLDER.displayName(title),
    description: PLACEHOLDER.description(title),
    serviceLabel: PLACEHOLDER.serviceLabel,
    style: PLACEHOLDER.style,
    network: [server.host],
    syncInterval: PLACEHOLDER.syncInterval,
    minNimbusVersion: PLACEHOLDER.minNimbusVersion,
    env: [envEntry(credential, name.toUpperCase().replaceAll("-", "_"))],
    fetchHelper: { local, base: server.base, headers: ENV_LOCAL },
    tools,
  };

  try {
    validateSpec(parseSpec(spec));
  } catch (err) {
    refuse(c, "spec-rejected", err instanceof Error ? err.message : String(err));
    return { ok: false, refusals: c.refusals };
  }
  return { ok: true, spec, notes: c.notes };
}
