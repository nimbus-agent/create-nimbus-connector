import { describe, expect, it } from "bun:test";
import { generate } from "../../src/emit/index.ts";
import { listOperations, type Operation } from "../../src/openapi/document.ts";
import { mapOperation, type Refusal } from "../../src/openapi/operation.ts";
import { type Assembled, assembleSpec } from "../../src/openapi/spec.ts";
import { parseSpec } from "../../src/spec.ts";
import { RESERVED_IDENTIFIERS, validateSpec } from "../../src/validate.ts";
import { documentFor, onePath } from "../support/openapi-doc.ts";

/**
 * Every document here is SYNTHETIC — invented in this repository, not transcribed from any
 * published API. `documentFor` and `onePath` come from `test/support/openapi-doc.ts`, shared with
 * `operation.test.ts` rather than copied into it: Task 2's report named the copy as the wrong fix.
 *
 * The two assertions this file exists for are in "the assembled spec is a spec" and "notes reach
 * the output individually". Everything else is the refusal surface around them.
 */

/** An `http`/`bearer` scheme, which every case that is not about auth needs one of. */
const HTTP_BEARER = { type: "http", scheme: "bearer" };

const LIST_WIDGETS = { "/widgets": { get: { operationId: "listWidgets", summary: "List." } } };

/**
 * A document carrying a readable server and a readable security scheme, so a case that is about
 * neither does not have to restate both. `extra` is spread last, so a case that IS about one of
 * them replaces it — including with `undefined`, which `JSON.stringify` drops entirely.
 */
function assembleFor(
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Assembled {
  const doc = documentFor(paths, {
    components: { securitySchemes: { bearerAuth: HTTP_BEARER } },
    ...extra,
  });
  return assembleSpec(doc, listOperations(doc));
}

function mustAssemble(
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): { spec: Record<string, unknown>; notes: string[] } {
  const result = assembleFor(paths, extra);
  if (!result.ok) {
    const seen = result.refusals.map((r) => `${r.kind}: ${r.detail}`).join(" | ");
    throw new Error(`expected an assembled spec, got refusals: ${seen}`);
  }
  return { spec: result.spec, notes: result.notes };
}

function mustRefuse(
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Refusal[] {
  const result = assembleFor(paths, extra);
  if (result.ok) throw new Error(`expected refusals, assembled: ${JSON.stringify(result.spec)}`);
  return result.refusals;
}

function kindsOf(refusals: readonly Refusal[]): string[] {
  return refusals.map((r) => r.kind);
}

/** The detail of the one refusal of `kind`, so a message can be asserted on rather than a count. */
function detailOf(refusals: readonly Refusal[], kind: string): string {
  const hit = refusals.find((r) => r.kind === kind);
  if (hit === undefined) {
    throw new Error(`no "${kind}" refusal among [${kindsOf(refusals).join(", ")}]`);
  }
  return hit.detail;
}

function toolsOf(spec: Record<string, unknown>): Record<string, unknown>[] {
  return spec.tools as Record<string, unknown>[];
}

function firstTool(spec: Record<string, unknown>): Record<string, unknown> {
  const tool = toolsOf(spec)[0];
  if (tool === undefined) throw new Error("the assembled spec declares no tools");
  return tool;
}

/* ------------------------------------------------------------------------------------------ *
 * What the document supplies
 * ------------------------------------------------------------------------------------------ */

describe("the fields the document itself supplies", () => {
  it("slugifies info.title into the connector name", () => {
    const { spec } = mustAssemble(LIST_WIDGETS);
    expect(spec.name).toBe("zz-widgets");
  });

  // Leading AND trailing punctuation, because the trim is one regex with two alternations and a
  // title that only ends in a bracket would leave half of it unexercised.
  it("slugifies a title carrying punctuation the name regex forbids", () => {
    const { spec } = mustAssemble(LIST_WIDGETS, {
      info: { title: "(Acme, Inc.) API (v2)", version: "1.0.0" },
    });
    expect(spec.name).toBe("acme-inc-api-v2");
  });

  it("takes fetchHelper.base from the one server url, whole, and network from its host", () => {
    const { spec } = mustAssemble(LIST_WIDGETS);
    expect(spec.fetchHelper).toMatchObject({ base: "https://api.zzwidgets.test/v1" });
    expect(spec.network).toEqual(["api.zzwidgets.test"]);
  });

  it("drops a trailing slash from the base, which would otherwise double the path separator", () => {
    const { spec } = mustAssemble(LIST_WIDGETS, { servers: [{ url: "https://api.zz.test/v1/" }] });
    expect(spec.fetchHelper).toMatchObject({ base: "https://api.zz.test/v1" });
  });

  // The `+` in the strip is what this covers, and it had no test until the review found that
  // `replace(/\/$/, "")` failed nothing: one trailing slash is what `href` itself adds to a bare
  // origin, so a single-slash case cannot tell the two apart. Two is a thing only the document
  // can write, and one left behind emits "/v1//widgets".
  it("drops EVERY trailing slash, not just the one href adds to a bare origin", () => {
    const { spec } = mustAssemble(LIST_WIDGETS, { servers: [{ url: "https://api.zz.test/v1//" }] });
    expect(spec.fetchHelper).toMatchObject({ base: "https://api.zz.test/v1" });
  });

  it("keeps the port in the network entry, because a permission without it is a different host", () => {
    const { spec } = mustAssemble(LIST_WIDGETS, { servers: [{ url: "https://api.zz.test:8443" }] });
    expect(spec.network).toEqual(["api.zz.test:8443"]);
  });

  it("derives the fetch helper's local name from the connector name", () => {
    const { spec } = mustAssemble(LIST_WIDGETS);
    expect(spec.fetchHelper).toMatchObject({ local: "zzwidgetsFetch", headers: "authHeaders" });
  });
});

/* ------------------------------------------------------------------------------------------ *
 * Servers
 * ------------------------------------------------------------------------------------------ */

describe("the servers array, where four absences are four different refusals", () => {
  it("refuses a document that declares no servers at all", () => {
    expect(kindsOf(mustRefuse(LIST_WIDGETS, { servers: undefined }))).toEqual(["no-servers"]);
  });

  it("refuses an empty servers array, which is not the same fault as declaring none", () => {
    expect(kindsOf(mustRefuse(LIST_WIDGETS, { servers: [] }))).toEqual(["empty-servers"]);
  });

  it("refuses a first server that declares no url", () => {
    expect(kindsOf(mustRefuse(LIST_WIDGETS, { servers: [{ description: "prod" }] }))).toEqual([
      "server-url-missing",
    ]);
  });

  it("refuses a server url carrying OpenAPI server-variable templating", () => {
    const refusals = mustRefuse(LIST_WIDGETS, {
      servers: [
        {
          url: "https://{tenant}.api.example/v1",
          variables: { tenant: { default: "acme" } },
        },
      ],
    });
    expect(kindsOf(refusals)).toEqual(["server-url-templated"]);
    expect(detailOf(refusals, "server-url-templated")).toContain("{tenant}");
  });

  it("refuses the same templating with no variables block, since the braces are what break", () => {
    const refusals = mustRefuse(LIST_WIDGETS, {
      servers: [{ url: "https://{tenant}.api.example/v1" }],
    });
    expect(kindsOf(refusals)).toEqual(["server-url-templated"]);
  });

  // The distinction the brief draws: a placeholder stands in for a Nimbus convention the document
  // cannot express, where any value is provisional. A base URL is a fact the document is supposed
  // to carry, and inventing one points the connector at an endpoint nobody chose — while `network`
  // would then declare a host it never contacts.
  it("refuses more than one server rather than silently taking the first", () => {
    const refusals = mustRefuse(LIST_WIDGETS, {
      servers: [{ url: "https://api.zz.test/v1" }, { url: "https://eu.api.zz.test/v1" }],
    });
    expect(kindsOf(refusals)).toEqual(["multiple-servers"]);
    expect(detailOf(refusals, "multiple-servers")).toContain("https://eu.api.zz.test/v1");
  });

  it("says nothing about the first server's url when it could not choose a server", () => {
    // One cause, one refusal. Reporting "and the first one is templated too" invites fixing the
    // wrong thing: which server is meant is the question that has not been answered.
    const refusals = mustRefuse(LIST_WIDGETS, {
      servers: [{ url: "https://{tenant}.api.zz.test" }, { url: "https://eu.api.zz.test" }],
    });
    expect(kindsOf(refusals)).toEqual(["multiple-servers"]);
    expect(kindsOf(refusals)).not.toContain("server-url-templated");
  });

  it("refuses a relative server url, which carries no host for network to declare", () => {
    const refusals = mustRefuse(LIST_WIDGETS, { servers: [{ url: "/v1" }] });
    expect(kindsOf(refusals)).toEqual(["server-url-not-fetchable"]);
    expect(detailOf(refusals, "server-url-not-fetchable")).toContain("/v1");
  });

  // The refusal used to be predicated on "did `new URL()` throw", while its message claimed the
  // fact it protects — that there is no host for `network`. `mailto:` parses cleanly, so it
  // assembled and produced `"network": [""]`: the exact state the message described, without
  // firing. Same shape as `Bound.exclusive` -> `Bound.widened` one task ago, so the predicate is
  // now the claim: an http(s) URL with a host.
  it("refuses a scheme a generated fetch helper cannot issue, however cleanly it parses", () => {
    for (const url of ["mailto:a@b.test", "ftp://api.zz.test/v1", "file:///etc/hosts"]) {
      const refusals = mustRefuse(LIST_WIDGETS, { servers: [{ url }] });
      expect(kindsOf(refusals)).toEqual(["server-url-not-fetchable"]);
      expect(detailOf(refusals, "server-url-not-fetchable")).toContain("http(s)");
    }
  });

  // Assembled before this refusal existed, emitting `.../v1?trace=1/widgets` — the query string
  // swallows every tool path appended after it.
  it("refuses a base carrying a query string or a fragment, which a tool path lands after", () => {
    for (const [url, word] of [
      ["https://api.zz.test/v1?trace=1", "query string"],
      ["https://api.zz.test/v1#frag", "fragment"],
    ] as const) {
      const refusals = mustRefuse(LIST_WIDGETS, { servers: [{ url }] });
      expect(kindsOf(refusals)).toEqual(["server-url-not-a-base"]);
      expect(detailOf(refusals, "server-url-not-a-base")).toContain(word);
    }
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The server url as emitted source
 * ------------------------------------------------------------------------------------------ */

/**
 * `src/emit/server/fetch-helper.ts` splices `fetchHelper.base` RAW into a template literal, so a
 * document-supplied url is one backtick away from being executable code in the generated package.
 *
 * The reproduction that motivated these tests cleared every bar this repository states as the real
 * one: `parseSpec` accepted it (`FetchHelperSchema.base` is `z.string().min(1)`), the emitter
 * spliced it, **Biome reformatted it** — adding spaces around the `+` it had just created — and
 * `tsc --noEmit --strict` passed it clean. Nothing downstream can be the gate; this is.
 */
const INJECTION = "`+String(Date.now())+`";

/** The emitted `src/server.ts` for an assembled spec. `generate` is pure — no formatter needed. */
function emittedServer(spec: Record<string, unknown>): string {
  const file = generate(parseSpec(spec)).find((f) => f.path.join("/") === "src/server.ts");
  if (file === undefined) throw new Error("no src/server.ts was generated");
  return file.content;
}

describe("a server url cannot become code in the generated package", () => {
  /*
   * The fix has two halves, and this is the one that covers the reported reproduction. `new URL()`
   * percent-encodes a backtick in the PATH, so the base becomes `…/v1%60+String(Date.now())+%60`
   * — the injection is still every character the document wrote, and it is now DATA inside one
   * template literal rather than the end of it.
   *
   * The assertion is on the emitted source, not on the base string, because the base string is one
   * abstraction away from the harm. `not.toContain` on the opening sequence is what says the
   * literal is never closed; asserting the encoded text is present is what says nothing was
   * silently dropped instead.
   */
  it("neutralises the reported injection into data rather than dropping or refusing it", () => {
    const { spec } = mustAssemble(LIST_WIDGETS, {
      servers: [{ url: `https://api.zz.test/v1${INJECTION}` }],
    });
    expect(spec.fetchHelper).toMatchObject({
      base: "https://api.zz.test/v1%60+String(Date.now())+%60",
    });
    const server = emittedServer(spec);
    expect(server).toContain("https://api.zz.test/v1%60+String(Date.now())+%60");
    expect(server).not.toContain("`+String");
  });

  // The other half. The host is the one place `new URL()` does NOT encode a backtick — measured on
  // the pinned Bun 1.3.14, where it encodes one in the path as %60 and one in the fragment but
  // leaves the host alone — so normalization cannot be the whole fix and this refusal is the rest.
  it("refuses a backtick in the HOST, which url normalization does not encode", () => {
    const refusals = mustRefuse(LIST_WIDGETS, {
      servers: [{ url: "https://`a`.zz.test/v1" }],
    });
    expect(kindsOf(refusals)).toEqual(["server-url-unsafe"]);
    expect(detailOf(refusals, "server-url-unsafe")).toContain("backtick");
  });

  // Asserted here, under this heading, rather than left to the templating tests: `${` is refused
  // for TWO reasons and only one of them is about OpenAPI. A `${` reaching the emitted template
  // literal is a live interpolation, and the brace check is what stops it — by statement now
  // rather than by accident.
  it("refuses a ${ in a url, whose braces would interpolate rather than address", () => {
    const refusals = mustRefuse(LIST_WIDGETS, {
      servers: [{ url: "https://api.zz.test/v1${process.env.HOME}" }],
    });
    expect(kindsOf(refusals)).toEqual(["server-url-templated"]);
    expect(detailOf(refusals, "server-url-templated")).toContain("interpolation");
  });

  // The ordinary case, so the two rules above cannot pass by refusing or rewriting everything.
  it("leaves an ordinary server url untouched all the way into emitted source", () => {
    const { spec } = mustAssemble(LIST_WIDGETS);
    expect(emittedServer(spec)).toContain("`https://api.zzwidgets.test/v1${path}`");
  });
});

/* ------------------------------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------------------------------ */

function envOf(spec: Record<string, unknown>): Record<string, unknown> {
  const env = (spec.env as Record<string, unknown>[])[0];
  if (env === undefined) throw new Error("the assembled spec declares no env entry");
  return env;
}

function schemesExtra(schemes: Record<string, unknown>): Record<string, unknown> {
  return { components: { securitySchemes: schemes } };
}

describe("the env auth mode, read from components.securitySchemes", () => {
  it('maps type: http, scheme: bearer onto auth: "bearer"', () => {
    const { spec } = mustAssemble(LIST_WIDGETS, schemesExtra({ a: HTTP_BEARER }));
    expect(envOf(spec)).toStrictEqual({
      vars: ["ZZ_WIDGETS_TOKEN"],
      local: "authHeaders",
      auth: "bearer",
    });
  });

  it("reads a scheme name case-insensitively, as RFC 7235 defines it", () => {
    const { spec } = mustAssemble(
      LIST_WIDGETS,
      schemesExtra({ a: { type: "http", scheme: "Bearer" } }),
    );
    expect(envOf(spec)).toMatchObject({ auth: "bearer" });
  });

  it('maps type: http, scheme: basic onto auth: "basic" with the two vars EnvSchema demands', () => {
    const { spec } = mustAssemble(
      LIST_WIDGETS,
      schemesExtra({ a: { type: "http", scheme: "basic" } }),
    );
    expect(envOf(spec)).toStrictEqual({
      vars: ["ZZ_WIDGETS_USERNAME", "ZZ_WIDGETS_PASSWORD"],
      local: "authHeaders",
      auth: "basic",
    });
  });

  it('maps type: apiKey, in: header onto auth: "headers" carrying the document\'s header name', () => {
    const { spec } = mustAssemble(
      LIST_WIDGETS,
      schemesExtra({ a: { type: "apiKey", in: "header", name: "X-Widget-Key" } }),
    );
    expect(envOf(spec)).toStrictEqual({
      vars: ["ZZ_WIDGETS_API_KEY"],
      local: "authHeaders",
      auth: "headers",
      headerNames: ["X-Widget-Key"],
    });
  });

  it("refuses an oauth2 flow by name, because credentialsIn is not a fact the document carries", () => {
    const refusals = mustRefuse(
      LIST_WIDGETS,
      schemesExtra({
        a: {
          type: "oauth2",
          flows: { clientCredentials: { tokenUrl: "https://api.zz.test/token", scopes: {} } },
        },
      }),
    );
    expect(kindsOf(refusals)).toEqual(["security-scheme"]);
    expect(detailOf(refusals, "security-scheme")).toContain("credentialsIn");
  });

  it("refuses openIdConnect by name", () => {
    const refusals = mustRefuse(
      LIST_WIDGETS,
      schemesExtra({
        a: { type: "openIdConnect", openIdConnectUrl: "https://zz.test/.well-known" },
      }),
    );
    expect(kindsOf(refusals)).toEqual(["security-scheme"]);
    expect(detailOf(refusals, "security-scheme")).toContain("openIdConnect");
  });

  it("refuses mutualTLS by name", () => {
    const refusals = mustRefuse(LIST_WIDGETS, schemesExtra({ a: { type: "mutualTLS" } }));
    expect(kindsOf(refusals)).toEqual(["security-scheme"]);
    expect(detailOf(refusals, "security-scheme")).toContain("mutualTLS");
  });

  it("refuses an http scheme the spec language has no mode for", () => {
    const refusals = mustRefuse(
      LIST_WIDGETS,
      schemesExtra({ a: { type: "http", scheme: "digest" } }),
    );
    expect(kindsOf(refusals)).toEqual(["security-scheme"]);
    expect(detailOf(refusals, "security-scheme")).toContain("digest");
  });

  it("refuses an apiKey in query, which is a credential on the wire rather than a header", () => {
    const refusals = mustRefuse(
      LIST_WIDGETS,
      schemesExtra({ a: { type: "apiKey", in: "query", name: "api_key" } }),
    );
    expect(kindsOf(refusals)).toEqual(["security-scheme"]);
    expect(detailOf(refusals, "security-scheme")).toContain('in: "query"');
  });

  it("refuses an apiKey in cookie", () => {
    const refusals = mustRefuse(
      LIST_WIDGETS,
      schemesExtra({ a: { type: "apiKey", in: "cookie", name: "session" } }),
    );
    expect(kindsOf(refusals)).toEqual(["security-scheme"]);
    expect(detailOf(refusals, "security-scheme")).toContain('in: "cookie"');
  });

  it("refuses an apiKey scheme that names no header", () => {
    const refusals = mustRefuse(
      LIST_WIDGETS,
      schemesExtra({ a: { type: "apiKey", in: "header" } }),
    );
    expect(kindsOf(refusals)).toEqual(["security-scheme-shape"]);
  });

  it("refuses an http scheme that names no scheme", () => {
    const refusals = mustRefuse(LIST_WIDGETS, schemesExtra({ a: { type: "http" } }));
    expect(kindsOf(refusals)).toEqual(["security-scheme-shape"]);
  });

  it("refuses a security scheme that is not a security scheme object", () => {
    const refusals = mustRefuse(LIST_WIDGETS, schemesExtra({ a: "bearer" }));
    expect(kindsOf(refusals)).toEqual(["security-scheme-shape"]);
  });

  it("refuses a document declaring no security scheme, rather than emitting an anonymous connector", () => {
    expect(kindsOf(mustRefuse(LIST_WIDGETS, { components: undefined }))).toEqual([
      "no-security-scheme",
    ]);
  });

  it("refuses an empty securitySchemes object for the same reason", () => {
    expect(kindsOf(mustRefuse(LIST_WIDGETS, schemesExtra({})))).toEqual(["no-security-scheme"]);
  });

  it("refuses more than one security scheme rather than picking one", () => {
    const refusals = mustRefuse(
      LIST_WIDGETS,
      schemesExtra({
        bearerAuth: HTTP_BEARER,
        keyAuth: { type: "apiKey", in: "header", name: "K" },
      }),
    );
    expect(kindsOf(refusals)).toEqual(["multiple-security-schemes"]);
    expect(detailOf(refusals, "multiple-security-schemes")).toContain("keyAuth");
  });
});

/* ------------------------------------------------------------------------------------------ *
 * Placeholders
 * ------------------------------------------------------------------------------------------ */

describe("the placeholders, each of which stands for something no document states", () => {
  it('fills style with "hand-rolled", the only style whose env accessors this wiring emits', () => {
    const { spec } = mustAssemble(LIST_WIDGETS);
    expect(spec.style).toBe("hand-rolled");
  });

  it("states syncInterval and minNimbusVersion rather than leaving them to the schema default", () => {
    const { spec } = mustAssemble(LIST_WIDGETS);
    expect(spec.syncInterval).toBe(300);
    expect(spec.minNimbusVersion).toBe("0.2.0");
  });

  it("marks displayName, serviceLabel and the connector description TODO, since no document states them", () => {
    const { spec } = mustAssemble(LIST_WIDGETS);
    for (const field of ["displayName", "serviceLabel", "description"]) {
      expect(spec[field]).toMatch(/^TODO: /);
    }
  });

  it("keeps the document's title inside the displayName placeholder rather than discarding it", () => {
    const { spec } = mustAssemble(LIST_WIDGETS);
    expect(spec.displayName).toContain("ZZ Widgets");
  });

  /*
   * `serviceLabel` is the one placeholder that must not carry the title, and until the review
   * that was a claim in a docstring with nothing behind it.
   *
   * `src/emit/server/fetch-helper.ts` splices it RAW into a template literal and
   * `src/emit/wiring.ts` into a block comment, and — as the server-url Critical showed — there is
   * no backstop anywhere downstream: `parseSpec` takes any non-empty string, Biome reformats
   * whatever the emitter produced, and `tsc` typechecks it. It is safe today only because the
   * placeholder is a constant, so the test is that it IS one: byte-identical across two documents
   * whose titles differ, one of them hostile.
   */
  it("never lets the document's title reach serviceLabel, which is spliced into emitted source", () => {
    const hostile = mustAssemble(LIST_WIDGETS, {
      info: { title: `ZZ \`Widgets\` \${x} *${"/"} Co`, version: "1.0.0" },
    }).spec;
    expect(hostile.serviceLabel).toBe(mustAssemble(LIST_WIDGETS).spec.serviceLabel);
    expect(hostile.serviceLabel).not.toContain("`");
    expect(hostile.serviceLabel).not.toContain("${");
    // The title is not discarded, though — displayName and description reach the manifest through
    // JSON.stringify, where any text is data.
    expect(hostile.displayName).toContain("Widgets");
  });

  it("gives a tool with no summary the TODO: describe form src/prompts.ts already uses", () => {
    const { spec } = mustAssemble(onePath("/widgets", "get", { operationId: "listWidgets" }));
    expect(firstTool(spec).description).toBe("TODO: describe listWidgets.");
  });

  it("leaves a tool with a summary alone", () => {
    const { spec } = mustAssemble(LIST_WIDGETS);
    expect(firstTool(spec).description).toBe("List.");
  });

  // The assembled spec is printed for a human to edit, so its key order is part of the product.
  // A description merely appended when the document supplied none would land after `args`, and
  // the same connector would read differently depending on whether its operations had summaries.
  it("puts name and description first whether or not the document supplied a summary", () => {
    const withSummary = mustAssemble(LIST_WIDGETS).spec;
    const without = mustAssemble(onePath("/widgets", "get", { operationId: "listWidgets" })).spec;
    expect(Object.keys(firstTool(withSummary))).toEqual(["name", "description", "path", "args"]);
    expect(Object.keys(firstTool(without))).toEqual(Object.keys(firstTool(withSummary)));
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The notes
 * ------------------------------------------------------------------------------------------ */

/**
 * Transcribed from `applyBounds` in `src/openapi/operation.ts`, deliberately, rather than read off
 * `mapOperation` at run time.
 *
 * This is the note that makes a KNOWING divergence honest: the document says `> 5` and the emitted
 * schema says `>= 5`, because the spec language has only inclusive bounds. Task 2 chose to map and
 * note rather than refuse, on the grounds that refusing over an off-by-one costs more reach than
 * the looseness costs correctness — and the note is the entire honesty of that trade. Reading it
 * back out of `mapOperation` would make this assertion true of whatever text that function happens
 * to produce, including none; a literal pins the sentence a human has to see.
 */
const EXCLUSIVE_BOUND_NOTE =
  'TODO: parameter "limit" declares exclusiveMinimum, and the spec language\'s "min"/"max" are ' +
  "INCLUSIVE — the generated schema accepts the boundary value the document excludes. Move the " +
  "bound by one, or drop it.";

/** One operation whose every argument constraint is one the spec language cannot carry. */
const LOOSENED = onePath("/widgets", "get", {
  operationId: "listWidgets",
  summary: "List widgets.",
  parameters: [
    {
      name: "limit",
      in: "query",
      schema: { type: "integer", minimum: 5, exclusiveMinimum: true, format: "int32" },
    },
    { name: "page[size]", in: "query", schema: { type: "string", enum: ["small", "large"] } },
  ],
});

describe("the notes, which are the only record of what the generated tool does not enforce", () => {
  it("carries the exclusive-bound note into the tool description, verbatim", () => {
    const { spec } = mustAssemble(LOOSENED);
    expect(firstTool(spec).description).toContain(EXCLUSIVE_BOUND_NOTE);
  });

  it("keeps every note as its own line rather than summarising them into one TODO", () => {
    const doc = documentFor(LOOSENED, {
      components: { securitySchemes: { bearerAuth: HTTP_BEARER } },
    });
    const op = listOperations(doc)[0];
    if (op === undefined) throw new Error("the test document declares no operation");
    const mapped = mapOperation(op, doc);
    if (!mapped.ok) throw new Error("the test operation was refused");

    // Four notes, not one: the exclusive bound, the format, the slug rename and the enum. If any
    // of them were folded together, dropped or truncated, this equality is what fails.
    expect(mapped.mapped.notes.length).toBeGreaterThan(1);
    expect(mapped.mapped.notes).toContain(EXCLUSIVE_BOUND_NOTE);

    const { spec } = mustAssemble(LOOSENED);
    const description = firstTool(spec).description as string;
    expect(description.split("\n")).toEqual(["List widgets.", ...mapped.mapped.notes]);
  });

  it("appends the notes after the TODO: describe placeholder when the document supplies no summary", () => {
    const { spec } = mustAssemble(onePath("/widgets", "post", { operationId: "createWidget" }, {}));
    const description = firstTool(spec).description as string;
    expect(description.split("\n")[0]).toBe("TODO: describe createWidget.");
    expect(description).toContain('TODO: this POST is mapped with no "effect"');
  });

  it("reports every note to the caller as well, each naming the tool it came from", () => {
    const { notes } = mustAssemble(LOOSENED);
    expect(notes).toContain(`listWidgets: ${EXCLUSIVE_BOUND_NOTE}`);
  });

  it("reports no notes for an operation with nothing to say", () => {
    expect(mustAssemble(LIST_WIDGETS).notes).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------------------------------ */

describe("the assembled spec is a spec", () => {
  it("passes the real parseSpec and the real validateSpec", () => {
    const { spec } = mustAssemble(LOOSENED);
    const parsed = parseSpec(spec);
    validateSpec(parsed);
    expect(parsed.name).toBe("zz-widgets");
    expect(parsed.style).toBe("hand-rolled");
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]?.name).toBe("listWidgets");
    expect(parsed.fetchHelper.headers).toBe(parsed.env[0]?.local);
  });

  it("passes both for every auth mode, since each one builds a different env entry", () => {
    const schemes = [
      HTTP_BEARER,
      { type: "http", scheme: "basic" },
      { type: "apiKey", in: "header", name: "X-Widget-Key" },
    ];
    for (const scheme of schemes) {
      const { spec } = mustAssemble(LIST_WIDGETS, schemesExtra({ a: scheme }));
      expect(() => validateSpec(parseSpec(spec))).not.toThrow();
    }
  });

  it("passes both for a write tool, whose body mapping and method are a different emitted shape", () => {
    const { spec } = mustAssemble(
      onePath("/widgets", "post", {
        operationId: "createWidget",
        summary: "Create.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["display-name"],
                properties: { "display-name": { type: "string" }, archived: { type: "boolean" } },
              },
            },
          },
        },
      }),
    );
    const parsed = parseSpec(spec);
    validateSpec(parsed);
    expect(parsed.tools[0]?.method).toBe("POST");
    expect(parsed.tools[0]?.body).toEqual({ displayName: "display-name", archived: "archived" });
  });

  // The backstop, and it is not decoration: `validateSpec` claims every hoisted argument's local
  // into ONE module-scope map across all tools, so two operations that each declare a defaulted
  // `limit` collide — a rule no single-operation mapper can see, and one this file would otherwise
  // have to restate to catch.
  it("refuses rather than emitting a spec the generator's own identifier rules reject", () => {
    const limit = {
      name: "limit",
      in: "query",
      schema: { type: "integer", default: 20 },
    };
    const refusals = mustRefuse({
      "/widgets": { get: { operationId: "listWidgets", parameters: [limit] } },
      "/gadgets": { get: { operationId: "listGadgets", parameters: [limit] } },
    });
    expect(kindsOf(refusals)).toEqual(["spec-rejected"]);
    expect(detailOf(refusals, "spec-rejected")).toContain("Identifier collision");
    expect(detailOf(refusals, "spec-rejected")).toContain("limit");
  });
});

/* ------------------------------------------------------------------------------------------ *
 * What cannot be assembled
 * ------------------------------------------------------------------------------------------ */

describe("what cannot be assembled at all", () => {
  it("refuses a document with no mappable operation rather than emitting tools: []", () => {
    const refusals = mustRefuse({});
    expect(kindsOf(refusals)).toEqual(["no-operations"]);
  });

  it("reports every refusing operation, not the first", () => {
    const header = { name: "X-Trace", in: "header", schema: { type: "string" } };
    const refusals = mustRefuse({
      "/widgets": { get: { operationId: "listWidgets", parameters: [header] } },
      "/gadgets": { get: { operationId: "listGadgets", parameters: [header] } },
    });
    expect(kindsOf(refusals)).toEqual(["parameter-location", "parameter-location"]);
    expect(refusals.map((r) => r.detail).join(" ")).toContain("GET /gadgets");
  });

  it("reports a document-level refusal alongside the operations', not instead of them", () => {
    const refusals = mustRefuse(
      {
        "/widgets": {
          get: {
            operationId: "listWidgets",
            parameters: [{ name: "X-Trace", in: "header", schema: { type: "string" } }],
          },
        },
      },
      { servers: [] },
    );
    expect(kindsOf(refusals)).toEqual(["empty-servers", "parameter-location"]);
  });

  // Reachable from the CLI, not only from a hand-built list: `--op` is repeatable, so the same
  // operationId twice hands `assembleSpec` the same operation twice. `validateSpec` rejects the
  // duplicate tool name, and a refusal that names it is a better diagnosis than that rejection.
  it("refuses two selected operations that map onto one tool name", () => {
    const doc = documentFor(LIST_WIDGETS, {
      components: { securitySchemes: { bearerAuth: HTTP_BEARER } },
    });
    const op = listOperations(doc)[0];
    if (op === undefined) throw new Error("the test document declares no operation");
    const result = assembleSpec(doc, [op, op]);
    if (result.ok) throw new Error("expected refusals");
    expect(kindsOf(result.refusals)).toEqual(["duplicate-tool-name"]);
    expect(detailOf(result.refusals, "duplicate-tool-name")).toContain("listWidgets");
  });

  it("refuses a title that slugifies to nothing a connector name can hold", () => {
    const refusals = mustRefuse(LIST_WIDGETS, { info: { title: "!!!", version: "1.0.0" } });
    expect(kindsOf(refusals)).toEqual(["connector-name"]);
    expect(detailOf(refusals, "connector-name")).toContain("!!!");
  });

  // The security scheme is read whether or not the title produced a name, because nothing about
  // reading it depends on one — so two independent faults are two refusals. The fetch helper's
  // local is the opposite case and is deliberately NOT reported here: it is DERIVED from the name,
  // so a second refusal about it would describe a value this generator invented.
  it("reports a nameless title and a missing security scheme as the two faults they are", () => {
    const refusals = mustRefuse(LIST_WIDGETS, {
      info: { title: "!!!", version: "1.0.0" },
      components: undefined,
    });
    expect(kindsOf(refusals)).toEqual(["connector-name", "no-security-scheme"]);
  });

  it("refuses a title whose derived fetch-helper local is not a JS identifier", () => {
    const refusals = mustRefuse(LIST_WIDGETS, { info: { title: "42 Widgets", version: "1.0.0" } });
    expect(kindsOf(refusals)).toEqual(["derived-identifier"]);
    expect(detailOf(refusals, "derived-identifier")).toContain("42widgetsFetch");
  });

  // The reserved arm of that same check cannot be reached from any document today, because the
  // only identifiers this file derives are `<name>Fetch`, its `Send` sibling and the fixed
  // `authHeaders`. That is a property of RESERVED_IDENTIFIERS, not of the derivation, so it is
  // pinned here: if the list ever grows into that space, this fails and points at the derivation
  // rather than at a generated package that fails its own validateSpec.
  it("pins the invariant that keeps a derived local off RESERVED_IDENTIFIERS", () => {
    expect(RESERVED_IDENTIFIERS.filter((r) => r.endsWith("Fetch"))).toEqual([]);
    expect(RESERVED_IDENTIFIERS.filter((r) => r.endsWith("FetchSend"))).toEqual([]);
    expect(RESERVED_IDENTIFIERS).not.toContain("authHeaders");
  });

  it("names the operation in every refusal a mapped operation contributes", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        operationId: "listWidgets",
        parameters: [{ name: "X-Trace", in: "header", schema: { type: "string" } }],
      }),
    );
    expect(refusals).toHaveLength(1);
    for (const r of refusals) expect(r.detail).toContain("GET /widgets");
  });

  it("accepts a hand-built operation list, which is what the CLI hands it", () => {
    const doc = documentFor(LIST_WIDGETS, {
      components: { securitySchemes: { bearerAuth: HTTP_BEARER } },
    });
    const op: Operation = {
      operationId: "listWidgets",
      method: "GET",
      path: "/widgets",
      raw: { operationId: "listWidgets" },
      pathParameters: [],
    };
    const result = assembleSpec(doc, [op]);
    if (!result.ok) throw new Error("expected an assembled spec");
    expect(toolsOf(result.spec)).toHaveLength(1);
  });
});
