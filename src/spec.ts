import { z } from "zod";

/** Keys that belong to Stage B/C. Detected before Zod so the error explains the boundary. */
const OUT_OF_SCOPE_TOOL_KEYS: Record<string, string> = {
  method: 'non-GET tools are out of scope; use "impl": "stub"',
  body: 'request bodies are out of scope; use "impl": "stub"',
  hitl: "HITL declaration is Stage C",
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
    impl: z.enum(["get", "stub"]).default("get"),
  })
  .refine((t) => (t.impl === "stub") === (t.path === undefined), {
    message:
      '"path" is required when "impl" is not "stub", and must be omitted when "impl" is "stub" ' +
      '— "impl" and "path" disagree',
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
    auth: z.enum(["bearer", "headers"]).optional(),
    /** Header name per var, required when auth === "headers". */
    headerNames: z.array(z.string().min(1)).optional(),
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
  .refine((e) => e.vars.length === 1 || e.auth === "headers", {
    message: 'only an entry with auth: "headers" may declare multiple "vars"',
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

export const ConnectorSpecSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9-]+$/, "name must be lower-kebab-case"),
    title: z.string().min(1).optional(),
    displayName: z.string().min(1),
    id: z.string().min(1).optional(),
    description: z.string().min(1),
    serviceLabel: z.string().min(1),
    style: z.enum(["rest-kit", "hand-rolled"]).default("rest-kit"),
    network: z.array(z.string()).default([]),
    syncInterval: z.number().int().positive().default(300),
    minNimbusVersion: z.string().default("0.2.0"),
    env: z.array(EnvSchema).default([]),
    fetchHelper: FetchHelperSchema,
    tools: z.array(ToolSchema).default([]),
  })
  .refine(
    (s) =>
      s.style !== "hand-rolled" ||
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
        throw new Error(`"${key}" is not supported in Stage A (${why}).`);
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
