import { describe, expect, it } from "bun:test";
import {
  listOperations,
  listSkippedOperations,
  loadDocument,
  resolveRefs,
} from "../../src/openapi/document.ts";
import { ZZ_WIDGETS_YAML } from "../support/openapi-doc.ts";

/**
 * The shared synthetic document — see `test/support/openapi-doc.ts` for what each field is for
 * and why it lives there rather than in this file.
 *
 * Nothing below adds a `$ref` or an alias to this constant. Each case builds its own variant with
 * `withRef` or a local `.replace`, so every refusal differs from the passing document by exactly
 * the construct under test — which is what makes the `not.toBe(YAML_DOC)` corruption proofs
 * meaningful.
 */
const YAML_DOC = ZZ_WIDGETS_YAML;

/** The same document as JSON, written out by hand so the two are independently readable. */
const JSON_DOC = JSON.stringify(
  {
    openapi: "3.0.3",
    info: { title: "ZZ Widgets", version: "1.0.0" },
    servers: [{ url: "https://api.zzwidgets.test/v1" }],
    paths: {
      "/widgets": {
        get: { operationId: "listWidgets", summary: "List widgets." },
        post: { operationId: "createWidget", summary: "Create a widget." },
      },
      "/widgets/{widgetId}": {
        get: { operationId: "getWidget", summary: "Fetch one widget." },
      },
    },
  },
  null,
  2,
);

/**
 * YAML_DOC with a `$ref` hung off the last operation's request body and a `components.schemas`
 * block behind it.
 *
 * `refScalar` is the raw YAML scalar rather than a string, because one of the cases under test
 * is a `$ref` whose value is not a string at all — quoting it here would make that case
 * unwritable.
 */
function withRef(refScalar: string, schemaLines: readonly string[]): string {
  return [
    YAML_DOC.trimEnd(),
    "      requestBody:",
    "        content:",
    "          application/json:",
    "            schema:",
    `              $ref: ${refScalar}`,
    "components:",
    "  schemas:",
    ...schemaLines,
    "",
  ].join("\n");
}

/** The plain `Widget` schema — no reference of its own, so it resolves and stops. */
const WIDGET_SCHEMA = [
  "    Widget:",
  "      type: object",
  "      properties:",
  "        name:",
  "          type: string",
];

/** `Widget` referring back to itself: the cycle `resolveRefs` must refuse rather than recurse. */
const CIRCULAR_WIDGET_SCHEMA = [
  "    Widget:",
  "      type: object",
  "      properties:",
  "        parent:",
  '          $ref: "#/components/schemas/Widget"',
];

/** The resolved request-body schema of the operation `withRef` hangs its reference off. */
function bodySchemaOf(doc: unknown): unknown {
  const paths = (doc as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths;
  const op = paths["/widgets/{widgetId}"]?.["get"];
  const body = op?.["requestBody"] as { content: Record<string, { schema: unknown }> } | undefined;
  return body?.content["application/json"]?.schema;
}

describe("loadDocument", () => {
  it("reports source: yaml for a YAML document", () => {
    expect(loadDocument(YAML_DOC).source).toBe("yaml");
  });

  it("reports source: json for the same document as JSON", () => {
    expect(loadDocument(JSON_DOC).source).toBe("json");
  });

  it("reads the same document either way", () => {
    // JSON is also valid YAML, so `source` is the only thing that may differ. If the two
    // disagreed on anything else, one of the two readers would be silently lossy.
    expect(loadDocument(JSON_DOC).doc).toEqual(loadDocument(YAML_DOC).doc);
  });

  it("models info.title, servers[].url and the openapi version", () => {
    const { doc } = loadDocument(YAML_DOC);
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.info.title).toBe("ZZ Widgets");
    expect(doc.servers?.[0]?.url).toBe("https://api.zzwidgets.test/v1");
  });

  // Bun.YAML.parse returns an ARRAY for a multi-document stream — verified against the pinned
  // 1.3.14. Taking the first document silently would read half of a two-API file and report
  // success.
  it("refuses a multi-document YAML stream by name rather than taking the first document", () => {
    const stream = `${YAML_DOC}---\nopenapi: 3.0.3\ninfo:\n  title: Other\n  version: 1.0.0\n`;
    expect(stream).not.toBe(YAML_DOC);
    expect(() => loadDocument(stream)).toThrow(/multi-document/);
  });

  it("refuses text that is neither JSON nor YAML by name", () => {
    const bad = "a: [1, 2\n  b: :";
    expect(bad).not.toBe(YAML_DOC);
    expect(() => loadDocument(bad)).toThrow(/unparseable/);
  });

  it("refuses a document whose root is not an object by name", () => {
    expect(() => loadDocument('"just a string"')).toThrow(/not-an-object/);
  });

  // An array means two different things by route, and the message must not describe the reader's
  // guess instead of the input: "[1, 2]" is neither YAML nor "---"-separated, so reporting it as a
  // multi-document stream would be a confident sentence about a file that does not exist.
  it("refuses a JSON array as not-an-object, not as a multi-document stream", () => {
    expect(() => loadDocument("[1, 2]")).toThrow(/not-an-object/);
    expect(() => loadDocument("[1, 2]")).not.toThrow(/multi-document/);
  });

  describe("the openapi version", () => {
    it("refuses Swagger 2.0 by name, naming the version it found", () => {
      const swagger = YAML_DOC.replace("openapi: 3.0.3", 'swagger: "2.0"');
      expect(swagger).not.toBe(YAML_DOC);
      expect(() => loadDocument(swagger)).toThrow(/swagger/i);
      expect(() => loadDocument(swagger)).toThrow(/2\.0/);
    });

    it("refuses an unsupported major version by name", () => {
      const v2 = YAML_DOC.replace("openapi: 3.0.3", 'openapi: "2.0"');
      expect(v2).not.toBe(YAML_DOC);
      expect(() => loadDocument(v2)).toThrow(/unsupported-openapi-version/);
      expect(() => loadDocument(v2)).toThrow(/2\.0/);
    });

    // The YAML number trap: an UNQUOTED `openapi: 2.0` parses to the number 2, not the string
    // "2.0". Treating a non-string version as a shape error would report "expected string" for
    // a document whose real problem is that it is Swagger.
    it("refuses an unquoted numeric version as a version, not as a shape error", () => {
      const v2 = YAML_DOC.replace("openapi: 3.0.3", "openapi: 2.0");
      expect(v2).not.toBe(YAML_DOC);
      expect(() => loadDocument(v2)).toThrow(/unsupported-openapi-version/);
    });

    it("accepts an unquoted 3.0, which YAML reads as the number 3", () => {
      const v3 = YAML_DOC.replace("openapi: 3.0.3", "openapi: 3.0");
      expect(v3).not.toBe(YAML_DOC);
      expect(loadDocument(v3).doc.openapi).toBe("3");
    });

    it("refuses a document declaring no version at all by name", () => {
      const none = YAML_DOC.replace("openapi: 3.0.3\n", "");
      expect(none).not.toBe(YAML_DOC);
      expect(() => loadDocument(none)).toThrow(/missing-openapi-version/);
    });

    it("refuses a version that is neither text nor a number by name", () => {
      const boolean = YAML_DOC.replace("openapi: 3.0.3", "openapi: true");
      expect(boolean).not.toBe(YAML_DOC);
      expect(() => loadDocument(boolean)).toThrow(/openapi-version-not-scalar/);
    });
  });

  it("refuses a document whose modelled shape is wrong by name", () => {
    const noTitle = YAML_DOC.replace("  title: ZZ Widgets\n", "");
    expect(noTitle).not.toBe(YAML_DOC);
    expect(() => loadDocument(noTitle)).toThrow(/document-shape/);
    expect(() => loadDocument(noTitle)).toThrow(/title/);
  });

  it("resolves a YAML alias, so an anchored document reads the same as an expanded one", () => {
    const aliased = YAML_DOC.replace(
      "      summary: List widgets.",
      "      summary: &listed List widgets.",
    ).replace("      summary: Fetch one widget.", "      summary: *listed");
    expect(aliased).not.toBe(YAML_DOC);
    const ops = listOperations(loadDocument(aliased).doc);
    expect(ops.map((o) => o.summary)).toEqual([
      "List widgets.",
      "Create a widget.",
      "List widgets.",
    ]);
  });

  it("keeps unmodelled fields, which Task 2 reads off the raw operation", () => {
    // The schema models a SUBSET; anything it does not name must survive the round trip, or
    // parameters and requestBody would be stripped before the mapper ever sees them.
    const extended = YAML_DOC.replace(
      "      summary: List widgets.",
      [
        "      summary: List widgets.",
        "      parameters:",
        "        - name: limit",
        "          in: query",
        "          schema:",
        "            type: integer",
      ].join("\n"),
    );
    expect(extended).not.toBe(YAML_DOC);
    const [first] = listOperations(loadDocument(extended).doc);
    expect(first?.raw).toMatchObject({
      parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
    });
  });
});

describe("listOperations", () => {
  it("returns every operation in document order, method upper-cased and path verbatim", () => {
    const ops = listOperations(loadDocument(YAML_DOC).doc);
    expect(ops.map((o) => [o.operationId, o.method, o.path])).toEqual([
      ["listWidgets", "GET", "/widgets"],
      ["createWidget", "POST", "/widgets"],
      ["getWidget", "GET", "/widgets/{widgetId}"],
    ]);
  });

  it("carries the summary and the raw operation object through", () => {
    const [first] = listOperations(loadDocument(YAML_DOC).doc);
    expect(first?.summary).toBe("List widgets.");
    expect(first?.raw).toEqual({ operationId: "listWidgets", summary: "List widgets." });
  });

  // Document order is the order the METHOD KEYS appear under each path, not a fixed
  // get/post/put/patch/delete sweep — a fixed sweep would silently reorder the listing a user
  // reads their --op arguments off.
  it("follows the order the method keys appear in, not a fixed method order", () => {
    const swapped = YAML_DOC.replace(
      [
        "    get:",
        "      operationId: listWidgets",
        "      summary: List widgets.",
        "    post:",
        "      operationId: createWidget",
        "      summary: Create a widget.",
      ].join("\n"),
      [
        "    post:",
        "      operationId: createWidget",
        "      summary: Create a widget.",
        "    get:",
        "      operationId: listWidgets",
        "      summary: List widgets.",
      ].join("\n"),
    );
    expect(swapped).not.toBe(YAML_DOC);
    const ops = listOperations(loadDocument(swapped).doc);
    expect(ops.map((o) => o.operationId)).toEqual(["createWidget", "listWidgets", "getWidget"]);
  });

  it("refuses a document with no paths by name rather than returning an empty list", () => {
    const noPaths = YAML_DOC.slice(0, YAML_DOC.indexOf("paths:"));
    expect(noPaths).not.toBe(YAML_DOC);
    const { doc } = loadDocument(noPaths);
    expect(() => listOperations(doc)).toThrow(/no-paths/);
  });

  // --op selects on operationId. A generated fallback would be a name the document does not
  // contain, so the user would be told to pass an identifier they cannot find by searching
  // their own file.
  it("refuses an operation with no operationId by name, naming its method and path", () => {
    const missing = YAML_DOC.replace("      operationId: createWidget\n", "");
    expect(missing).not.toBe(YAML_DOC);
    const { doc } = loadDocument(missing);
    expect(() => listOperations(doc)).toThrow(/missing-operation-id/);
    expect(() => listOperations(doc)).toThrow(/POST \/widgets/);
  });

  it("refuses a blank operationId by name too", () => {
    const blank = YAML_DOC.replace("operationId: createWidget", 'operationId: "  "');
    expect(blank).not.toBe(YAML_DOC);
    expect(() => listOperations(loadDocument(blank).doc)).toThrow(/missing-operation-id/);
  });

  // Beyond the brief, same rule: --op selects on operationId, so two operations sharing one is
  // an ambiguous selection. First-wins would silently generate a tool for the wrong endpoint.
  it("refuses a duplicated operationId by name, naming both operations", () => {
    const dup = YAML_DOC.replace("operationId: getWidget", "operationId: listWidgets");
    expect(dup).not.toBe(YAML_DOC);
    const { doc } = loadDocument(dup);
    expect(() => listOperations(doc)).toThrow(/duplicate-operation-id/);
    expect(() => listOperations(doc)).toThrow(/GET \/widgets\/\{widgetId\}/);
  });

  // The path item is modelled as "an object" and nothing more, so document order survives the
  // parse. That guarantee is taken here instead, at the moment the operation is selected.
  it("refuses a method key holding something that is not an operation object by name", () => {
    const scalar = YAML_DOC.replace(
      ["    post:", "      operationId: createWidget", "      summary: Create a widget."].join(
        "\n",
      ),
      "    post: not-an-operation",
    );
    expect(scalar).not.toBe(YAML_DOC);
    const { doc } = loadDocument(scalar);
    expect(() => listOperations(doc)).toThrow(/operation-shape/);
    expect(() => listOperations(doc)).toThrow(/POST \/widgets/);
  });

  it("refuses an operationId that is not a string by name", () => {
    const numeric = YAML_DOC.replace("operationId: createWidget", "operationId: 42");
    expect(numeric).not.toBe(YAML_DOC);
    expect(() => listOperations(loadDocument(numeric).doc)).toThrow(/operation-shape/);
  });

  it("refuses a path item whose parameters is not an array by name", () => {
    const bad = YAML_DOC.replace("  /widgets:", "  /widgets:\n    parameters: not-a-list");
    expect(bad).not.toBe(YAML_DOC);
    const { doc } = loadDocument(bad);
    expect(() => listOperations(doc)).toThrow(/path-parameters-shape/);
    expect(() => listOperations(doc)).toThrow(/\/widgets/);
  });
});

/**
 * The path item's own `parameters` — the canonical place a document declares `{widgetId}` for
 * every operation under `/widgets/{widgetId}`.
 *
 * Dropping it is the expensive silent omission in this file's blast radius: the mapper would see
 * a `{widgetId}` in the path template with nothing declaring it, and would have to either refuse
 * a common valid document or invent a type.
 */
describe("listOperations > pathParameters", () => {
  const WITH_PATH_PARAM = YAML_DOC.replace(
    "  /widgets/{widgetId}:",
    [
      "  /widgets/{widgetId}:",
      "    parameters:",
      "      - name: widgetId",
      "        in: path",
      "        required: true",
      "        schema:",
      "          type: string",
    ].join("\n"),
  );

  it("carries the path item's parameters through on every operation under it", () => {
    expect(WITH_PATH_PARAM).not.toBe(YAML_DOC);
    const ops = listOperations(loadDocument(WITH_PATH_PARAM).doc);
    const getWidget = ops.find((o) => o.operationId === "getWidget");
    expect(getWidget?.pathParameters).toEqual([
      { name: "widgetId", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("is empty, not undefined, for a path item declaring none", () => {
    for (const op of listOperations(loadDocument(YAML_DOC).doc)) {
      expect(op.pathParameters).toEqual([]);
    }
  });

  // NOT merged into `raw`: OpenAPI's rule is that an operation-level parameter overrides a
  // path-level one sharing its (name, in) pair, and only the parameter mapper can tell the two
  // apart. Merging here would hand it one flat list in which an override reads as a duplicate.
  it("does not merge them into raw, so the mapper can apply the override rule itself", () => {
    const ops = listOperations(loadDocument(WITH_PATH_PARAM).doc);
    const getWidget = ops.find((o) => o.operationId === "getWidget");
    expect(getWidget?.raw).toEqual({ operationId: "getWidget", summary: "Fetch one widget." });
  });
});

/**
 * Reported, not refused — and that distinction is the point. Every refusal in this reader fires
 * on a document that is broken, foreign or unreadable; these two fire on a document that is valid
 * and otherwise entirely mappable. `--list-operations` exists to pick one operation out of many,
 * so refusing a whole file over one HEAD sitting beside forty usable operations would defeat the
 * command it is part of.
 */
describe("listSkippedOperations", () => {
  it("is empty for a document whose every method key is expressible", () => {
    expect(listSkippedOperations(loadDocument(YAML_DOC).doc)).toEqual([]);
  });

  it("reports an unsupported method by name and leaves the rest of the document listable", () => {
    const head = YAML_DOC.replace("    post:", "    head:");
    expect(head).not.toBe(YAML_DOC);
    const { doc } = loadDocument(head);

    expect(listSkippedOperations(doc)).toEqual([
      {
        reason: "unsupported-method",
        method: "head",
        path: "/widgets",
        detail: expect.stringContaining("GET, POST, PUT, PATCH or DELETE"),
      },
    ]);
    // The refusal-shaped failure this replaced took the other two operations down with it.
    expect(listOperations(doc).map((o) => o.operationId)).toEqual(["listWidgets", "getWidget"]);
  });

  // The likelier hand-authored mistake, and the one that used to vanish into the same bucket as
  // an `x-` extension: the listing just came up short, with no line saying which key was ignored.
  it("reports a mis-cased method key and says what to write instead", () => {
    const miscased = YAML_DOC.replace("    post:", "    POST:");
    expect(miscased).not.toBe(YAML_DOC);
    const { doc } = loadDocument(miscased);

    const [skipped] = listSkippedOperations(doc);
    expect(skipped?.reason).toBe("mis-cased-method");
    expect(skipped?.method).toBe("POST");
    expect(skipped?.path).toBe("/widgets");
    expect(skipped?.detail).toContain('"post:"');
    expect(listOperations(doc).map((o) => o.operationId)).toEqual(["listWidgets", "getWidget"]);
  });

  it("says nothing about path-item keys that were never operations", () => {
    // `parameters`, `summary`, `servers` and every `x-` extension are ordinary path-item fields.
    // Reporting them as skipped operations would bury the two reports that matter.
    const noisy = YAML_DOC.replace(
      "  /widgets:",
      ["  /widgets:", "    summary: The widget collection.", "    x-internal: true"].join("\n"),
    );
    expect(noisy).not.toBe(YAML_DOC);
    expect(listSkippedOperations(loadDocument(noisy).doc)).toEqual([]);
  });
});

describe("resolveRefs", () => {
  it("replaces an internal $ref with the node it names", () => {
    const withWidget = withRef('"#/components/schemas/Widget"', WIDGET_SCHEMA);
    expect(withWidget).not.toBe(YAML_DOC);
    const { doc } = loadDocument(withWidget);
    expect(bodySchemaOf(doc)).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  it("leaves no $ref key behind anywhere in the resolved document", () => {
    const resolved = resolveRefs({
      components: { schemas: { Widget: { type: "object" } } },
      here: { $ref: "#/components/schemas/Widget" },
    });
    expect(JSON.stringify(resolved)).not.toContain("$ref");
    expect(resolved).toMatchObject({ here: { type: "object" } });
  });

  it("resolves a pointer whose segment carries an RFC 6901 escape", () => {
    // `application/json` as a key: `/` is `~1` in a JSON Pointer, and a reader that does not
    // decode it splits the segment in two and reports a dangling reference for a target that
    // is right there.
    const resolved = resolveRefs({
      components: { schemas: { "application/json": { type: "string" } } },
      here: { $ref: "#/components/schemas/application~1json" },
    });
    expect(resolved).toMatchObject({ here: { type: "string" } });
  });

  it("refuses an external $ref by name, naming the reference", () => {
    const external = withRef('"./other.yaml#/Widget"', WIDGET_SCHEMA);
    expect(external).not.toBe(YAML_DOC);
    expect(() => loadDocument(external)).toThrow(/\$ref-not-internal/);
    expect(() => loadDocument(external)).toThrow(/\.\/other\.yaml#\/Widget/);
  });

  it("refuses a $ref whose value is not a string by name", () => {
    const notAString = withRef("42", WIDGET_SCHEMA);
    expect(notAString).not.toBe(YAML_DOC);
    expect(() => loadDocument(notAString)).toThrow(/\$ref-not-a-string/);
  });

  it("refuses a circular $ref by name rather than recursing forever", () => {
    const circular = withRef('"#/components/schemas/Widget"', CIRCULAR_WIDGET_SCHEMA);
    expect(circular).not.toBe(YAML_DOC);
    expect(() => loadDocument(circular)).toThrow(/\$ref-circular/);
    expect(() => loadDocument(circular)).toThrow(/#\/components\/schemas\/Widget/);
  });

  /**
   * The one that fails quietly if unhandled. A missing lookup yields `undefined`, which flows
   * into a downstream mapper as an ABSENT field rather than an error — the operation then maps
   * with a silently missing schema. So the refusal has to happen at resolution, while the
   * reference itself is still in hand to name.
   */
  it("refuses a dangling internal $ref by name, naming the reference that missed", () => {
    const dangling = withRef('"#/components/schemas/NoSuchThing"', WIDGET_SCHEMA);
    expect(dangling).not.toBe(YAML_DOC);
    expect(() => loadDocument(dangling)).toThrow(/\$ref-dangling/);
    expect(() => loadDocument(dangling)).toThrow(/NoSuchThing/);
  });

  it("does not mistake a resolved null for a dangling reference", () => {
    // YAML's `key:` with no value is null, which is a PRESENT node. Only `undefined` — which
    // no JSON or YAML document can produce — means the lookup missed.
    const resolved = resolveRefs({
      components: { schemas: { Widget: null } },
      here: { $ref: "#/components/schemas/Widget" },
    });
    expect(resolved).toEqual({
      components: { schemas: { Widget: null } },
      here: null,
    });
  });

  it("resolves the same reference twice without calling the second one circular", () => {
    // Two siblings pointing at one schema is not a cycle: the resolution STACK is per-branch,
    // and a shared `seen` set would refuse this perfectly ordinary document.
    const resolved = resolveRefs({
      components: { schemas: { Widget: { type: "object" } } },
      a: { $ref: "#/components/schemas/Widget" },
      b: { $ref: "#/components/schemas/Widget" },
    });
    expect(resolved).toMatchObject({ a: { type: "object" }, b: { type: "object" } });
  });
});
