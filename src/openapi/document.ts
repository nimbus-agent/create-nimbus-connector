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
 *   not-an-object                the root is a scalar, null, or a JSON array
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
 *   path-parameters-shape        a path item whose `parameters` is not an array
 *   operation-shape              a method key holding something that is not an operation object
 *   missing-operation-id         an operation with no `operationId` for `--op` to select on
 *   duplicate-operation-id       two operations sharing one `operationId`
 *
 * Two constructs are NOT refusals — they are reported by `listSkippedOperations` and omitted
 * from the selectable set instead, because both occur in documents that are otherwise entirely
 * readable and refusing the document would take forty mappable operations down with one:
 *
 *   unsupported-method           `head`, `options` or `trace`, which the spec language lacks
 *   mis-cased-method             `GET:` / `Post:` — OpenAPI method keys are lower-case
 *
 * The hard refusal for those two belongs where such an operation is actually named by `--op`,
 * which is the same "take the guarantee one level later" move `OpenApiPathItemSchema` makes.
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
  /**
   * The PATH ITEM's `parameters` — the ones declared beside this operation rather than inside
   * it — empty when the item declares none. Carried separately and NOT merged into `raw`.
   *
   * OpenAPI's rule is that a path-level parameter applies to every operation in the item, and an
   * operation-level parameter OVERRIDES it when both share a `(name, in)` pair. **The mapper
   * performs that merge**, on those exact terms: only the parameter mapper knows how to read a
   * parameter object, so merging here would hand it one flat list it could no longer tell apart,
   * and an override would silently become a duplicate.
   *
   * This exists because dropping it is the expensive silent omission in this file's blast radius.
   * `/widgets/{widgetId}` declaring `widgetId` at the path item is a CANONICAL OpenAPI shape; a
   * mapper that never saw it would face a `{widgetId}` in the path template with nothing
   * declaring it, and would have to either refuse a common valid document or invent a type.
   */
  readonly pathParameters: readonly unknown[];
};

/**
 * An operation this reader can see but not offer for selection.
 *
 * Reported rather than refused, deliberately. Every refusal in this module fires on a document
 * that is broken, foreign or unreadable; these two fire on a document that is *valid* and
 * otherwise entirely mappable, and `--list-operations` exists precisely to pick one operation out
 * of many — so refusing the whole file over a `HEAD /health` sitting beside forty usable
 * operations would defeat the command. Visibility does not require refusal: the same reasoning
 * leaves `paths: {}` printing zero lines rather than throwing.
 */
export type SkippedOperation = {
  readonly reason: "unsupported-method" | "mis-cased-method";
  /** As written in the document, so the user can find the line — not upper-cased. */
  readonly method: string;
  readonly path: string;
  /**
   * The name `--op` selects on, absent when the operation declares none.
   *
   * This is what makes the deferred refusal above possible rather than merely intended. Without
   * it a caller can report THAT something was skipped but cannot tell whether the operation a
   * user just named IS the skipped one — so `--op probeHealth` falls through to the generic
   * missing-operation path and answers "no such operation" about an operation sitting in the
   * user's own document. That is a different diagnosis from "the method is unsupported", and the
   * wrong one is the kind a user stops believing the tool over.
   */
  readonly operationId?: string;
  readonly detail: string;
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
 *
 * **The one thing this drops, and why that is not the silent-omission class.** A node is replaced
 * WHOLE, so any sibling of a `$ref` goes with it. In OpenAPI 3.0 that is what the specification
 * requires — siblings of a `$ref` are defined to be ignored — so dropping them is the correct
 * reading rather than a loss. 3.1 permits exactly two meaningful siblings, `summary` and
 * `description`, and `assertSupportedVersion` accepts any 3.x, so those two can in principle be
 * dropped. They are documentation fields on a REFERENCE, and no spec field this generator emits
 * derives from one: a tool's description comes from the operation's own `summary`/`description`,
 * which live inside the resolved node, never on the reference pointing at it. So the drop cannot
 * change a generated connector, which is the test that keeps it out of the refuse-don't-drop
 * rule. If a future mapper ever reads a schema node's `description`, this stops being true and
 * the siblings must be merged over the resolved node (3.1's rule: the reference's wins).
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
 *
 * It is gated on `source`, because an array means two different things by route. A JSON array is
 * simply not a document, and reporting it as `this YAML holds 2 documents separated by "---"` —
 * for text containing neither YAML nor a `---` — describes the reader's guess rather than the
 * input. `source` is in hand here, so the two cases are separated rather than conflated.
 */
export function loadDocument(text: string): LoadedDocument {
  const { value, source } = parseText(text);
  if (Array.isArray(value)) {
    if (source === "yaml") {
      // Deliberately does NOT say `separated by "---"`. Bun.YAML.parse returns an array for a
      // multi-document stream AND for a single document whose root is a sequence, and this
      // function cannot tell them apart from the parsed value alone — so naming the separator
      // would assert a construct that is absent from half the inputs that land here. That is the
      // same wrong-claim shape the JSON branch below was corrected for; stating the observation
      // (an array where an object belongs) rather than the cause is what makes it true for both.
      refuse(
        "multi-document-stream",
        `this YAML parsed to a sequence of ${value.length} items where a single OpenAPI ` +
          "document object was expected — a multi-document stream, or a document whose root is " +
          "a list. Pass one document per file so the one being read is the one you chose.",
      );
    }
    refuse("not-an-object", "the document root is a JSON array, not an object.");
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

/** The three HTTP methods OpenAPI allows on a path item that the spec language cannot express. */
const UNSUPPORTED_METHODS = new Set(["head", "options", "trace"]);

function isMethod(key: string): key is Method {
  return (METHODS as readonly string[]).includes(key);
}

/**
 * Why a path-item key is skipped rather than listed, or `undefined` when it is not a method key
 * at all (`parameters`, `summary`, `servers`, `x-*` — none of which is an operation, and none of
 * which is worth reporting).
 *
 * The mis-cased arm is the one a hand-authored document actually hits. OpenAPI's method keys are
 * lower-case, so `GET:` is not an operation and vanishes into the same bucket as `x-internal` —
 * the listing simply comes up short, with no line saying which key was ignored or why.
 */
function skipReasonFor(key: string): SkippedOperation["reason"] | undefined {
  const lower = key.toLowerCase();
  if (UNSUPPORTED_METHODS.has(lower)) return "unsupported-method";
  if (key !== lower && isMethod(lower)) return "mis-cased-method";
  return undefined;
}

/**
 * The `operationId` of an operation that is being SKIPPED, read defensively.
 *
 * A listed operation is refused outright when `OpenApiOperationSchema` rejects it, and when it
 * declares no `operationId`. Neither applies here, deliberately: a `head:` holding a string, or a
 * mis-cased `POST:` with no `operationId`, must not take a document's other forty operations down
 * with it — that is the whole reason these are reported rather than refused. So a value that is
 * not usable simply yields `undefined`, and such an operation is one `--op` cannot name at all.
 */
function skippedOperationId(raw: unknown): string | undefined {
  const parsed = OpenApiOperationSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const id = parsed.data.operationId;
  return id === undefined || id.trim() === "" ? undefined : id;
}

function skipDetailFor(reason: SkippedOperation["reason"], key: string): string {
  if (reason === "unsupported-method") {
    return (
      `a connector tool issues GET, POST, PUT, PATCH or DELETE, and the spec language has no ` +
      `${key} equivalent, so this operation cannot be generated.`
    );
  }
  return `OpenAPI method keys are lower-case; write "${key.toLowerCase()}:" instead of "${key}:".`;
}

/**
 * Both listings come from one walk DEFINITION, so they can never disagree about what the document
 * holds — `collect` is pure and each key resolves to exactly one of skipped, listed, or ignored.
 * Note the precision: `collect` *executes* once per exported call, so a full listing walks the
 * document twice. Non-divergence follows from purity, not from single execution, and saying "one
 * walk" unqualified would claim a mechanism that is not the one actually holding.
 */
type Listing = { operations: Operation[]; skipped: SkippedOperation[] };

/**
 * Order is the order the METHOD KEYS appear under each path — read from `Object.keys`, not a
 * fixed get/post/put/patch/delete sweep. `--list-operations` is what a user reads their `--op`
 * arguments off, and a listing reordered away from the file they are looking at is a listing
 * they have to re-derive by hand.
 */
function collect(doc: OpenApiDocument): Listing {
  const paths = doc.paths;
  if (paths === undefined) {
    refuse("no-paths", 'the document declares no "paths" object, so it describes no operations.');
  }

  const operations: Operation[] = [];
  const skipped: SkippedOperation[] = [];
  /** operationId → where it was first seen, so a duplicate can name both sites. */
  const seen = new Map<string, string>();

  for (const [path, item] of Object.entries(paths)) {
    const pathParameters = readPathParameters(item, path);
    for (const key of Object.keys(item)) {
      const reason = skipReasonFor(key);
      if (reason !== undefined) {
        const operationId = skippedOperationId(item[key]);
        skipped.push({
          reason,
          method: key,
          path,
          // Spread rather than `operationId: undefined`: exactOptionalPropertyTypes, and the key
          // set is then the one a hand-written SkippedOperation would carry.
          ...(operationId === undefined ? {} : { operationId }),
          detail: skipDetailFor(reason, key),
        });
        continue;
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
        pathParameters,
      });
    }
  }
  return { operations, skipped };
}

/**
 * The path item's own `parameters`, validated where it is read for the same reason the operation
 * is: `OpenApiPathItemSchema` claims only "this is an object", so that declaring a key cannot
 * reorder the method keys under it.
 */
function readPathParameters(item: Record<string, unknown>, path: string): readonly unknown[] {
  const declared = item["parameters"];
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    refuse(
      "path-parameters-shape",
      `${path}: "parameters" on a path item must be an array, found ${typeof declared}.`,
    );
  }
  return declared;
}

/** Every operation the document declares and this reader can offer, in document order. */
export function listOperations(doc: OpenApiDocument): Operation[] {
  return collect(doc).operations;
}

/**
 * Every operation the document declares that `listOperations` deliberately left out, so a caller
 * can say WHICH and WHY rather than letting the listing quietly come up short. See
 * `SkippedOperation` for why these are reported rather than refused.
 */
export function listSkippedOperations(doc: OpenApiDocument): SkippedOperation[] {
  return collect(doc).skipped;
}
