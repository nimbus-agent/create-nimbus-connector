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
