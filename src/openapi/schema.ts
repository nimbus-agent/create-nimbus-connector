/**
 * A zod schema for the SUBSET of OpenAPI this tool reads — not an OpenAPI validator.
 *
 * A reader arriving here will otherwise reasonably expect the latter and file the gaps as bugs,
 * so state the boundary plainly: this schema models `openapi`, `info.title`, `info.version`,
 * `servers[].url`, `paths` (path → method → operation) and `components` (`schemas`,
 * `securitySchemes`). Nothing else is validated, and — critically — nothing else is *removed*.
 * Every object below is a `z.looseObject`, so `parameters`, `requestBody`, `responses` and every
 * vendor extension survive the parse untouched and reach `src/openapi/operation.ts` on the raw
 * operation. A `z.object` here would strip exactly the fields the mapper exists to read.
 *
 * The schema's job is to make the shapes downstream code reads **provably present**, so that
 * code can index them without guarding. That is why `src/openapi/` has no counterpart to
 * `src/derive/read.ts`: the deriver's guarded accessors exist because a Babel AST has a hundred
 * node types and an index signature made eight wrong claims possible, whereas an OpenAPI
 * document is plain JSON and **the schema is the guard**. The asymmetry is deliberate.
 *
 * What is deliberately left OPTIONAL rather than required, in every case so that a named
 * refusal can report it instead of a zod issue: `paths` (`listOperations` refuses `no-paths`),
 * `servers` and `servers[].url` (Task 3 distinguishes absent from empty from url-less),
 * `operationId` (`listOperations` names the method and path that lack one).
 *
 * One thing this schema must NOT do is reorder the document, which is why the path item below
 * declares no method keys — see its own note.
 *
 * A second group of schemas sits at the bottom of this file — parameters, schema nodes, media
 * types and request bodies. Those are NOT part of `OpenApiDocumentSchema`; they are applied by
 * `src/openapi/operation.ts` to one operation at a time, and their own section header says why
 * that separation is load-bearing rather than incidental.
 */
import { z } from "zod";

/**
 * A version field that survives YAML's number coercion.
 *
 * YAML reads an unquoted `openapi: 3.0` as the NUMBER 3, and `version: 1.0` as the number 1 —
 * only a three-part `3.0.3` happens to stay a string. Requiring `z.string()` would therefore
 * reject ordinary documents with "expected string, received number", which describes the
 * reader's assumption rather than the document's problem.
 */
const versionText = () => z.union([z.string(), z.number()]).transform((v) => String(v));

/** One operation object. `operationId` is optional here so listOperations can name what lacks it. */
export const OpenApiOperationSchema = z.looseObject({
  operationId: z.string().optional(),
  summary: z.string().optional(),
});

/**
 * One path item — an object, and nothing more is claimed about it here.
 *
 * The five method keys are deliberately NOT declared, and this is the one place in this file
 * where modelling less is the stronger choice. Measured: `z.looseObject({get, post}).parse({post,
 * get, zz, aa})` returns keys in the order `get, post, zz, aa` — zod emits declared keys in
 * SCHEMA order first, then the passthrough remainder. Declaring the methods would therefore
 * rewrite every path item into `get, post, put, patch, delete` order, and `listOperations`
 * promises document order because `--list-operations` is what a user reads their `--op`
 * arguments off. An undeclared key keeps its position, so the listing matches the file.
 *
 * `listOperations` parses each operation it selects with `OpenApiOperationSchema` instead, which
 * is the same guarantee taken one level later.
 */
export const OpenApiPathItemSchema = z.looseObject({});

export const OpenApiDocumentSchema = z.looseObject({
  openapi: versionText(),
  info: z.looseObject({ title: z.string(), version: versionText().optional() }),
  servers: z.array(z.looseObject({ url: z.string().optional() })).optional(),
  paths: z.record(z.string(), OpenApiPathItemSchema).optional(),
  components: z
    .looseObject({
      schemas: z.record(z.string(), z.unknown()).optional(),
      securitySchemes: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type OpenApiDocument = z.infer<typeof OpenApiDocumentSchema>;
export type OpenApiOperation = z.infer<typeof OpenApiOperationSchema>;
export type OpenApiPathItem = z.infer<typeof OpenApiPathItemSchema>;

/* ------------------------------------------------------------------------------------------ *
 * Constructs read at MAPPING time, not at document-parse time
 *
 * `OpenApiDocumentSchema` stops at the path item, and the five below pick up where it stops:
 * they are what `src/openapi/operation.ts` reads off `Operation.raw` and `Operation
 * .pathParameters`. They are deliberately NOT wired into the document schema. A document whose
 * fortieth operation carries a header parameter is still a document whose other thirty-nine map,
 * and the mapper refuses one OPERATION at a time, by name; folding these in would turn every one
 * of those per-operation refusals into a single whole-document `document-shape` error naming a
 * zod path. That is the same "take the guarantee one level later" move `OpenApiPathItemSchema`
 * already makes for method keys.
 *
 * The ordering rule that schema states applies here too, in the one place where it reaches
 * emitted BYTES. `src/emit/server/args.ts` iterates `Object.entries(args)` and `renderBodyExpr`
 * builds its default body from `Object.keys(tool.args)`, so **argument order is emitted order** —
 * it is the field order of the tool's `z.object({ … })` and of its `JSON.stringify({ … })`.
 * OpenAPI's `parameters` is an array and so is safe; a request body's `properties` is an OBJECT.
 * Measured on the pinned zod 4.4.2: `z.object` with declared keys returns them in SCHEMA order,
 * `z.record` returns them in INPUT order. Hence `z.record` for `properties` and for `content`,
 * and never a declared key per property name.
 * ------------------------------------------------------------------------------------------ */

/** The two operation fields the mapper reads, kept `unknown` so it can refuse each by name. */
export const OpenApiOperationDetailSchema = z.looseObject({
  parameters: z.unknown().optional(),
  requestBody: z.unknown().optional(),
});

/**
 * One parameter object.
 *
 * `in` is a plain string rather than an enum: `header` and `cookie` are valid OpenAPI that this
 * generator cannot express, and a `z.enum` here would report them as a shape error rather than
 * letting the mapper refuse `parameter-location` and say why. `content` is modelled only so the
 * content-encoded form can be named — it is never read.
 */
export const OpenApiParameterSchema = z.looseObject({
  name: z.string().min(1),
  in: z.string().min(1),
  required: z.boolean().optional(),
  schema: z.unknown().optional(),
  content: z.unknown().optional(),
});

/**
 * One JSON Schema node, to the depth the mapper reads it.
 *
 * `type`, `format` and `enum` stay `unknown` for the reason `in` does above — OpenAPI 3.1 allows
 * `type: ["string", "null"]`, and a `z.string()` here would report that as a shape error instead
 * of a named refusal. `minimum`/`maximum` are the exception: they have no valid non-numeric form,
 * so a non-number there is genuinely a malformed node.
 *
 * Property values are `unknown` rather than a recursive `z.lazy` reference: the mapper parses
 * each one with this same schema when it descends, which keeps the recursion in code that can
 * refuse by name at each level instead of inside a zod issue path.
 */
export const OpenApiSchemaNodeSchema = z.looseObject({
  type: z.unknown().optional(),
  format: z.unknown().optional(),
  enum: z.unknown().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  default: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  oneOf: z.unknown().optional(),
  anyOf: z.unknown().optional(),
  allOf: z.unknown().optional(),
});

/** One `content` entry. Only `schema` is read; `example`/`encoding` pass through untouched. */
export const OpenApiMediaTypeSchema = z.looseObject({ schema: z.unknown().optional() });

/** A request body. `content` is a record so the media types keep their document order. */
export const OpenApiRequestBodySchema = z.looseObject({
  content: z.record(z.string(), z.unknown()).optional(),
  required: z.boolean().optional(),
});

export type OpenApiParameter = z.infer<typeof OpenApiParameterSchema>;
export type OpenApiSchemaNode = z.infer<typeof OpenApiSchemaNodeSchema>;
