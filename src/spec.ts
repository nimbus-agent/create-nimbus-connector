import { z } from "zod";

/**
 * Tool keys rejected with a targeted message rather than Zod's generic "unrecognized key".
 * Detected before Zod so the error explains the boundary and names the alternative.
 *
 * The message used to read "is not supported in Stage A (… a later Stage C task)". Stage C
 * happened, and it did not add `hitl` — the manifest's `hitlRequired` array is computed from
 * each tool's `effect` instead, deliberately (see the Stage C design doc §1.1: `hitlRequired`
 * is a manifest-level capability array in all 94 corpus connectors, never per-tool). The
 * message now says what is true and what to write instead, and does not promise a stage.
 */
const OUT_OF_SCOPE_TOOL_KEYS: Record<string, string> = {
  hitl: 'HITL is not declared per tool; use "effect": "write" | "delete", which is what the manifest\'s hitlRequired array is computed from',
};

/**
 * Every `local` field becomes an emitted identifier (a function name, a hoisted
 * const name), so it is held to the same rule as tool argument keys — a valid
 * JS identifier, not just a non-empty string.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const identifierField = () => z.string().regex(IDENTIFIER_RE, "must be a valid JS identifier");

export const ArgSchema = z
  .strictObject({
    type: z.enum(["string", "number", "boolean"]),
    optional: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Hoisted const name. Cosmetic; defaults to the arg's own key. */
    local: identifierField().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    int: z.boolean().default(false),
  })
  .refine((a) => !(a.type === "boolean" && a.default !== undefined), {
    message: 'a boolean argument cannot declare "default" — the generated hoist ignores it',
  })
  .refine((a) => a.type !== "boolean" || (a.min === undefined && a.max === undefined), {
    message: '"min"/"max" are not valid on a boolean argument',
  })
  .refine((a) => a.type === "number" || !a.int, {
    message: '"int" is only valid on a number argument',
  })
  .refine((a) => a.default === undefined || a.optional, {
    message:
      'an argument declaring "default" must also declare "optional": true — a required ' +
      "argument's default can never be reached, since the schema demands a value",
  });

export const ToolSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().min(1),
    args: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "argument name must be a valid JS identifier"),
        ArgSchema,
      )
      .default({}),
    path: z.string().optional(),
    // "get" is the Stage A spelling. It became wrong the moment `method` existed, but
    // 0.2.2 is published, so it is normalised rather than rejected.
    impl: z
      .enum(["rest", "get", "stub"])
      .default("rest")
      .transform((v) => (v === "get" ? "rest" : v)),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    /**
     * The author's declaration of intent, deliberately NOT derived from `method`.
     * Measured against the 94 connectors, method-derived HITL matches only 62 — dagster
     * POSTs GraphQL queries, ramp and wiz POST to exchange tokens.
     */
    effect: z.enum(["read", "write", "delete"]).default("read"),
    /** arg name -> API field name. Omitted means "the args object is the body". */
    body: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .refine((t) => (t.impl === "stub") === (t.path === undefined), {
    message:
      '"path" is required when "impl" is not "stub", and must be omitted when "impl" is "stub" ' +
      '— "impl" and "path" disagree',
  })
  .refine((t) => !(t.impl === "stub" && (t.method !== "GET" || t.body !== undefined)), {
    message: 'a "stub" tool issues no request, so "method" and "body" have nothing to describe',
  })
  .refine((t) => !(t.method === "GET" && t.effect !== "read" && t.impl !== "stub"), {
    message:
      'a GET tool cannot have effect "write" or "delete" — a REST GET that mutates is a bug, ' +
      "not a design. Set the method the API actually requires.",
  })
  .refine((t) => !(t.body !== undefined && t.method === "GET"), {
    message: '"body" requires a non-GET "method"',
  })
  // superRefine only, deliberately: a parallel .refine asserting the same condition would
  // fire alongside this one with a vaguer message, and the test asserts the offending key
  // name appears in the error. One check, one message, naming the key that is wrong.
  .superRefine((t, ctx) => {
    if (t.body === undefined) return;
    for (const k of Object.keys(t.body)) {
      if (!(k in t.args)) {
        ctx.addIssue({ code: "custom", message: `"body" key "${k}" is not a declared arg` });
      }
    }
  });

export const EnvSchema = z
  .strictObject({
    vars: z.array(z.string().min(1)).min(1),
    /** Accessor function name. */
    local: identifierField(),
    /** Internal variable name per var. Cosmetic; defaults to camelCase(var). */
    bindings: z.array(z.string().min(1)).optional(),
    required: z.boolean().default(false),
    default: z.string().optional(),
    transform: z.enum(["stripTrailingSlash"]).optional(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    auth: z.enum(["bearer", "headers", "client-credentials"]).optional(),
    /** Header name per var, required when auth === "headers". */
    headerNames: z.array(z.string().min(1)).optional(),
    /**
     * Token endpoint, required when auth === "client-credentials".
     *
     * `z.url()` rather than the deprecated `z.string().url()`: in zod 4 the string-method
     * form is a deprecated alias for exactly this, same acceptance set and same
     * `invalid_format`/`format: "url"` issue, so the swap is a rename only.
     */
    tokenUrl: z.url().optional(),
    scope: z.string().min(1).optional(),
    /** ramp sends Basic; powerbi, looker and teams put client_secret in the body. */
    credentialsIn: z.enum(["basic", "body"]).optional(),
  })
  .refine((e) => !(e.required && e.default !== undefined), {
    message:
      'env entry cannot declare both "default" and "required" — a defaulted value is never empty',
  })
  .refine((e) => e.bindings === undefined || e.bindings.length === e.vars.length, {
    message: '"bindings" must have exactly one entry per "vars" entry',
  })
  .refine((e) => e.auth !== "headers" || e.headerNames?.length === e.vars.length, {
    message: '"headerNames" must have one entry per "vars" entry when auth is "headers"',
  })
  .refine(
    (e) =>
      e.auth === undefined ||
      (e.transform === undefined && e.prefix === undefined && e.suffix === undefined),
    {
      message:
        'an entry with "auth" cannot also declare "transform", "prefix" or "suffix" — the auth wrapper replaces the returned value',
    },
  )
  .refine((e) => e.vars.length === 1 || e.auth === "headers" || e.auth === "client-credentials", {
    message:
      'only an entry with auth: "headers" or auth: "client-credentials" may declare multiple "vars"',
  })
  .refine((e) => e.auth !== "client-credentials" || e.vars.length === 2, {
    message: 'auth: "client-credentials" requires exactly two "vars" — a client id and a secret',
  })
  .refine((e) => e.auth !== "client-credentials" || e.tokenUrl !== undefined, {
    message: '"tokenUrl" is required when auth is "client-credentials"',
  })
  .refine((e) => e.auth !== "client-credentials" || e.credentialsIn !== undefined, {
    message: '"credentialsIn" is required when auth is "client-credentials"',
  })
  .refine((e) => e.tokenUrl === undefined || e.auth === "client-credentials", {
    message: '"tokenUrl" is only valid when auth is "client-credentials"',
  })
  .refine((e) => e.scope === undefined || e.auth === "client-credentials", {
    message: '"scope" is only valid when auth is "client-credentials"',
  })
  .refine((e) => e.credentialsIn === undefined || e.auth === "client-credentials", {
    message: '"credentialsIn" is only valid when auth is "client-credentials"',
  });

export const FetchHelperSchema = z.strictObject({
  local: identifierField(),
  /** Template over ${env.X}, e.g. "https://api.newrelic.com" or "https://${env.siteHost}". */
  base: z.string().min(1),
  /** Name of an env accessor returning the header record. */
  headers: z.string().min(1).optional(),
  /** Literal header object, values may reference ${env.X}. Mutually exclusive with `headers`. */
  inlineHeaders: z.record(z.string(), z.string()).optional(),
  normalizeLeadingSlash: z.boolean().default(false),
  jsonFallbackRaw: z.boolean().default(false),
});

/**
 * The two styles that emit their own fetch helper and env accessors. `read-only-kit`
 * differs from `hand-rolled` only in the server file's prologue and epilogue (Stage D
 * design §1.2), so every schema rule keyed to "hand-rolled" applies to it unchanged.
 */
function isHandStyle(style: string): boolean {
  return style === "hand-rolled" || style === "read-only-kit";
}

export const ConnectorSpecSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9-]+$/, "name must be lower-kebab-case"),
    title: z.string().min(1).optional(),
    displayName: z.string().min(1),
    id: z.string().min(1).optional(),
    description: z.string().min(1),
    serviceLabel: z.string().min(1),
    style: z.enum(["rest-kit", "hand-rolled", "read-only-kit"]).default("rest-kit"),
    network: z.array(z.string()).default([]),
    syncInterval: z.number().int().positive().default(300),
    minNimbusVersion: z.string().default("0.2.0"),
    env: z.array(EnvSchema).default([]),
    fetchHelper: FetchHelperSchema,
    tools: z.array(ToolSchema).default([]),
  })
  .refine(
    (s) =>
      !isHandStyle(s.style) ||
      (s.fetchHelper.headers === undefined) !== (s.fetchHelper.inlineHeaders === undefined),
    {
      message:
        "a hand-rolled connector must declare exactly one of fetchHelper.headers or fetchHelper.inlineHeaders",
    },
  )
  .refine(
    (s) =>
      s.style !== "rest-kit" ||
      (s.fetchHelper.headers === undefined &&
        s.fetchHelper.normalizeLeadingSlash === false &&
        s.fetchHelper.jsonFallbackRaw === false),
    {
      message:
        'fetchHelper.headers, .normalizeLeadingSlash and .jsonFallbackRaw apply only to style "hand-rolled" — the rest-kit helper ignores them',
    },
  )
  .refine(
    (s) =>
      s.style !== "rest-kit" ||
      (s.env.length === 1 && s.env[0]?.auth === "bearer" && s.env[0]?.vars.length === 1),
    {
      message:
        'a rest-kit connector must declare exactly one env entry, with auth: "bearer" and a single var — makeRestToolRegistrar resolves the token itself and no env accessors are emitted',
    },
  )
  // Not a validate.ts identifier claim, because the colliding names are not spec-authored:
  // renderTokenFunction emits `cachedToken` and `token` at module scope, hard-coded, once per
  // client-credentials entry. Two entries emit each name twice. Nothing in the corpus has two
  // token exchanges, and supporting them would mean parameterising those names — a change to
  // emitted shape for a case no connector has, so this is rejected instead.
  .refine((s) => s.env.filter((e) => e.auth === "client-credentials").length <= 1, {
    message:
      'a connector may declare at most one env entry with auth: "client-credentials" — the ' +
      "emitted token exchange declares `token` and `cachedToken` at module scope, so a second " +
      "entry would redeclare both",
  })
  .refine((s) => s.style !== "rest-kit" || !s.env.some((e) => e.auth === "client-credentials"), {
    message:
      'style "rest-kit" cannot use client-credentials: makeRestToolRegistrar resolves a single ' +
      'bearer credential itself and has no seam for a token exchange. Use style "hand-rolled".',
  })
  .refine(
    (s) =>
      s.style !== "rest-kit" ||
      (!/\$\{env\./.test(s.fetchHelper.base) &&
        Object.values(s.fetchHelper.inlineHeaders ?? {}).every((v) => !/\$\{env\./.test(v))),
    {
      message:
        "a rest-kit connector cannot reference ${env.X} in fetchHelper.base or fetchHelper.inlineHeaders — rest-kit emits no env accessors, so the call would be undefined",
    },
  );

export type EnvSpec = z.infer<typeof EnvSchema>;
export type ToolSpec = z.infer<typeof ToolSchema>;
export type ArgSpec = z.infer<typeof ArgSchema>;
export type FetchHelperSpec = z.infer<typeof FetchHelperSchema>;

export type ConnectorSpec = z.infer<typeof ConnectorSpecSchema> & {
  readonly title: string;
  readonly id: string;
};

/** Capitalise the first letter only: "newrelic" -> "Newrelic". Matches the README fixtures. */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Module-scope registrar constant emitted for `style: "rest-kit"` connectors. */
export function registrarName(spec: ConnectorSpec): string {
  return `register${spec.title.replaceAll(/[^A-Za-z0-9]/g, "")}Tool`;
}

function preflightOutOfScope(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  const tools = (input as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return;
  for (const t of tools) {
    if (typeof t !== "object" || t === null) continue;
    for (const [key, why] of Object.entries(OUT_OF_SCOPE_TOOL_KEYS)) {
      if (key in t) {
        throw new Error(`"${key}" is not a supported tool field: ${why}.`);
      }
    }
  }
}

export function parseSpec(input: unknown): ConnectorSpec {
  preflightOutOfScope(input);
  const parsed = ConnectorSpecSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid connector spec:\n${lines.join("\n")}`);
  }
  const s = parsed.data;
  return { ...s, title: s.title ?? capitalize(s.name), id: s.id ?? `com.nimbus.${s.name}` };
}
