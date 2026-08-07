import { describe, expect, it } from "bun:test";
import { listOperations, loadDocument, type Operation } from "../../src/openapi/document.ts";
import {
  type MappedOperation,
  type MappedTool,
  mapOperation,
  type Refusal,
} from "../../src/openapi/operation.ts";
import type { OpenApiDocument } from "../../src/openapi/schema.ts";
import { parsePathTemplate, ToolSchema } from "../../src/spec.ts";
import { RESERVED_IDENTIFIERS } from "../../src/validate.ts";

/**
 * Every document below is SYNTHETIC — invented here, not transcribed from any published API.
 * `test/support/openapi-doc.ts` holds Task 1's shared constant; these are built per case instead,
 * because a mapper test's point is that its operation differs from a passing one by exactly the
 * construct under test. One shared constant with fifty variants hung off it would make each
 * case's difference the thing a reader has to reconstruct by hand.
 */
function documentFor(
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): OpenApiDocument {
  return loadDocument(
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "ZZ Widgets", version: "1.0.0" },
      servers: [{ url: "https://api.zzwidgets.test/v1" }],
      paths,
      ...extra,
    }),
  ).doc;
}

/**
 * One path item holding one operation, which is what almost every case below needs.
 *
 * The path item's own keys are spread FIRST so a `parameters` array sits ahead of the method
 * key, which is where a real document puts it — and Task 1 promises document order, so building
 * it the other way round would test a shape no document has.
 */
function onePath(
  path: string,
  method: string,
  operation: Record<string, unknown>,
  pathItem: Record<string, unknown> = {},
): Record<string, unknown> {
  return { [path]: { ...pathItem, [method]: { operationId: "op", ...operation } } };
}

function mapOne(
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): MappedOperation {
  const doc = documentFor(paths, extra);
  const op = listOperations(doc)[0];
  if (op === undefined) throw new Error("the test document declares no operation");
  return mapOperation(op, doc);
}

function mustMap(paths: Record<string, unknown>, extra: Record<string, unknown> = {}): MappedTool {
  const result = mapOne(paths, extra);
  if (!result.ok) {
    const seen = result.refusals.map((r) => `${r.kind}: ${r.detail}`).join(" | ");
    throw new Error(`expected a mapping, got refusals: ${seen}`);
  }
  return result.mapped;
}

function mustRefuse(
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Refusal[] {
  const result = mapOne(paths, extra);
  if (result.ok) throw new Error(`expected refusals, mapped: ${JSON.stringify(result.mapped)}`);
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

/** `tool.args` as a plain record, for the many cases that assert on it. */
function argsOf(mapped: MappedTool): Record<string, unknown> {
  return mapped.tool.args as Record<string, unknown>;
}

const PATH_STRING = { name: "widgetId", in: "path", required: true, schema: { type: "string" } };

describe("the path-item / operation parameter merge", () => {
  // The first three tests ARE this contract. Task 1 carries the path item's own `parameters` on
  // `Operation.pathParameters`, and nothing in this repository fails if a mapper never reads the
  // field — so a merge rule that is documented but untested is a merge rule that silently is not
  // implemented.
  it("inherits a path-level parameter into an operation that declares none", () => {
    const mapped = mustMap(
      onePath("/widgets/{widgetId}", "get", {}, { parameters: [PATH_STRING] }),
    );
    expect(argsOf(mapped)).toEqual({ widgetId: { type: "string" } });
    expect(mapped.tool.path).toBe("/widgets/${arg.widgetId|enc}");
  });

  it("lets an operation-level parameter override a path-level one, rather than declaring both", () => {
    const mapped = mustMap(
      onePath(
        "/widgets",
        "get",
        { parameters: [{ name: "limit", in: "query", schema: { type: "integer", maximum: 100 } }] },
        { parameters: [{ name: "limit", in: "query", schema: { type: "string" } }] },
      ),
    );
    // One argument, not two — and the OPERATION's declaration is the one that survived.
    expect(argsOf(mapped)).toEqual({
      limit: { type: "number", optional: true, max: 100, int: true },
    });
    expect(mapped.tool.query).toEqual([{ name: "limit", arg: "limit", omitWhen: "absent" }]);
  });

  it("matches on name AND in, so one name in two locations stays two parameters", () => {
    const refusals = mustRefuse(
      onePath(
        "/widgets/{widgetId}",
        "get",
        { parameters: [{ name: "widgetId", in: "query", schema: { type: "string" } }] },
        { parameters: [PATH_STRING] },
      ),
    );
    // Both parameters reach the argument map and collapse onto one name, which is a refusal.
    expect(kindsOf(refusals)).toEqual(["argument-name-collision"]);
    // Matching on `name` alone would have REPLACED the path-level declaration with the query
    // one, leaving `{widgetId}` in the template with nothing declaring it. That is a different
    // refusal, and its absence is what makes this test discriminate between the two rules.
    expect(kindsOf(refusals)).not.toContain("undeclared-path-parameter");
  });

  it("keeps the path item's parameters ahead of the operation's, because argument order is emitted order", () => {
    const mapped = mustMap(
      onePath(
        "/widgets",
        "get",
        { parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }] },
        { parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }] },
      ),
    );
    expect(Object.keys(argsOf(mapped))).toEqual(["limit", "cursor"]);
  });

  it("replaces an overridden parameter in place, so adding an override does not reorder the arguments", () => {
    const mapped = mustMap(
      onePath(
        "/widgets",
        "get",
        {
          parameters: [
            { name: "beta", in: "query", schema: { type: "integer" } },
            { name: "gamma", in: "query", schema: { type: "string" } },
          ],
        },
        {
          parameters: [
            { name: "alpha", in: "query", schema: { type: "string" } },
            { name: "beta", in: "query", schema: { type: "string" } },
          ],
        },
      ),
    );
    expect(Object.keys(argsOf(mapped))).toEqual(["alpha", "beta", "gamma"]);
    // `beta` kept the path item's POSITION and took the operation's TYPE.
    expect(argsOf(mapped).beta).toEqual({ type: "number", optional: true, int: true });
  });
});

describe("path", () => {
  it("rewrites every {name} into ${arg.name|enc}, keeping the literal segments", () => {
    const mapped = mustMap(
      onePath("/orgs/{orgId}/widgets/{widgetId}", "get", {
        parameters: [
          { name: "orgId", in: "path", required: true, schema: { type: "string" } },
          PATH_STRING,
        ],
      }),
    );
    expect(mapped.tool.path).toBe("/orgs/${arg.orgId|enc}/widgets/${arg.widgetId|enc}");
  });

  it("leaves a path with no template expression alone", () => {
    expect(mustMap(onePath("/widgets", "get", {})).tool.path).toBe("/widgets");
  });

  it("emits a path the real parsePathTemplate reads, which is the whole point of the rewrite", () => {
    const mapped = mustMap(onePath("/widgets/{widgetId}", "get", { parameters: [PATH_STRING] }));
    // src/emit/server/path-template.ts REJECTS a literal `{widgetId}` by name — its
    // FOREIGN_PLACEHOLDER check calls out OpenAPI's form specifically — so this assertion is
    // what proves the substitution is a bridge between two conventions rather than a rename.
    expect(parsePathTemplate(mapped.tool.path as string)).toEqual([
      { kind: "literal", text: "/widgets/" },
      { kind: "arg", name: "widgetId", mode: "enc" },
    ]);
  });

  it("reuses one argument for a variable that appears twice", () => {
    const mapped = mustMap(
      onePath("/widgets/{widgetId}/parent/{widgetId}", "get", { parameters: [PATH_STRING] }),
    );
    expect(Object.keys(argsOf(mapped))).toEqual(["widgetId"]);
    expect(mapped.tool.path).toBe("/widgets/${arg.widgetId|enc}/parent/${arg.widgetId|enc}");
  });
});

describe("method", () => {
  it("omits GET so ToolSchema's default applies", () => {
    expect(mustMap(onePath("/widgets", "get", {})).tool).not.toHaveProperty("method");
  });

  it("carries every other method through upper-cased", () => {
    for (const method of ["post", "put", "patch", "delete"]) {
      expect(mustMap(onePath("/widgets", method, {})).tool.method).toBe(method.toUpperCase());
    }
  });
});

describe("args", () => {
  it("maps the four scalar schema types the spec language has", () => {
    const mapped = mustMap(
      onePath("/widgets", "get", {
        parameters: [
          { name: "label", in: "query", required: true, schema: { type: "string" } },
          { name: "ratio", in: "query", required: true, schema: { type: "number" } },
          { name: "count", in: "query", required: true, schema: { type: "integer" } },
          { name: "flag", in: "query", required: true, schema: { type: "boolean" } },
        ],
      }),
    );
    expect(argsOf(mapped)).toEqual({
      label: { type: "string" },
      ratio: { type: "number" },
      count: { type: "number", int: true },
      flag: { type: "boolean" },
    });
  });

  it('declares "optional" for a parameter that is not required, and omits it for one that is', () => {
    const mapped = mustMap(
      onePath("/widgets", "get", {
        parameters: [
          { name: "needed", in: "query", required: true, schema: { type: "string" } },
          { name: "spare", in: "query", required: false, schema: { type: "string" } },
          { name: "unstated", in: "query", schema: { type: "string" } },
        ],
      }),
    );
    expect(argsOf(mapped)).toEqual({
      needed: { type: "string" },
      spare: { type: "string", optional: true },
      unstated: { type: "string", optional: true },
    });
  });

  it("carries minimum, maximum and default onto an optional numeric argument", () => {
    const mapped = mustMap(
      onePath("/widgets", "get", {
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        ],
      }),
    );
    expect(argsOf(mapped)).toEqual({
      limit: { type: "number", optional: true, default: 50, min: 1, max: 200, int: true },
    });
  });

  it("guards an optional query parameter with omitWhen, and an always-present one without", () => {
    const mapped = mustMap(
      onePath("/widgets", "get", {
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "org", in: "query", required: true, schema: { type: "string" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        ],
      }),
    );
    // Exactly ToolSchema's own rule: omitWhen is required when the value can genuinely be
    // undefined, and rejected when it cannot.
    expect(mapped.tool.query).toEqual([
      { name: "cursor", arg: "cursor", omitWhen: "absent" },
      { name: "org", arg: "org" },
      { name: "page", arg: "page" },
    ]);
  });

  it("declares no query at all when the operation has no query parameter", () => {
    const mapped = mustMap(onePath("/widgets/{widgetId}", "get", { parameters: [PATH_STRING] }));
    expect(mapped.tool).not.toHaveProperty("query");
  });
});

describe("request body", () => {
  /** A POST whose JSON body declares `properties` verbatim as given. */
  function postWithBody(
    properties: Record<string, unknown>,
    rest: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return onePath("/widgets", "post", {
      requestBody: {
        content: { "application/json": { schema: { type: "object", properties, ...rest } } },
      },
    });
  }

  it("keeps the document's property order, because argument order is emitted order", () => {
    const mapped = mustMap(postWithBody({ zebra: { type: "string" }, alpha: { type: "string" } }));
    // A zod object schema with DECLARED keys silently reorders its input to schema order, and
    // src/emit/server/args.ts iterates Object.entries(args) — so a reordering schema here would
    // change the emitted z.object({ … }) and JSON.stringify({ … }) field order alike.
    // Alphabetical is exactly what that failure looks like.
    expect(Object.keys(argsOf(mapped))).toEqual(["zebra", "alpha"]);
    expect(Object.keys(mapped.tool.body as object)).toEqual(["zebra", "alpha"]);
  });

  it("maps each argument back to the property name the API spells", () => {
    const mapped = mustMap(postWithBody({ "widget-name": { type: "string" } }));
    expect(argsOf(mapped)).toEqual({ widgetName: { type: "string", optional: true } });
    expect(mapped.tool.body).toEqual({ widgetName: "widget-name" });
  });

  it('reads the root "required" list to decide which properties are optional', () => {
    const mapped = mustMap(
      postWithBody({ name: { type: "string" }, note: { type: "string" } }, { required: ["name"] }),
    );
    expect(argsOf(mapped)).toEqual({
      name: { type: "string" },
      note: { type: "string", optional: true },
    });
  });

  it("puts body properties after the operation's parameters", () => {
    const mapped = mustMap(
      onePath("/widgets/{widgetId}", "post", {
        parameters: [PATH_STRING],
        requestBody: {
          content: { "application/json": { schema: { properties: { note: { type: "string" } } } } },
        },
      }),
    );
    expect(Object.keys(argsOf(mapped))).toEqual(["widgetId", "note"]);
    expect(mapped.tool.body).toEqual({ note: "note" });
  });

  it("accepts a +json suffix media type", () => {
    const mapped = mustMap(
      onePath("/widgets", "post", {
        requestBody: {
          content: {
            "application/merge-patch+json": {
              schema: { properties: { note: { type: "string" } } },
            },
          },
        },
      }),
    );
    expect(argsOf(mapped)).toEqual({ note: { type: "string", optional: true } });
  });

  it("accepts a media type carrying parameters, such as a charset", () => {
    const mapped = mustMap(
      onePath("/widgets", "post", {
        requestBody: {
          content: {
            "application/json; charset=utf-8": {
              schema: { properties: { note: { type: "string" } } },
            },
          },
        },
      }),
    );
    expect(argsOf(mapped)).toEqual({ note: { type: "string", optional: true } });
  });

  it("declares no body for a POST that declares no requestBody", () => {
    const mapped = mustMap(onePath("/widgets", "post", {}));
    expect(mapped.tool).not.toHaveProperty("body");
    expect(argsOf(mapped)).toEqual({});
  });
});

describe("argument names", () => {
  it("slugifies a name that is not a valid JS identifier, and says so in a note", () => {
    const mapped = mustMap(
      onePath("/widgets/{widget-id}", "get", {
        parameters: [{ name: "widget-id", in: "path", required: true, schema: { type: "string" } }],
      }),
    );
    expect(Object.keys(argsOf(mapped))).toEqual(["widgetId"]);
    expect(mapped.tool.path).toBe("/widgets/${arg.widgetId|enc}");
    expect(mapped.notes.join("\n")).toContain('"widget-id"');
  });

  it("keeps the API's spelling in the query entry, so the rename never reaches the wire", () => {
    const mapped = mustMap(
      onePath("/widgets", "get", {
        parameters: [{ name: "page[size]", in: "query", schema: { type: "integer" } }],
      }),
    );
    expect(Object.keys(argsOf(mapped))).toEqual(["pageSize"]);
    expect(mapped.tool.query).toEqual([
      { name: "page[size]", arg: "pageSize", omitWhen: "absent" },
    ]);
  });

  it("leaves a name that is already an identifier alone, and says nothing about it", () => {
    const mapped = mustMap(
      onePath("/widgets", "get", {
        parameters: [{ name: "widgetId", in: "query", schema: { type: "string" } }],
      }),
    );
    expect(Object.keys(argsOf(mapped))).toEqual(["widgetId"]);
    expect(mapped.notes.join("\n")).not.toContain("widgetId");
  });

  it("refuses two parameters that slugify onto one name rather than dropping one", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [
          { name: "widget-id", in: "query", schema: { type: "string" } },
          { name: "widget.id", in: "query", schema: { type: "string" } },
        ],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["argument-name-collision"]);
    expect(detailOf(refusals, "argument-name-collision")).toContain("widget.id");
    expect(detailOf(refusals, "argument-name-collision")).toContain("widget-id");
  });

  it("refuses a slug that lands on a name the document already spells as an identifier", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [
          { name: "widgetId", in: "query", schema: { type: "string" } },
          { name: "widget-id", in: "query", schema: { type: "string" } },
        ],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["argument-name-collision"]);
  });

  it("does not rename a name that is already an identifier, so two spellings stay two arguments", () => {
    // The brief offers `widget-id` and `widget_id` as a colliding pair. They only collide under a
    // slug rule that re-cases a name which is ALREADY a valid identifier — and that rule would
    // refuse a document this one maps, while renaming `widget_id` for no cause. The injectivity
    // rule it exists to demonstrate is proved by the two cases above instead.
    const mapped = mustMap(
      onePath("/widgets", "get", {
        parameters: [
          { name: "widget-id", in: "query", schema: { type: "string" } },
          { name: "widget_id", in: "query", schema: { type: "string" } },
        ],
      }),
    );
    expect(Object.keys(argsOf(mapped))).toEqual(["widgetId", "widget_id"]);
  });

  it("refuses a body property that collides with a parameter", () => {
    const refusals = mustRefuse(
      onePath("/widgets/{widgetId}", "post", {
        parameters: [PATH_STRING],
        requestBody: {
          content: {
            "application/json": { schema: { properties: { widgetId: { type: "string" } } } },
          },
        },
      }),
    );
    expect(kindsOf(refusals)).toEqual(["argument-name-collision"]);
  });

  it("refuses a name that slugifies onto a reserved emitter identifier", () => {
    // Not a name invented for this test: `url` is on the real list, with the reason written out
    // beside it in src/validate.ts.
    expect(RESERVED_IDENTIFIERS).toContain("url");
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [{ name: "url", in: "query", schema: { type: "string" } }],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["reserved-argument-name"]);
    expect(detailOf(refusals, "reserved-argument-name")).toContain("url");
  });

  it("refuses a name no slug can turn into an identifier", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [{ name: "2fa", in: "query", schema: { type: "string" } }],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["argument-name"]);
    expect(detailOf(refusals, "argument-name")).toContain("2fa");
  });
});

describe("refusals", () => {
  it("refuses a header parameter by name", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [{ name: "X-Request-Id", in: "header", schema: { type: "string" } }],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["parameter-location"]);
    expect(detailOf(refusals, "parameter-location")).toContain("header");
  });

  it("refuses a cookie parameter by name", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [{ name: "session", in: "cookie", schema: { type: "string" } }],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["parameter-location"]);
    expect(detailOf(refusals, "parameter-location")).toContain("cookie");
  });

  it("refuses a schema type the spec language has no equivalent for", () => {
    for (const type of ["array", "object"]) {
      const refusals = mustRefuse(
        onePath("/widgets", "get", {
          parameters: [{ name: "tags", in: "query", schema: { type } }],
        }),
      );
      expect(kindsOf(refusals)).toEqual(["schema-type"]);
      expect(detailOf(refusals, "schema-type")).toContain(type);
    }
  });

  it("refuses a parameter schema that declares no type at all", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", { parameters: [{ name: "anything", in: "query", schema: {} }] }),
    );
    expect(kindsOf(refusals)).toEqual(["schema-type"]);
  });

  it("refuses oneOf, anyOf and allOf in a parameter schema", () => {
    for (const keyword of ["oneOf", "anyOf", "allOf"]) {
      const refusals = mustRefuse(
        onePath("/widgets", "get", {
          parameters: [
            { name: "either", in: "query", schema: { [keyword]: [{ type: "string" }] } },
          ],
        }),
      );
      expect(kindsOf(refusals)).toEqual(["schema-composition"]);
      expect(detailOf(refusals, "schema-composition")).toContain(keyword);
    }
  });

  it("refuses allOf on a request body's root schema", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "post", {
        requestBody: {
          content: { "application/json": { schema: { allOf: [{ type: "object" }] } } },
        },
      }),
    );
    expect(kindsOf(refusals)).toEqual(["schema-composition"]);
  });

  it("refuses a nested request body by name", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "post", {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { spec: { type: "object", properties: { name: { type: "string" } } } },
              },
            },
          },
        },
      }),
    );
    expect(kindsOf(refusals)).toEqual(["nested-request-body"]);
    expect(detailOf(refusals, "nested-request-body")).toContain("spec");
  });

  it("refuses a request body offering no JSON media type, naming what it does offer", () => {
    for (const mediaType of [
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "text/plain",
    ]) {
      const refusals = mustRefuse(
        onePath("/widgets", "post", {
          requestBody: {
            content: { [mediaType]: { schema: { properties: { note: { type: "string" } } } } },
          },
        }),
      );
      expect(kindsOf(refusals)).toEqual(["media-type"]);
      expect(detailOf(refusals, "media-type")).toContain(mediaType);
    }
  });

  it("refuses a path templating form other than {name}", () => {
    for (const path of ["/widgets/{+widgetId}", "/widgets/{?a,b}", "/widgets/{}"]) {
      expect(kindsOf(mustRefuse(onePath(path, "get", {})))).toContain("path-templating");
    }
  });

  it("refuses a brace that closes nothing, rather than reading past it", () => {
    expect(kindsOf(mustRefuse(onePath("/widgets/{widgetId", "get", {})))).toEqual([
      "path-templating",
    ]);
  });

  it("refuses an Express-style :name segment, which is not OpenAPI templating at all", () => {
    expect(kindsOf(mustRefuse(onePath("/widgets/:widgetId", "get", {})))).toEqual([
      "path-templating",
    ]);
  });

  it("refuses a path already carrying this generator's own ${...} form", () => {
    expect(kindsOf(mustRefuse(onePath("/widgets/${arg.widgetId}", "get", {})))).toEqual([
      "path-templating",
    ]);
  });

  it("refuses a template variable nothing declares, rather than inventing a type for it", () => {
    const refusals = mustRefuse(onePath("/widgets/{widgetId}", "get", {}));
    expect(kindsOf(refusals)).toEqual(["undeclared-path-parameter"]);
    expect(detailOf(refusals, "undeclared-path-parameter")).toContain("widgetId");
  });

  it("refuses a path parameter the template never mentions, rather than declaring a dead argument", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [{ name: "widgetId", in: "path", required: true, schema: { type: "string" } }],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["unused-path-parameter"]);
  });

  it("refuses a GET carrying a request body, which the spec language cannot express", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        requestBody: {
          content: { "application/json": { schema: { properties: { q: { type: "string" } } } } },
        },
      }),
    );
    expect(kindsOf(refusals)).toEqual(["body-on-get"]);
  });

  it("refuses a request body that is not a flat object", () => {
    for (const schema of [
      { type: "array", items: { type: "string" } },
      { type: "string" },
      { type: "object" },
    ]) {
      const refusals = mustRefuse(
        onePath("/widgets", "post", {
          requestBody: { content: { "application/json": { schema } } },
        }),
      );
      expect(kindsOf(refusals)).toEqual(["request-body-shape"]);
    }
  });

  it("refuses a requestBody with no content, and one whose media type declares no schema", () => {
    expect(kindsOf(mustRefuse(onePath("/widgets", "post", { requestBody: {} })))).toEqual([
      "media-type",
    ]);
    expect(
      kindsOf(
        mustRefuse(
          onePath("/widgets", "post", { requestBody: { content: { "application/json": {} } } }),
        ),
      ),
    ).toEqual(["request-body-shape"]);
  });

  it("refuses a requestBody that is not an object at all", () => {
    expect(kindsOf(mustRefuse(onePath("/widgets", "post", { requestBody: "yes" })))).toEqual([
      "request-body-shape",
    ]);
  });

  it("refuses a request body schema whose modelled field carries the wrong type", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "post", {
        requestBody: {
          content: {
            "application/json": {
              // `required` on a schema node is a list of property names, never one name.
              schema: {
                type: "object",
                required: "note",
                properties: { note: { type: "string" } },
              },
            },
          },
        },
      }),
    );
    expect(kindsOf(refusals)).toEqual(["schema-shape"]);
  });

  it("refuses a body property name no slug can turn into an identifier", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "post", {
        requestBody: {
          content: {
            "application/json": { schema: { properties: { "2fa": { type: "string" } } } },
          },
        },
      }),
    );
    expect(kindsOf(refusals)).toEqual(["argument-name"]);
    expect(detailOf(refusals, "argument-name")).toContain("2fa");
  });

  it("refuses an array body property, and one that is an object only by its properties", () => {
    for (const schema of [
      { type: "array", items: { type: "string" } },
      { properties: { deeper: { type: "string" } } },
    ]) {
      const refusals = mustRefuse(
        onePath("/widgets", "post", {
          requestBody: {
            content: { "application/json": { schema: { properties: { tags: schema } } } },
          },
        }),
      );
      expect(kindsOf(refusals)).toEqual(["nested-request-body"]);
      expect(detailOf(refusals, "nested-request-body")).toContain("tags");
    }
  });

  it("refuses a parameter that declares no schema, and one that uses content instead", () => {
    expect(
      kindsOf(mustRefuse(onePath("/widgets", "get", { parameters: [{ name: "q", in: "query" }] }))),
    ).toEqual(["parameter-shape"]);
    const withContent = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [
          {
            name: "q",
            in: "query",
            content: { "application/json": { schema: { type: "string" } } },
          },
        ],
      }),
    );
    expect(kindsOf(withContent)).toEqual(["parameter-shape"]);
    expect(detailOf(withContent, "parameter-shape")).toContain("content");
  });

  it("refuses a parameter object that is not a parameter object", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", { parameters: ["not-a-parameter", { in: "query" }] }),
    );
    expect(kindsOf(refusals)).toEqual(["parameter-shape", "parameter-shape"]);
  });

  it('refuses an operation whose "parameters" is not an array', () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", { parameters: { widgetId: { in: "path" } } }),
    );
    expect(kindsOf(refusals)).toEqual(["parameter-shape"]);
  });

  it("refuses a default whose type does not match the argument's", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: "10" } }],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["schema-default"]);
    expect(detailOf(refusals, "schema-default")).toContain("10");
  });

  it("refuses a default that is neither a string, a number nor a boolean", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [{ name: "tags", in: "query", schema: { type: "string", default: null } }],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["schema-default"]);
  });

  it("refuses a schema node whose modelled field carries the wrong type", () => {
    const refusals = mustRefuse(
      onePath("/widgets", "get", {
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: "1" } }],
      }),
    );
    expect(kindsOf(refusals)).toEqual(["schema-shape"]);
  });

  it("refuses a malformed exclusive bound rather than shrugging where its sibling refuses", () => {
    // Modelled as `z.union([z.boolean(), z.number()])` — the two dialects and nothing else. Under
    // `z.unknown()` a string here was indistinguishable from ABSENT and was dropped in silence,
    // while `minimum: "1"` directly above earned a named refusal.
    for (const schema of [
      { type: "integer", exclusiveMinimum: "5" },
      { type: "integer", exclusiveMaximum: [5] },
    ]) {
      const refusals = mustRefuse(
        onePath("/widgets", "get", { parameters: [{ name: "limit", in: "query", schema }] }),
      );
      expect(kindsOf(refusals)).toEqual(["schema-shape"]);
    }
  });

  it("refuses a path that does not begin with a slash", () => {
    expect(kindsOf(mustRefuse({ widgets: { get: { operationId: "op" } } }))).toEqual([
      "path-not-absolute",
    ]);
  });

  it("says nothing about the path parameters of a path it could not read", () => {
    // An unreadable template names no variables, and reading that absence as "the template names
    // nothing" told the user that a correctly declared parameter was one "the path template never
    // names" — advice that deletes something right. Each case below declares `widgetId` properly.
    const declared = [{ name: "widgetId", in: "path", required: true, schema: { type: "string" } }];
    const cases: Record<string, string> = {
      "widgets/{widgetId}": "path-not-absolute",
      "/widgets/{+widgetId}": "path-templating",
      "/widgets/:widgetId": "path-templating",
      "/widgets/${arg.widgetId}": "path-templating",
      "/widgets/{widgetId": "path-templating",
    };
    for (const [path, kind] of Object.entries(cases)) {
      const refusals = mustRefuse(onePath(path, "get", { parameters: declared }));
      expect(kindsOf(refusals)).toEqual([kind]);
      expect(kindsOf(refusals)).not.toContain("unused-path-parameter");
    }
  });

  it("refuses an operation whose raw value is not an object", () => {
    // listOperations can never produce this — it parses each operation with
    // OpenApiOperationSchema first — but `Operation` is an exported type, so a hand-built one is
    // reachable, and a thrown TypeError here would not be a refusal.
    const op: Operation = {
      operationId: "op",
      method: "GET",
      path: "/widgets",
      raw: "not an object",
      pathParameters: [],
    };
    const result = mapOperation(op, documentFor(onePath("/widgets", "get", {})));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(kindsOf(result.refusals)).toEqual(["operation-shape"]);
  });
});

describe("reporting", () => {
  /** One operation with three independent problems, one per mapping stage. */
  const THREE_PROBLEMS = onePath("/widgets", "post", {
    parameters: [
      { name: "X-Request-Id", in: "header", schema: { type: "string" } },
      { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
    ],
    requestBody: {
      content: {
        "application/x-www-form-urlencoded": {
          schema: { properties: { note: { type: "string" } } },
        },
      },
    },
  });

  it("reports every refusal, not the first", () => {
    expect(kindsOf(mustRefuse(THREE_PROBLEMS))).toEqual([
      "parameter-location",
      "schema-type",
      "media-type",
    ]);
  });

  it("returns no tool at all when anything is refused — a partial map is never returned", () => {
    const result = mapOne(
      onePath("/widgets", "get", {
        parameters: [
          { name: "ok", in: "query", schema: { type: "string" } },
          { name: "bad", in: "header", schema: { type: "string" } },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("mapped");
  });

  it("names the operation in every refusal detail", () => {
    // Pointed at the three-refusal document deliberately. Against a one-refusal document the loop
    // body runs once, so the test would read as asserting a property of every refusal while
    // asserting it of one — the same "passes without checking what it says it checks" shape this
    // file is otherwise built against.
    const refusals = mustRefuse(THREE_PROBLEMS);
    expect(refusals).toHaveLength(3);
    for (const refusal of refusals) expect(refusal.detail).toContain("POST /widgets");
  });
});

describe("the tool", () => {
  it("names the tool after the operationId and describes it from the summary", () => {
    const mapped = mustMap(
      onePath("/widgets", "get", { operationId: "listWidgets", summary: "List widgets." }),
    );
    expect(mapped.tool.name).toBe("listWidgets");
    expect(mapped.tool.description).toBe("List widgets.");
  });

  it("leaves the description out when the operation has none, for Task 3 to fill", () => {
    expect(mustMap(onePath("/widgets", "get", {})).tool).not.toHaveProperty("description");
    expect(mustMap(onePath("/widgets", "get", { summary: "  " })).tool).not.toHaveProperty(
      "description",
    );
  });

  it("never declares an effect, which is a Nimbus convention the document cannot carry", () => {
    expect(mustMap(onePath("/widgets", "delete", {})).tool).not.toHaveProperty("effect");
  });
});

describe("the tool ToolSchema accepts", () => {
  /**
   * The contract one level below Task 3's "an assembled spec that does not parse is not a spec".
   * Every rule this mapper restates — omitWhen's three clauses, a `body` key naming a declared
   * arg, "body" requiring a non-GET method, a query tool's path beginning with "/" — is enforced
   * by `ToolSchema` itself, so running the real schema over the output is what proves the
   * restatements have not drifted from it.
   */
  function mustParse(paths: Record<string, unknown>): void {
    const parsed = ToolSchema.safeParse(mustMap(paths).tool);
    // Asserted as the issue LIST rather than as `success`, so a failure prints which rule the
    // mapped tool broke instead of `false !== true`.
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    expect(issues).toEqual([]);
  }

  it("accepts a GET with a path parameter, a guarded query parameter and an unguarded one", () => {
    mustParse(
      onePath("/widgets/{widgetId}", "get", {
        summary: "Fetch one widget.",
        parameters: [
          PATH_STRING,
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 25 } },
          { name: "org", in: "query", required: true, schema: { type: "string" } },
        ],
      }),
    );
  });

  it("accepts a POST carrying a path parameter, a query parameter and a body at once", () => {
    // The combination is where the schema's cross-field rules bite: "body" needs a non-GET
    // method, "query" needs a path beginning with "/", and every "body" key must name a declared
    // argument — which the slugified `display-name` only does through the body mapping.
    mustParse(
      onePath("/widgets/{widgetId}", "post", {
        summary: "Update one widget.",
        parameters: [
          PATH_STRING,
          { name: "dry-run", in: "query", schema: { type: "boolean" } },
          { name: "reason", in: "query", schema: { type: "string" } },
        ],
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
  });

  it("accepts a DELETE with nothing but a path parameter", () => {
    mustParse(
      onePath("/widgets/{widgetId}", "delete", {
        summary: "Delete one widget.",
        parameters: [PATH_STRING],
      }),
    );
  });
});

describe("notes", () => {
  function notesFor(paths: Record<string, unknown>): string {
    return mustMap(paths).notes.join("\n");
  }

  it("records an enum, which the spec language cannot express", () => {
    const notes = notesFor(
      onePath("/widgets", "get", {
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["open", "closed"] } },
        ],
      }),
    );
    expect(notes).toContain("open");
    expect(notes).toContain("closed");
  });

  it("records a format, which the spec language does not carry", () => {
    const notes = notesFor(
      onePath("/widgets", "get", {
        parameters: [
          { name: "since", in: "query", schema: { type: "string", format: "date-time" } },
        ],
      }),
    );
    expect(notes).toContain("date-time");
  });

  it("records that a non-GET operation is mapped with no effect declared", () => {
    expect(notesFor(onePath("/widgets", "delete", {}))).toContain("effect");
    expect(notesFor(onePath("/widgets", "get", {}))).toBe("");
  });

  it("records a default dropped from a boolean argument, which the generated hoist ignores", () => {
    const paths = onePath("/widgets", "get", {
      parameters: [{ name: "deep", in: "query", schema: { type: "boolean", default: false } }],
    });
    expect(notesFor(paths)).toContain("deep");
    expect(argsOf(mustMap(paths))).toEqual({ deep: { type: "boolean", optional: true } });
  });

  it("records a default dropped from a required argument, which can never reach it", () => {
    const paths = onePath("/widgets", "get", {
      parameters: [
        { name: "org", in: "query", required: true, schema: { type: "string", default: "acme" } },
      ],
    });
    expect(notesFor(paths)).toContain("org");
    expect(argsOf(mustMap(paths))).toEqual({ org: { type: "string" } });
  });

  it("does not read an exclusive bound as an inclusive one in silence", () => {
    // OpenAPI 3.0: `minimum` + the BOOLEAN exclusiveMinimum. The document says > 5; the spec
    // language's "min" says >= 5, so the generated tool would accept a 5 the API rejects.
    const three = onePath("/widgets", "get", {
      parameters: [
        {
          name: "count",
          in: "query",
          schema: { type: "integer", minimum: 5, exclusiveMinimum: true },
        },
      ],
    });
    expect(argsOf(mustMap(three))).toEqual({
      count: { type: "number", optional: true, min: 5, int: true },
    });
    expect(notesFor(three)).toContain("exclusiveMinimum");
  });

  it("reads OpenAPI 3.1's numeric exclusive bounds, which are a different keyword shape", () => {
    // 3.1 spells `> 5` as the NUMBER exclusiveMinimum: 5, with no `minimum` at all —
    // assertSupportedVersion accepts any 3.x, so both dialects reach the mapper.
    const paths = onePath("/widgets", "get", {
      parameters: [
        {
          name: "count",
          in: "query",
          schema: { type: "number", exclusiveMinimum: 5, exclusiveMaximum: 20 },
        },
      ],
    });
    expect(argsOf(mustMap(paths))).toEqual({
      count: { type: "number", optional: true, min: 5, max: 20 },
    });
    const notes = notesFor(paths);
    expect(notes).toContain("exclusiveMinimum");
    expect(notes).toContain("exclusiveMaximum");
  });

  it("takes the tighter of a numeric exclusive bound and an inclusive one, per JSON Schema", () => {
    const paths = onePath("/widgets", "get", {
      parameters: [
        {
          name: "count",
          in: "query",
          schema: {
            type: "integer",
            minimum: 3,
            exclusiveMinimum: 5,
            maximum: 90,
            exclusiveMaximum: 40,
          },
        },
      ],
    });
    // Every keyword in a schema must hold, so the effective range is (5, 40).
    expect(argsOf(mustMap(paths))).toEqual({
      count: { type: "number", optional: true, min: 5, max: 40, int: true },
    });
    // The exclusive side won at both ends, so both are reported as widened.
    expect(notesFor(paths)).toContain("exclusiveMinimum and exclusiveMaximum");
  });

  it("says nothing when the INCLUSIVE side is the binding one, because nothing was widened", () => {
    // The mirror of the case above, and the one the first version got wrong: `x >= 10` already
    // implies `x > 5`, and `x <= 10` already implies `x < 20`, so `min(10).max(10)` is EXACT and a
    // note claiming the schema accepts a boundary value the document excludes would be false about
    // this document — inside the code added to fix a note that was false about a document.
    const paths = onePath("/widgets", "get", {
      parameters: [
        {
          name: "count",
          in: "query",
          schema: {
            type: "integer",
            minimum: 10,
            exclusiveMinimum: 5,
            maximum: 10,
            exclusiveMaximum: 20,
          },
        },
      ],
    });
    expect(argsOf(mustMap(paths))).toEqual({
      count: { type: "number", optional: true, min: 10, max: 10, int: true },
    });
    expect(notesFor(paths)).toBe("");
  });

  it("treats an equal exclusive bound as binding, since >= n and > n together are > n", () => {
    const paths = onePath("/widgets", "get", {
      parameters: [
        {
          name: "count",
          in: "query",
          schema: { type: "integer", minimum: 5, exclusiveMinimum: 5 },
        },
      ],
    });
    expect(argsOf(mustMap(paths))).toEqual({
      count: { type: "number", optional: true, min: 5, int: true },
    });
    expect(notesFor(paths)).toContain("exclusiveMinimum");
  });

  it("says nothing about a 3.0 exclusive flag with no minimum beside it to modify", () => {
    // `exclusiveMinimum: true` MODIFIES `minimum`; with none there it bounds nothing, so there is
    // no bound to emit and nothing widened to report.
    const paths = onePath("/widgets", "get", {
      parameters: [
        { name: "count", in: "query", schema: { type: "integer", exclusiveMinimum: true } },
      ],
    });
    expect(argsOf(mustMap(paths))).toEqual({
      count: { type: "number", optional: true, int: true },
    });
    expect(notesFor(paths)).toBe("");
  });

  it("still says nothing about that dangling flag when the OTHER end declares a real bound", () => {
    // The case the test above cannot reach, found by a RED mutation that produced ZERO failures.
    // With no bound at either end `applyBounds` returns before the note is considered at all, so
    // that test passes whatever `widened` says. A bound at the other end gets past the early
    // return — and a `widened` set from mere keyword presence then reports the widening of a lower
    // bound this document does not have.
    const paths = onePath("/widgets", "get", {
      parameters: [
        {
          name: "count",
          in: "query",
          schema: { type: "integer", exclusiveMinimum: true, maximum: 10 },
        },
      ],
    });
    expect(argsOf(mustMap(paths))).toEqual({
      count: { type: "number", optional: true, max: 10, int: true },
    });
    expect(notesFor(paths)).toBe("");
  });

  it("records the constraint keywords the spec language cannot carry", () => {
    const notes = notesFor(
      onePath("/widgets", "get", {
        parameters: [
          {
            name: "slug",
            in: "query",
            schema: { type: "string", pattern: "^[a-z]+$", minLength: 2, maxLength: 40 },
          },
        ],
      }),
    );
    for (const keyword of ["pattern", "minLength", "maxLength"]) {
      expect(notes).toContain(keyword);
    }
  });

  it("says outright that a readOnly body property cannot be sent", () => {
    const notes = notesFor(
      onePath("/widgets", "post", {
        requestBody: {
          content: {
            "application/json": {
              schema: { properties: { id: { type: "string", readOnly: true } } },
            },
          },
        },
      }),
    );
    expect(notes).toContain("readOnly");
    expect(notes).toContain("rejects it on a write");
  });

  it("records minimum/maximum dropped from a non-numeric argument", () => {
    const paths = onePath("/widgets", "get", {
      parameters: [{ name: "name", in: "query", schema: { type: "string", minimum: 3 } }],
    });
    expect(notesFor(paths)).toContain("name");
    expect(argsOf(mustMap(paths))).toEqual({ name: { type: "string", optional: true } });
  });

  it("records a path parameter the document forgot to mark required", () => {
    const mapped = mustMap(
      onePath("/widgets/{widgetId}", "get", {
        parameters: [{ name: "widgetId", in: "path", schema: { type: "string" } }],
      }),
    );
    // Mapped as required regardless: encodeURIComponent(string | undefined) does not typecheck,
    // and the URL cannot be built without a value.
    expect(argsOf(mapped)).toEqual({ widgetId: { type: "string" } });
    expect(mapped.notes.join("\n")).toContain("widgetId");
  });

  it("says nothing about an operation with nothing to say", () => {
    const mapped = mustMap(onePath("/widgets/{widgetId}", "get", { parameters: [PATH_STRING] }));
    expect(mapped.notes).toEqual([]);
  });
});

describe("resolved references", () => {
  it("maps a parameter reached through a $ref, which loadDocument has already resolved", () => {
    const mapped = mustMap(
      onePath("/widgets/{widgetId}", "get", {
        parameters: [{ $ref: "#/components/parameters/WidgetId" }],
      }),
      {
        components: {
          parameters: {
            WidgetId: { name: "widgetId", in: "path", required: true, schema: { type: "string" } },
          },
        },
      },
    );
    expect(argsOf(mapped)).toEqual({ widgetId: { type: "string" } });
  });
});
