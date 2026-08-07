/**
 * Reading an OpenAPI document into the shapes the rest of `src/openapi/` maps from.
 *
 * This module is a sibling of `src/derive/`, not a copy of it. Both produce a connector spec and
 * both **refuse by name** rather than guess — but the deriver reads this generator's own emitted
 * source, while this reads a foreign document. That difference drives one deliberate asymmetry:
 * there is no guarded-accessor layer here. `src/derive/read.ts` exists because a Babel AST has a
 * hundred node types and an index signature made eight wrong claims possible; an OpenAPI document
 * is plain JSON that `OpenApiDocumentSchema` has already validated, so **the schema is the
 * guard**. Adding accessors here would be ceremony over a shape zod has already proved.
 *
 * Every failure is an Error whose message begins with a LABEL naming the construct, because
 * silent omission is the failure mode this repo is built against. The labels:
 *
 *   unparseable                  the text is neither JSON nor YAML
 *   multi-document-stream        a YAML stream holding more than one document
 *   not-an-object                the root is a scalar or an array of non-documents
 *   swagger-2.0                  a Swagger 2.0 document, which this reader does not model
 *   missing-openapi-version      no `openapi` field at all
 *   openapi-version-not-scalar   an `openapi` field that is not text or a number
 *   unsupported-openapi-version  an `openapi` field whose major version is not 3
 *   document-shape               the modelled subset does not typecheck against the schema
 *   $ref-not-a-string            a `$ref` whose value is not a string
 *   $ref-not-internal            a `$ref` that leaves the document (`./other.yaml#/X`, a URL)
 *   $ref-circular                a `$ref` chain that returns to a pointer already being resolved
 *   $ref-dangling                a `#/...` pointer naming a node the document does not contain
 *   no-paths                     a document declaring no `paths` object
 *   unsupported-method           `head`, `options` or `trace`, which the spec language lacks
 *   operation-shape              a method key holding something that is not an operation object
 *   missing-operation-id         an operation with no `operationId` for `--op` to select on
 *   duplicate-operation-id       two operations sharing one `operationId`
 */
import { type OpenApiDocument, OpenApiDocumentSchema, OpenApiOperationSchema } from "./schema.ts";

export type LoadedDocument = { doc: OpenApiDocument; source: "yaml" | "json" };

export type Operation = {
  readonly operationId: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly summary?: string;
  /** The operation object as read, refs already resolved — Task 2 maps from this. */
  readonly raw: unknown;
};

/** Every refusal goes through here, so a label can never be attached to only half a message. */
function refuse(label: string, detail: string): never {
  throw new Error(`${label}: ${detail}`);
}

/* ------------------------------------------------------------------------------------------ *
 * $ref resolution
 * ------------------------------------------------------------------------------------------ */

/**
 * One JSON Pointer lookup against the document root.
 *
 * Returns `undefined` for a miss, which is unambiguous: neither JSON nor YAML can produce an
 * `undefined` value — YAML's bare `key:` is null, a present node — so `undefined` here means the
 * pointer named something the document does not contain, and nothing else.
 *
 * The `~1`/`~0` unescaping is RFC 6901, and it is load-bearing rather than pedantic: media types
 * are ordinary schema keys (`application/json`), and a reader that skips the decode splits that
 * segment in two and reports a dangling reference for a node that is right there.
 */
function lookup(root: unknown, pointer: string): unknown {
  let node = root;
  for (const encoded of pointer.slice(2).split("/")) {
    if (typeof node !== "object" || node === null) return undefined;
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * `stack` is the chain of pointers currently being resolved on THIS branch, not a set of every
 * pointer ever seen. Two siblings referring to one schema is an ordinary document; a shared seen
 * set would call it circular and refuse it.
 */
function resolveNode(node: unknown, root: unknown, stack: readonly string[]): unknown {
  if (Array.isArray(node)) return node.map((child) => resolveNode(child, root, stack));
  if (typeof node !== "object" || node === null) return node;

  const record = node as Record<string, unknown>;
  if ("$ref" in record) {
    const pointer = record["$ref"];
    if (typeof pointer !== "string") {
      refuse("$ref-not-a-string", `a $ref must be a "#/..." pointer, found ${typeof pointer}.`);
    }
    if (!pointer.startsWith("#/")) {
      refuse(
        "$ref-not-internal",
        `${pointer} leaves this document. Only internal "#/..." references resolve — bundle the ` +
          "document first (for example with a $ref bundler) and pass the single-file result.",
      );
    }
    if (stack.includes(pointer)) {
      refuse("$ref-circular", `${[...stack, pointer].join(" -> ")} returns to itself.`);
    }
    const target = lookup(root, pointer);
    if (target === undefined) {
      refuse("$ref-dangling", `${pointer} names a node this document does not contain.`);
    }
    return resolveNode(target, root, [...stack, pointer]);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = resolveNode(value, root, stack);
  return out;
}

/**
 * Replaces every internal `{ $ref: "#/..." }` with the node it names, throughout the document.
 *
 * The dangling case is why this refuses at resolution rather than leaving the reference in place
 * for a later stage: a missing lookup yields `undefined`, which reaches a mapper as an ABSENT
 * field rather than an error, and the operation then maps with a silently missing schema. Here,
 * the reference is still in hand to name.
 */
export function resolveRefs(doc: unknown): unknown {
  return resolveNode(doc, doc, []);
}

/* ------------------------------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------------------------------ */

/**
 * JSON first, then YAML.
 *
 * Every JSON document is also valid YAML, so the order is not about capability: a downloaded
 * spec is JSON far more often than not, and `JSON.parse`'s error names the offending position
 * where a YAML parser handed the same text reports something about implicit keys.
 */
function parseText(text: string): { value: unknown; source: "yaml" | "json" } {
  try {
    return { value: JSON.parse(text), source: "json" };
  } catch {
    // Not JSON — fall through to YAML, whose failure is the one worth reporting.
  }
  try {
    return { value: Bun.YAML.parse(text), source: "yaml" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    refuse("unparseable", `the document is neither JSON nor YAML (${detail}).`);
  }
}

/** Text for a version field, tolerating YAML's coercion of `3.0` to the number 3. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Checked on the RAW parsed value, before the schema runs.
 *
 * A Swagger 2.0 document carries `swagger: "2.0"` and no `openapi` field at all, so leaving this
 * to the schema would report a missing required key for a document whose actual problem is that
 * it is a different format. Naming the format is the difference between "go convert it" and "go
 * hunt for a typo".
 */
function assertSupportedVersion(root: Record<string, unknown>): void {
  const declared = root["openapi"];
  if (declared === undefined) {
    const swagger = root["swagger"];
    if (swagger !== undefined) {
      refuse(
        "swagger-2.0",
        `this is a Swagger ${scalarText(swagger) ?? "2.0"} document; this reader models OpenAPI ` +
          "3 only. Convert it to OpenAPI 3 first.",
      );
    }
    refuse("missing-openapi-version", 'no "openapi" field, so the document version is unknown.');
  }
  const text = scalarText(declared);
  if (text === undefined) {
    refuse("openapi-version-not-scalar", `"openapi" must be text, found ${typeof declared}.`);
  }
  if (text.split(".")[0] !== "3") {
    refuse("unsupported-openapi-version", `${text} is not OpenAPI 3, which is all this reads.`);
  }
}

/**
 * Text → a validated document, with `$ref`s already resolved.
 *
 * The array check is not defensive padding: a multi-document YAML stream (`---` separated)
 * parses to an ARRAY, verified against the pinned Bun 1.3.14. Taking `[0]` would read half of a
 * two-API file and report success.
 */
export function loadDocument(text: string): LoadedDocument {
  const { value, source } = parseText(text);
  if (Array.isArray(value)) {
    refuse(
      "multi-document-stream",
      `this YAML holds ${value.length} documents separated by "---"; pass one document per file ` +
        "so the one being read is the one you chose.",
    );
  }
  if (typeof value !== "object" || value === null) {
    refuse("not-an-object", `the document root is ${value === null ? "null" : typeof value}.`);
  }
  assertSupportedVersion(value as Record<string, unknown>);

  const parsed = OpenApiDocumentSchema.safeParse(resolveRefs(value));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    refuse("document-shape", issues);
  }
  return { doc: parsed.data, source };
}

/* ------------------------------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------------------------------ */

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Method = (typeof METHODS)[number];

/**
 * The HTTP methods a Nimbus tool can issue, and the three it cannot. `head`, `options` and
 * `trace` are named rather than skipped: the spec language has no `method` value for them, and
 * an operation quietly missing from the listing is one a user cannot even ask about.
 */
const UNSUPPORTED_METHODS = new Set(["head", "options", "trace"]);

function isMethod(key: string): key is Method {
  return (METHODS as readonly string[]).includes(key);
}

/**
 * Every operation the document declares, in document order.
 *
 * Order is the order the METHOD KEYS appear under each path — read from `Object.keys`, not a
 * fixed get/post/put/patch/delete sweep. `--list-operations` is what a user reads their `--op`
 * arguments off, and a listing reordered away from the file they are looking at is a listing
 * they have to re-derive by hand.
 */
export function listOperations(doc: OpenApiDocument): Operation[] {
  const paths = doc.paths;
  if (paths === undefined) {
    refuse("no-paths", 'the document declares no "paths" object, so it describes no operations.');
  }

  const operations: Operation[] = [];
  /** operationId → where it was first seen, so a duplicate can name both sites. */
  const seen = new Map<string, string>();

  for (const [path, item] of Object.entries(paths)) {
    for (const key of Object.keys(item)) {
      if (UNSUPPORTED_METHODS.has(key)) {
        refuse(
          "unsupported-method",
          `${key} ${path}: a connector tool issues GET, POST, PUT, PATCH or DELETE, and the spec ` +
            `language has no ${key} equivalent. Remove the operation or pick another document.`,
        );
      }
      if (!isMethod(key)) continue;

      const method = key.toUpperCase() as Operation["method"];
      const where = `${method} ${path}`;
      // OpenApiPathItemSchema deliberately declares no method keys, so that document order
      // survives the parse — see its note. The guarantee is taken here instead: the operation is
      // validated at the moment it is selected, and `raw` stays the value the document held.
      const raw = item[key];
      const parsed = OpenApiOperationSchema.safeParse(raw);
      if (!parsed.success) {
        refuse("operation-shape", `${where}: ${parsed.error.issues[0]?.message ?? "unreadable"}.`);
      }

      const operationId = parsed.data.operationId;
      if (operationId === undefined || operationId.trim() === "") {
        refuse(
          "missing-operation-id",
          `${where} has no operationId. --op selects on it, and a generated fallback would be a ` +
            "name this document does not contain.",
        );
      }
      const first = seen.get(operationId);
      if (first !== undefined) {
        refuse(
          "duplicate-operation-id",
          `${operationId} names both ${first} and ${where}; --op could not tell them apart.`,
        );
      }
      seen.set(operationId, where);

      operations.push({
        operationId,
        method,
        path,
        ...(parsed.data.summary === undefined ? {} : { summary: parsed.data.summary }),
        raw,
      });
    }
  }
  return operations;
}
