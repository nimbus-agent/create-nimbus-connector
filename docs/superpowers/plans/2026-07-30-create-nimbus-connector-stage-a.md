# create-nimbus-connector Stage A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Bun CLI that generates a Nimbus MCP connector package into `packages/mcp-connectors/<name>/`, plus a golden-fixture diff harness that proves the output byte-matches four real connectors.

**Architecture:** Generation is two stages. `generate(spec)` is a pure function returning unformatted `GeneratedFile[]`; `formatAll(files)` runs Biome over the TypeScript via an in-process WASM API. Three consumers share both stages: the interactive CLI, `--dry-run`, and the diff harness. Emitters are small pure functions, one per output file, composed by `emit/index.ts`.

**Tech Stack:** Bun, TypeScript, Zod 4, `@biomejs/js-api` + `@biomejs/wasm-nodejs`, `bun test`.

**Source spec:** `docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md`

## Global Constraints

- **Runtime:** Bun. Tests run with `bun test`. Typecheck with `bunx tsc --noEmit`.
- **This repo is MIT. The Nimbus monorepo is AGPL-3.0-only.** Never copy connector source text into this repo. Unit tests assert *structure and behaviour* (e.g. "has exactly these three dependencies"), never byte-equality against transcribed connector content. Byte-equality is proven **only** by the diff harness reading the monorepo at runtime.
- **Emitted package deps, exactly:** `"@modelcontextprotocol/sdk": "1.30.0"`, `"@nimbus-dev/sdk": "^1.8.1"`, `"zod": "^4.4.2"`. Emitted `devDependencies`: `{"@types/bun": "latest"}`.
- **Emitted package license:** `AGPL-3.0-only`. Emitted `private: false`, `type: "module"`.
- **Biome pins:** `@biomejs/wasm-nodejs@^2.5.6`, `@biomejs/js-api@^6.0.0`. The monorepo has Biome **2.5.6** installed. Do **not** key off the `2.5.0` in `biome.json`'s `$schema` URL — that is the schema version, not the tool version.
- **The WASM backend is fully self-contained and offline-safe.** `@biomejs/wasm-nodejs` ships `biome_wasm_bg.wasm` (**37.6 MB**) inside the npm tarball. There is no network fetch at init, so no proxy or air-gap setup is needed in CI. Verified under Bun 1.3.14: `new Biome()` from `@biomejs/js-api/nodejs` initialises with no flags and no runtime download.
  - The 37.6 MB install cost is acceptable for Stage A (a repo-local dev tool) but is a real consideration for a published `bunx create-nimbus-connector`. Flag it for the Stage B distribution decision; do not solve it here.
- **Biome format config (apply programmatically, do not rely on file discovery):** `indentStyle: "space"`, `indentWidth: 2`, `lineWidth: 100`, `lineEnding: "lf"`, `quoteStyle: "double"`, `trailingCommas: "all"`, `semicolons: "always"`.
- **★ Biome preserves object-literal expansion.** Verified against Biome 2.5.6: an object written expanded stays expanded and one written inline stays inline, even when both fit in 100 columns. **The emitter must therefore choose expansion explicitly** — formatting will not normalise it. This is why `grafana`'s fetch helper differs from `datadog`'s.
- **HTTP error snippet length is the constant `400`** in all four fixtures. Not a spec field.
- **Never commit on `main`.** All work lands on branch `stage-a-generator`.
- **Emitted files end with a trailing newline.** JSON files are `JSON.stringify(x, undefined, 2) + "\n"`.

## File Structure

```
package.json                     repo manifest, scripts
tsconfig.json                    strict TS config
biome.json                       lint/format for THIS repo
src/
  types.ts                       GeneratedFile
  spec.ts                        ConnectorSpec strict Zod schema + defaults
  validate.ts                    identifier uniqueness + out-of-scope key messages
  format.ts                      formatAll() — Biome WASM, only impure stage
  emit/
    index.ts                     generate(spec) -> GeneratedFile[]
    package-json.ts              emitPackageJson
    tsconfig.ts                  emitTsconfig
    sandbox-test.ts              emitSandboxTest  (constant)
    manifest.ts                  emitManifest
    readme.ts                    emitReadme
    server/
      index.ts                   emitServer — composes the four sections
      path-template.ts           parsePathTemplate + renderPath
      args.ts                    renderZodSchema + renderHoists
      env.ts                     renderEnvAccessor
      fetch-helper.ts            renderFetchHelper
      tools-hand.ts              renderHandRolledTools
      tools-rest.ts              renderRestKitTools
  cli.ts                         arg parsing, --dry-run, --spec, disk writes
scripts/
  diff-golden.ts                 the harness
fixtures/
  newrelic.spec.json  datadog.spec.json  grafana.spec.json  sentry.spec.json
  discord.spec.json   google-meet.spec.json
test/
  <mirrors src/>
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `src/types.ts`, `test/types.test.ts`

**Interfaces:**
- Produces: `GeneratedFile` — `{ readonly path: readonly string[]; readonly content: string }`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "create-nimbus-connector",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "bin": { "create-nimbus-connector": "./src/cli.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/ test/ scripts/",
    "test": "bun test",
    "diff:golden": "bun scripts/diff-golden.ts"
  },
  "dependencies": {
    "@biomejs/js-api": "^6.0.0",
    "@biomejs/wasm-nodejs": "^2.5.6",
    "zod": "^4.4.2"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.6",
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*", "test/**/*", "scripts/**/*"]
}
```

- [ ] **Step 3: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.6/schema.json",
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "lineEnding": "lf"
  },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": {
    "formatter": { "quoteStyle": "double", "trailingCommas": "all", "semicolons": "always" }
  }
}
```

- [ ] **Step 4: Write `src/types.ts`**

```ts
/** One emitted file. `path` is OS-independent path segments, e.g. ["src", "server.ts"]. */
export type GeneratedFile = {
  readonly path: readonly string[];
  readonly content: string;
};

/** Join a GeneratedFile path for display and comparison. Always forward slashes. */
export function displayPath(path: readonly string[]): string {
  return path.join("/");
}
```

- [ ] **Step 5: Write the test**

```ts
// test/types.test.ts
import { describe, expect, it } from "bun:test";
import { displayPath } from "../src/types.ts";

describe("displayPath", () => {
  it("joins segments with forward slashes regardless of platform", () => {
    expect(displayPath(["src", "server.ts"])).toBe("src/server.ts");
  });

  it("handles a single segment", () => {
    expect(displayPath(["README.md"])).toBe("README.md");
  });
});
```

- [ ] **Step 6: Install and verify**

Run: `bun install && bun test && bunx tsc --noEmit`
Expected: tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json biome.json src/types.ts test/types.test.ts bun.lock
git commit -m "feat: project scaffolding and GeneratedFile type"
```

---

### Task 2: `ConnectorSpec` schema

**Files:**
- Create: `src/spec.ts`, `test/spec.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ConnectorSpecSchema` (Zod), `type ConnectorSpec = z.infer<typeof ConnectorSpecSchema>`
  - `parseSpec(input: unknown): ConnectorSpec` — throws `Error` with a readable message
  - Nested types `EnvSpec`, `ToolSpec`, `ArgSpec`, `FetchHelperSpec`

**Background:** Zod 4 uses `z.strictObject()` for objects that reject unknown keys. Every object here is strict — that is how out-of-scope Stage B/C fields (`method`, `body`, `hitl`) fail fast.

- [ ] **Step 1: Write the failing test**

```ts
// test/spec.test.ts
import { describe, expect, it } from "bun:test";
import { parseSpec } from "../src/spec.ts";

const MINIMAL = {
  name: "newrelic",
  displayName: "New Relic",
  description: "New Relic connector.",
  serviceLabel: "New Relic",
  style: "hand-rolled",
  network: ["api.newrelic.com"],
  env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }],
  fetchHelper: {
    local: "nrGet",
    base: "https://api.newrelic.com",
    inlineHeaders: { "X-Api-Key": "${env.apiKey}", Accept: "application/json" },
  },
  tools: [{ name: "newrelic_application_list", description: "List APM applications.", path: "/v2/applications.json" }],
};

describe("parseSpec", () => {
  it("applies derived defaults", () => {
    const s = parseSpec(MINIMAL);
    expect(s.title).toBe("Newrelic");
    expect(s.id).toBe("com.nimbus.newrelic");
    expect(s.syncInterval).toBe(300);
    expect(s.minNimbusVersion).toBe("0.2.0");
    expect(s.tools[0]?.impl).toBe("get");
  });

  it("defaults style to rest-kit when omitted", () => {
    const { style, ...rest } = MINIMAL;
    expect(parseSpec(rest).style).toBe("rest-kit");
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseSpec({ ...MINIMAL, oauth: true })).toThrow(/oauth/);
  });

  it("rejects a non-GET method on a tool as out of scope", () => {
    const bad = { ...MINIMAL, tools: [{ ...MINIMAL.tools[0], method: "POST" }] };
    expect(() => parseSpec(bad)).toThrow(/method.*Stage A/s);
  });

  it("rejects an env entry declaring both default and required", () => {
    const bad = {
      ...MINIMAL,
      env: [{ vars: ["X"], local: "x", bindings: ["x"], required: true, default: "d" }],
    };
    expect(() => parseSpec(bad)).toThrow(/both .*default.* and .*required/i);
  });

  it("rejects bindings whose length does not match vars", () => {
    const bad = { ...MINIMAL, env: [{ vars: ["A", "B"], local: "h", bindings: ["a"] }] };
    expect(() => parseSpec(bad)).toThrow(/bindings/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/spec.test.ts`
Expected: FAIL — cannot resolve `../src/spec.ts`.

- [ ] **Step 3: Implement `src/spec.ts`**

```ts
import { z } from "zod";

/** Keys that belong to Stage B/C. Detected before Zod so the error explains the boundary. */
const OUT_OF_SCOPE_TOOL_KEYS: Record<string, string> = {
  method: 'non-GET tools are out of scope; use "impl": "stub"',
  body: 'request bodies are out of scope; use "impl": "stub"',
  hitl: "HITL declaration is Stage C",
};

export const ArgSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean"]),
  optional: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Hoisted const name. Cosmetic; defaults to the arg's own key. */
  local: z.string().min(1).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  int: z.boolean().default(false),
});

export const ToolSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  args: z.record(z.string(), ArgSchema).default({}),
  path: z.string().optional(),
  impl: z.enum(["get", "stub"]).default("get"),
});

export const EnvSchema = z
  .strictObject({
    vars: z.array(z.string().min(1)).min(1),
    /** Accessor function name. */
    local: z.string().min(1),
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
    message: 'env entry cannot declare both "default" and "required" — a defaulted value is never empty',
  })
  .refine((e) => e.bindings === undefined || e.bindings.length === e.vars.length, {
    message: '"bindings" must have exactly one entry per "vars" entry',
  })
  .refine((e) => e.auth !== "headers" || e.headerNames?.length === e.vars.length, {
    message: '"headerNames" must have one entry per "vars" entry when auth is "headers"',
  });

export const FetchHelperSchema = z.strictObject({
  local: z.string().min(1),
  /** Template over ${env.X}, e.g. "https://api.newrelic.com" or "https://${env.siteHost}". */
  base: z.string().min(1),
  /** Name of an env accessor returning the header record. */
  headers: z.string().min(1).optional(),
  /** Literal header object, values may reference ${env.X}. Mutually exclusive with `headers`. */
  inlineHeaders: z.record(z.string(), z.string()).optional(),
  normalizeLeadingSlash: z.boolean().default(false),
  jsonFallbackRaw: z.boolean().default(false),
});

export const ConnectorSpecSchema = z.strictObject({
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
});

export type ConnectorSpec = z.infer<typeof ConnectorSpecSchema> & {
  readonly title: string;
  readonly id: string;
};

/** Capitalise the first letter only: "newrelic" -> "Newrelic". Matches the README fixtures. */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
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
```

- [ ] **Step 4: Run tests**

Run: `bun test test/spec.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/spec.ts test/spec.test.ts
git commit -m "feat(spec): strict ConnectorSpec schema with derived defaults"
```

---

### Task 3: Spec validation — identifier uniqueness

**Files:**
- Create: `src/validate.ts`, `test/validate.test.ts`

**Interfaces:**
- Consumes: `ConnectorSpec` from Task 2
- Produces: `validateSpec(spec: ConnectorSpec): void` — throws on collision. Called by `generate()` in Task 13.

**Background:** The emitted module has one flat identifier namespace. `sentry` declares an accessor `org()`; a tool arg hoisted as `const org = ...` would shadow it and turn `${env.org}` into a call on a number. The check is a flat set-uniqueness test — deliberately stricter than reachability analysis, because it is far easier to trust.

- [ ] **Step 1: Write the failing test**

```ts
// test/validate.test.ts
import { describe, expect, it } from "bun:test";
import { parseSpec } from "../src/spec.ts";
import { validateSpec } from "../src/validate.ts";

function specWith(over: Record<string, unknown>) {
  return parseSpec({
    name: "sentry",
    displayName: "Sentry",
    description: "Sentry connector.",
    serviceLabel: "Sentry",
    style: "hand-rolled",
    env: [{ vars: ["SENTRY_ORG_SLUG"], local: "org", bindings: ["o"], required: true }],
    fetchHelper: { local: "sentryGet", base: "${env.org}" },
    tools: [],
    ...over,
  });
}

describe("validateSpec", () => {
  it("accepts a spec with no collisions", () => {
    expect(() => validateSpec(specWith({}))).not.toThrow();
  });

  it("rejects a hoisted arg local that shadows an env accessor", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "List issues.",
          args: { limit: { type: "number", optional: true, default: 20, local: "org" } },
          path: "/projects/${env.org}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/org/);
  });

  it("rejects two env accessors with the same local", () => {
    const s = specWith({
      env: [
        { vars: ["A"], local: "dup", bindings: ["a"], required: true },
        { vars: ["B"], local: "dup", bindings: ["b"], required: true },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/dup/);
  });

  it("rejects an env local colliding with a reserved emitter name", () => {
    const s = specWith({ env: [{ vars: ["A"], local: "reg", bindings: ["a"], required: true }] });
    expect(() => validateSpec(s)).toThrow(/reg/);
  });

  it("rejects a fetchHelper local colliding with an env local", () => {
    const s = specWith({ fetchHelper: { local: "org", base: "https://x" } });
    expect(() => validateSpec(s)).toThrow(/org/);
  });

  it("rejects duplicate tool names", () => {
    const t = { name: "dup_tool", description: "d.", path: "/a" };
    expect(() => validateSpec(specWith({ tools: [t, t] }))).toThrow(/dup_tool/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/validate.test.ts`
Expected: FAIL — cannot resolve `../src/validate.ts`.

- [ ] **Step 3: Implement `src/validate.ts`**

```ts
import type { ConnectorSpec } from "./spec.ts";

/** Identifiers the emitter itself introduces. A spec may never reuse one. */
export const RESERVED_IDENTIFIERS: readonly string[] = [
  "mcp",
  "server",
  "reg",
  "transport",
  "z",
  "jsonResult",
  "p",
  "parsed",
  "path",
  "pathPart",
  "res",
  "text",
  "McpServer",
  "StdioServerTransport",
  "createRegisterSimpleTool",
  "createZodToolRegistrar",
  "makeRestToolRegistrar",
  "requireProcessEnv",
];

function claim(seen: Map<string, string>, name: string, owner: string): void {
  const prior = seen.get(name);
  if (prior !== undefined) {
    throw new Error(
      `Identifier collision: "${name}" is used by both ${prior} and ${owner}. ` +
        `Rename one via its "local" field.`,
    );
  }
  seen.set(name, owner);
}

export function validateSpec(spec: ConnectorSpec): void {
  const seen = new Map<string, string>();

  for (const r of RESERVED_IDENTIFIERS) {
    seen.set(r, "a reserved emitter identifier");
  }

  for (const e of spec.env) {
    claim(seen, e.local, `env accessor for ${e.vars.join(", ")}`);
  }

  claim(seen, spec.fetchHelper.local, "the fetch helper");

  const toolNames = new Set<string>();
  for (const t of spec.tools) {
    if (toolNames.has(t.name)) {
      throw new Error(`Duplicate tool name: "${t.name}".`);
    }
    toolNames.add(t.name);

    for (const [argName, arg] of Object.entries(t.args)) {
      const local = arg.local ?? argName;
      const hoisted = arg.default !== undefined || arg.type === "boolean";
      if (hoisted) {
        claim(seen, local, `the hoisted argument "${argName}" of tool ${t.name}`);
      }
    }
  }
}
```

> Note: hoisted locals are claimed into the same flat namespace as module-scope names. Two *different* tools cannot reuse a hoisted local name even though their handler scopes are disjoint. That is intentional per the design's "one flat set-uniqueness check" rule; fixtures set distinct `local` values.

- [ ] **Step 4: Run tests**

Run: `bun test test/validate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts test/validate.test.ts
git commit -m "feat(validate): flat identifier-uniqueness check"
```

---

### Task 4: `formatAll` — Biome via WASM

**Files:**
- Create: `src/format.ts`, `test/format.test.ts`

**Interfaces:**
- Consumes: `GeneratedFile` from Task 1
- Produces:
  - `formatAll(files: readonly GeneratedFile[]): Promise<GeneratedFile[]>` — formats `.ts` files, passes others through unchanged
  - `biomeVersion(): Promise<string>` — resolved backend version, for the harness report

**Background:** Formatting must not shell out. `@biomejs/js-api` v6 with the `@biomejs/wasm-nodejs` backend runs in-process. Configuration is applied programmatically so there is no dependence on `biome.json` discovery or on `process.cwd()`.

- [ ] **Step 1: Write the failing test**

```ts
// test/format.test.ts
import { describe, expect, it } from "bun:test";
import { biomeVersion, formatAll } from "../src/format.ts";

describe("formatAll", () => {
  it("formats TypeScript to the Nimbus house style", () => {
    const [out] = formatAll([{ path: ["src", "server.ts"], content: "const x = {a:1,b:2}\n" }]);
    expect(out?.content).toBe("const x = { a: 1, b: 2 };\n");
  });

  it("leaves non-TypeScript files untouched", () => {
    const input = { path: ["README.md"], content: "#   Title\n\n\n" };
    const [out] = formatAll([input]);
    expect(out?.content).toBe(input.content);
  });

  it("preserves object expansion chosen by the emitter", () => {
    const expanded = "const r = await fetch(u, {\n  headers: h(),\n});\n";
    const inline = "const r = await fetch(u, { headers: h() });\n";
    const [a, b] = formatAll([
      { path: ["a.ts"], content: expanded },
      { path: ["b.ts"], content: inline },
    ]);
    expect(a?.content).toBe(expanded);
    expect(b?.content).toBe(inline);
  });

  it("breaks lines longer than 100 columns", () => {
    const long = `const value = someFunction(${"argument, ".repeat(12)}last);\n`;
    const [out] = formatAll([{ path: ["c.ts"], content: long }]);
    expect(out?.content.split("\n").every((l) => l.length <= 100)).toBe(true);
  });

  it("round-trips a newrelic-shaped concise-arrow registration unchanged", () => {
    const reg =
      'reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>\n' +
      '  jsonResult(await nrGet("/v2/applications.json")),\n);\n';
    expect(formatAll([{ path: ["d.ts"], content: reg }])[0]?.content).toBe(reg);
  });
});

describe("biomeVersion", () => {
  it("reports the resolved backend version", () => {
    expect(biomeVersion()).toMatch(/^2\.5\./);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/format.test.ts`
Expected: FAIL — cannot resolve `../src/format.ts`.

- [ ] **Step 3: Implement `src/format.ts`**

```ts
import { Biome } from "@biomejs/js-api/nodejs";
import { createRequire } from "node:module";
import type { GeneratedFile } from "./types.ts";

type Instance = { biome: Biome; projectKey: ReturnType<Biome["openProject"]>["projectKey"] };
let cached: Instance | undefined;

/**
 * Load the WASM backend once and apply the monorepo's formatter settings.
 *
 * js-api v6 is project-scoped: `openProject()` returns a key that every later
 * call must pass. The `/nodejs` subpath exports a synchronous constructor, so
 * no async init and no Distribution enum are needed.
 */
function instance(): Instance {
  if (cached === undefined) {
    const biome = new Biome();
    const { projectKey } = biome.openProject();
    biome.applyConfiguration(projectKey, {
      formatter: {
        enabled: true,
        indentStyle: "space",
        indentWidth: 2,
        lineWidth: 100,
        lineEnding: "lf",
      },
      javascript: {
        formatter: { quoteStyle: "double", trailingCommas: "all", semicolons: "always" },
      },
    });
    cached = { biome, projectKey };
  }
  return cached;
}

/** BiomeCommon exposes no version field; read it from the resolved backend package. */
export function biomeVersion(): string {
  const require = createRequire(import.meta.url);
  return (require("@biomejs/wasm-nodejs/package.json") as { version: string }).version;
}

export function formatAll(files: readonly GeneratedFile[]): GeneratedFile[] {
  const { biome, projectKey } = instance();
  return files.map((f) => {
    const name = f.path[f.path.length - 1] ?? "";
    if (!name.endsWith(".ts")) return { path: f.path, content: f.content };
    const { content } = biome.formatContent(projectKey, f.content, {
      filePath: f.path.join("/"),
    });
    return { path: f.path, content };
  });
}
```

> **Verified against the real packages under Bun 1.3.14** — `js-api@6.0.0` + `wasm-nodejs@2.5.6`. All three call shapes below are load-bearing and were wrong in an earlier draft of this plan:
> - `applyConfiguration` and `formatContent` both take **`projectKey` as their first argument**.
> - `openProject()` must be called to obtain that key.
> - There is **no `biome.version`** property.
>
> `formatAll` and `biomeVersion` are **synchronous** — the `/nodejs` constructor needs no await. Callers in Tasks 14 and 17 must not `await` them.

- [ ] **Step 4: Run tests**

Run: `bun test test/format.test.ts`
Expected: PASS (6 tests).

> Every assertion here was verified empirically against `js-api@6.0.0` + `wasm-nodejs@2.5.6` on Bun 1.3.14 before this plan was written. Do not weaken them — especially expansion-preservation, which is load-bearing for `grafana` in Task 15, and the `reg()` round-trip, which is the earliest signal that Task 14 can reach zero diff.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts test/format.test.ts
git commit -m "feat(format): in-process Biome WASM formatting"
```

---

### Task 5: Static file emitters

**Files:**
- Create: `src/emit/package-json.ts`, `src/emit/tsconfig.ts`, `src/emit/sandbox-test.ts`, `test/emit/static.test.ts`

**Interfaces:**
- Consumes: `ConnectorSpec`, `GeneratedFile`
- Produces: `emitPackageJson(spec)`, `emitTsconfig()`, `emitSandboxTest()` — each returns one `GeneratedFile`

**Reminder:** assert structure, never transcribed connector bytes.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/static.test.ts
import { describe, expect, it } from "bun:test";
import { emitPackageJson } from "../../src/emit/package-json.ts";
import { emitSandboxTest } from "../../src/emit/sandbox-test.ts";
import { emitTsconfig } from "../../src/emit/tsconfig.ts";
import { parseSpec } from "../../src/spec.ts";

const spec = parseSpec({
  name: "newrelic",
  displayName: "New Relic",
  description: "d.",
  serviceLabel: "New Relic",
  fetchHelper: { local: "nrGet", base: "https://api.newrelic.com" },
});

describe("emitPackageJson", () => {
  it("names the package nimbus-mcp-<name> and is AGPL", () => {
    const pkg = JSON.parse(emitPackageJson(spec).content);
    expect(pkg.name).toBe("nimbus-mcp-newrelic");
    expect(pkg.license).toBe("AGPL-3.0-only");
    expect(pkg.private).toBe(false);
    expect(pkg.type).toBe("module");
  });

  it("declares exactly the three connector dependencies", () => {
    const pkg = JSON.parse(emitPackageJson(spec).content);
    expect(pkg.dependencies).toEqual({
      "@modelcontextprotocol/sdk": "1.30.0",
      "@nimbus-dev/sdk": "^1.8.1",
      zod: "^4.4.2",
    });
  });

  it("ends with a trailing newline", () => {
    expect(emitPackageJson(spec).content.endsWith("}\n")).toBe(true);
  });
});

describe("emitTsconfig", () => {
  it("extends the monorepo base three levels up", () => {
    const cfg = JSON.parse(emitTsconfig().content);
    expect(cfg.extends).toBe("../../../tsconfig.base.json");
    expect(cfg.include).toEqual(["src/**/*"]);
  });
});

describe("emitSandboxTest", () => {
  it("is placed at test/sandbox.test.ts and gated on NIMBUS_TEST_HARNESS", () => {
    const f = emitSandboxTest();
    expect(f.path).toEqual(["test", "sandbox.test.ts"]);
    expect(f.content).toContain("NIMBUS_TEST_HARNESS");
    expect(f.content).toContain("runSandboxContractTests");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/static.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the three emitters**

```ts
// src/emit/package-json.ts
import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";

export function emitPackageJson(spec: ConnectorSpec): GeneratedFile {
  const pkg = {
    name: `nimbus-mcp-${spec.name}`,
    version: "0.1.0",
    private: false,
    license: "AGPL-3.0-only",
    type: "module",
    scripts: {
      typecheck: "tsc --noEmit",
      lint: "biome check src/",
      test: "bun test",
      clean: "rm -rf dist",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "1.30.0",
      "@nimbus-dev/sdk": "^1.8.1",
      zod: "^4.4.2",
    },
    devDependencies: { "@types/bun": "latest" },
  };
  return { path: ["package.json"], content: `${JSON.stringify(pkg, undefined, 2)}\n` };
}
```

```ts
// src/emit/tsconfig.ts
import type { GeneratedFile } from "../types.ts";

export function emitTsconfig(): GeneratedFile {
  const cfg = {
    extends: "../../../tsconfig.base.json",
    compilerOptions: { types: ["bun"] },
    include: ["src/**/*"],
    exclude: ["node_modules", "dist"],
  };
  return { path: ["tsconfig.json"], content: `${JSON.stringify(cfg, undefined, 2)}\n` };
}
```

```ts
// src/emit/sandbox-test.ts
import type { GeneratedFile } from "../types.ts";

/** The sandbox contract test is identical in 79 of 94 connectors — a constant, no substitutions. */
const SANDBOX_TEST = `import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandboxContractTests } from "@nimbus-dev/sdk/testing";

const manifestPath = resolve(fileURLToPath(import.meta.url), "../../nimbus.extension.json");

describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])("sandbox contract", () => {
  it("respects declared permissions", async () => {
    await expect(runSandboxContractTests(manifestPath)).resolves.toBeUndefined();
  });
});
`;

export function emitSandboxTest(): GeneratedFile {
  return { path: ["test", "sandbox.test.ts"], content: SANDBOX_TEST };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/emit/static.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/package-json.ts src/emit/tsconfig.ts src/emit/sandbox-test.ts test/emit/static.test.ts
git commit -m "feat(emit): package.json, tsconfig and sandbox test emitters"
```

---

### Task 6: Manifest and README emitters

**Files:**
- Create: `src/emit/manifest.ts`, `src/emit/readme.ts`, `test/emit/manifest.test.ts`, `test/emit/readme.test.ts`

**Interfaces:**
- Produces: `emitManifest(spec): GeneratedFile`, `emitReadme(spec): GeneratedFile`

**Background:** `bun run audit:package-readmes` requires these five H2 headings, case-insensitive, for the `public` tier: `What this is`, `Install`, `Quickstart`, `See also`, `License`. The `nimbus connector auth <slug>` slug always equals the directory name.

- [ ] **Step 1: Write the failing tests**

```ts
// test/emit/manifest.test.ts
import { describe, expect, it } from "bun:test";
import { emitManifest } from "../../src/emit/manifest.ts";
import { parseSpec } from "../../src/spec.ts";

const spec = parseSpec({
  name: "newrelic",
  displayName: "New Relic",
  description: "New Relic connector. Read-focused.",
  serviceLabel: "New Relic",
  network: ["api.newrelic.com", "api.eu.newrelic.com"],
  fetchHelper: { local: "nrGet", base: "https://api.newrelic.com" },
});

describe("emitManifest", () => {
  it("emits the required manifest fields", () => {
    const m = JSON.parse(emitManifest(spec).content);
    expect(m.id).toBe("com.nimbus.newrelic");
    expect(m.displayName).toBe("New Relic");
    expect(m.entrypoint).toBe("dist/server.js");
    expect(m.runtime).toBe("bun");
    expect(m.author).toBe("Nimbus");
    expect(m.version).toBe("0.1.0");
  });

  it("declares the network permission surface and an empty hitlRequired", () => {
    const m = JSON.parse(emitManifest(spec).content);
    expect(m.permissions).toEqual({ network: ["api.newrelic.com", "api.eu.newrelic.com"] });
    expect(m.hitlRequired).toEqual([]);
  });
});
```

```ts
// test/emit/readme.test.ts
import { describe, expect, it } from "bun:test";
import { emitReadme } from "../../src/emit/readme.ts";
import { parseSpec } from "../../src/spec.ts";

const spec = parseSpec({
  name: "newrelic",
  displayName: "New Relic",
  description: "d.",
  serviceLabel: "New Relic",
  fetchHelper: { local: "nrGet", base: "https://api.newrelic.com" },
});

function h2s(md: string): string[] {
  return [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());
}

describe("emitReadme", () => {
  it("carries every H2 that audit:package-readmes requires for the public tier", () => {
    expect(h2s(emitReadme(spec).content)).toEqual([
      "what this is",
      "install",
      "quickstart",
      "see also",
      "license",
    ]);
  });

  it("uses the derived title in the H1 and the directory name as the auth slug", () => {
    const md = emitReadme(spec).content;
    expect(md.startsWith("# Newrelic Connector\n")).toBe(true);
    expect(md).toContain("nimbus connector auth newrelic");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/emit/manifest.test.ts test/emit/readme.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both emitters**

```ts
// src/emit/manifest.ts
import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";

export function emitManifest(spec: ConnectorSpec): GeneratedFile {
  const manifest = {
    id: spec.id,
    displayName: spec.displayName,
    version: "0.1.0",
    description: spec.description,
    author: "Nimbus",
    entrypoint: "dist/server.js",
    runtime: "bun",
    permissions: { network: spec.network },
    hitlRequired: [] as string[],
    syncInterval: spec.syncInterval,
    minNimbusVersion: spec.minNimbusVersion,
  };
  return {
    path: ["nimbus.extension.json"],
    content: `${JSON.stringify(manifest, undefined, 2)}\n`,
  };
}
```

```ts
// src/emit/readme.ts
import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";

export function emitReadme(spec: ConnectorSpec): GeneratedFile {
  const t = spec.title;
  const content = `# ${t} Connector

## What this is

Nimbus MCP connector for ${t}. Indexes and provides context from ${t} to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

\`\`\`bash
nimbus connector auth ${spec.name}
nimbus ask "Summarize my recent activity in ${t}"
\`\`\`

## See also

- [${t} Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
`;
  return { path: ["README.md"], content };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/emit/`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/emit/manifest.ts src/emit/readme.ts test/emit/manifest.test.ts test/emit/readme.test.ts
git commit -m "feat(emit): manifest and README emitters"
```

---

### Task 7: Path template parser and renderer

**Files:**
- Create: `src/emit/server/path-template.ts`, `test/emit/server/path-template.test.ts`

**Interfaces:**
- Produces:
  - `type PathSegment = { kind: "literal"; text: string } | { kind: "env"; name: string } | { kind: "arg"; name: string; mode: ArgMode }`
  - `type ArgMode = "raw" | "enc" | "num" | "bool"`
  - `parsePathTemplate(tpl: string): PathSegment[]`
  - `renderPath(segments, ctx): string` where `ctx = { param: string; hoisted: ReadonlyMap<string, string> }` → a TypeScript template-literal expression **including** backticks, or a plain double-quoted string when there are no placeholders

**Background — the entire DSL.** `${env.X}` → `X()`. `${arg.X}` → the arg, rendered by mode: `raw` bare, `enc` wrapped in `encodeURIComponent(...)`, `num` in `String(...)`, `bool` bare (the hoist already produced a string). An arg that was hoisted renders as its local name; otherwise as `<param>.<name>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/server/path-template.test.ts
import { describe, expect, it } from "bun:test";
import { parsePathTemplate, renderPath } from "../../../src/emit/server/path-template.ts";

const noHoists = { param: "p", hoisted: new Map<string, string>() };

describe("parsePathTemplate", () => {
  it("returns a single literal when there are no placeholders", () => {
    expect(parsePathTemplate("/v2/applications.json")).toEqual([
      { kind: "literal", text: "/v2/applications.json" },
    ]);
  });

  it("parses env and arg placeholders with modes", () => {
    expect(parsePathTemplate("/p/${env.org}/${arg.slug}/x?l=${arg.limit|num}")).toEqual([
      { kind: "literal", text: "/p/" },
      { kind: "env", name: "org" },
      { kind: "literal", text: "/" },
      { kind: "arg", name: "slug", mode: "raw" },
      { kind: "literal", text: "/x?l=" },
      { kind: "arg", name: "limit", mode: "num" },
    ]);
  });

  it("rejects an unknown mode", () => {
    expect(() => parsePathTemplate("/x/${arg.a|nope}")).toThrow(/nope/);
  });

  it("rejects an unknown namespace", () => {
    expect(() => parsePathTemplate("/x/${cfg.a}")).toThrow(/cfg/);
  });
});

describe("renderPath", () => {
  it("renders a plain quoted string when there are no placeholders", () => {
    expect(renderPath(parsePathTemplate("/api/v1/monitor"), noHoists)).toBe('"/api/v1/monitor"');
  });

  it("renders env placeholders as accessor calls", () => {
    const out = renderPath(parsePathTemplate("/projects/${env.org}/releases/"), noHoists);
    expect(out).toBe("`/projects/${org()}/releases/`");
  });

  it("renders a non-hoisted arg via the handler param", () => {
    const out = renderPath(parsePathTemplate("/g/${arg.slug}/c"), noHoists);
    expect(out).toBe("`/g/${p.slug}/c`");
  });

  it("wraps num and enc modes", () => {
    const hoisted = new Map([["limit", "lim"]]);
    expect(renderPath(parsePathTemplate("?l=${arg.limit|num}"), { param: "p", hoisted })).toBe(
      "`?l=${String(lim)}`",
    );
    expect(renderPath(parsePathTemplate("?q=${arg.query|enc}"), noHoists)).toBe(
      "`?q=${encodeURIComponent(p.query)}`",
    );
  });

  it("renders a hoisted boolean as the bare local", () => {
    const hoisted = new Map([["only_open", "only"]]);
    expect(renderPath(parsePathTemplate("?o=${arg.only_open|bool}"), { param: "p", hoisted })).toBe(
      "`?o=${only}`",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/path-template.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/emit/server/path-template.ts`**

```ts
export type ArgMode = "raw" | "enc" | "num" | "bool";

export type PathSegment =
  | { kind: "literal"; text: string }
  | { kind: "env"; name: string }
  | { kind: "arg"; name: string; mode: ArgMode };

export type RenderContext = {
  /** Handler parameter name, "p" for hand-rolled and "parsed" for rest-kit. */
  readonly param: string;
  /** argName -> hoisted const name, for args lifted above the return. */
  readonly hoisted: ReadonlyMap<string, string>;
};

const MODES = new Set<string>(["raw", "enc", "num", "bool"]);
const PLACEHOLDER = /\$\{([a-z]+)\.([A-Za-z0-9_]+)(?:\|([a-z]+))?\}/g;

export function parsePathTemplate(tpl: string): PathSegment[] {
  const out: PathSegment[] = [];
  let last = 0;
  for (const m of tpl.matchAll(PLACEHOLDER)) {
    const [whole, ns, name, mode] = m;
    const at = m.index;
    if (at > last) out.push({ kind: "literal", text: tpl.slice(last, at) });
    if (ns === "env") {
      if (mode !== undefined) throw new Error(`env placeholder "${whole}" cannot take a mode`);
      out.push({ kind: "env", name: name! });
    } else if (ns === "arg") {
      const m2 = mode ?? "raw";
      if (!MODES.has(m2)) throw new Error(`Unknown placeholder mode "${m2}" in "${whole}"`);
      out.push({ kind: "arg", name: name!, mode: m2 as ArgMode });
    } else {
      throw new Error(`Unknown placeholder namespace "${ns}" in "${whole}"`);
    }
    last = at + whole.length;
  }
  if (last < tpl.length) out.push({ kind: "literal", text: tpl.slice(last) });
  return out;
}

function argExpression(seg: { name: string; mode: ArgMode }, ctx: RenderContext): string {
  const base = ctx.hoisted.get(seg.name) ?? `${ctx.param}.${seg.name}`;
  switch (seg.mode) {
    case "enc":
      return `encodeURIComponent(${base})`;
    case "num":
      return `String(${base})`;
    default:
      return base;
  }
}

/** Returns a TS expression: a double-quoted string, or a backticked template literal. */
export function renderPath(segments: readonly PathSegment[], ctx: RenderContext): string {
  const dynamic = segments.some((s) => s.kind !== "literal");
  if (!dynamic) {
    const text = segments.map((s) => (s.kind === "literal" ? s.text : "")).join("");
    return JSON.stringify(text);
  }
  const body = segments
    .map((s) => {
      if (s.kind === "literal") return s.text.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
      if (s.kind === "env") return `\${${s.name}()}`;
      return `\${${argExpression(s, ctx)}}`;
    })
    .join("");
  return `\`${body}\``;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/emit/server/path-template.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/server/path-template.ts test/emit/server/path-template.test.ts
git commit -m "feat(emit): path template parser and renderer"
```

---

### Task 8: Argument schema and hoist rendering

**Files:**
- Create: `src/emit/server/args.ts`, `test/emit/server/args.test.ts`

**Interfaces:**
- Consumes: `ToolSchema["args"]` from Task 2
- Produces:
  - `hoistedLocals(args): Map<string, string>` — argName → local, only for hoisted args
  - `renderZodSchema(args): string` — e.g. `z.object({ limit: z.number().int().min(1).max(50).optional() })`
  - `renderHoists(args, param): string[]` — one `const ...;` line per hoisted arg, in declaration order

**Background — the hoist rule.** An arg is hoisted iff it has a `default` **or** its type is `boolean`. Zod chain order, fixed: `z.<type>()` → `.int()` → `.min()` → `.max()` → `.optional()`.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/server/args.test.ts
import { describe, expect, it } from "bun:test";
import { hoistedLocals, renderHoists, renderZodSchema } from "../../../src/emit/server/args.ts";
import { ToolSchema } from "../../../src/spec.ts";

function args(raw: unknown) {
  return ToolSchema.parse({ name: "t", description: "d", args: raw, path: "/x" }).args;
}

describe("renderZodSchema", () => {
  it("renders an empty object for no args", () => {
    expect(renderZodSchema(args({}))).toBe("z.object({})");
  });

  it("renders a required string with a min", () => {
    expect(renderZodSchema(args({ projectSlug: { type: "string", min: 1 } }))).toBe(
      "z.object({ projectSlug: z.string().min(1) })",
    );
  });

  it("renders an optional bounded integer in fixed chain order", () => {
    const a = args({ limit: { type: "number", int: true, min: 1, max: 100, optional: true } });
    expect(renderZodSchema(a)).toBe(
      "z.object({ limit: z.number().int().min(1).max(100).optional() })",
    );
  });

  it("renders an optional boolean", () => {
    expect(renderZodSchema(args({ only_open: { type: "boolean", optional: true } }))).toBe(
      "z.object({ only_open: z.boolean().optional() })",
    );
  });
});

describe("hoistedLocals", () => {
  it("hoists defaulted args and booleans only", () => {
    const a = args({
      slug: { type: "string" },
      limit: { type: "number", optional: true, default: 20, local: "lim" },
      flag: { type: "boolean", optional: true, local: "only" },
    });
    expect([...hoistedLocals(a)]).toEqual([
      ["limit", "lim"],
      ["flag", "only"],
    ]);
  });

  it("defaults the local to the arg name", () => {
    const a = args({ limit: { type: "number", optional: true, default: 10 } });
    expect(hoistedLocals(a).get("limit")).toBe("limit");
  });
});

describe("renderHoists", () => {
  it("renders a numeric default with ??", () => {
    const a = args({ limit: { type: "number", optional: true, default: 10, local: "lim" } });
    expect(renderHoists(a, "p")).toEqual(["const lim = p.limit ?? 10;"]);
  });

  it("renders a string default with a quoted literal", () => {
    const a = args({ query: { type: "string", optional: true, default: "", local: "q" } });
    expect(renderHoists(a, "p")).toEqual(['const q = p.query ?? "";']);
  });

  it("renders a boolean as an explicit true/false string", () => {
    const a = args({ only_open: { type: "boolean", optional: true, local: "only" } });
    expect(renderHoists(a, "p")).toEqual([
      'const only = p.only_open === true ? "true" : "false";',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/args.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/emit/server/args.ts`**

```ts
import type { z } from "zod";
import type { ArgSchema } from "../../spec.ts";

type Arg = z.infer<typeof ArgSchema>;
type Args = Record<string, Arg>;

function isHoisted(a: Arg): boolean {
  return a.default !== undefined || a.type === "boolean";
}

export function hoistedLocals(args: Args): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, a] of Object.entries(args)) {
    if (isHoisted(a)) out.set(name, a.local ?? name);
  }
  return out;
}

function renderOne(a: Arg): string {
  let s = `z.${a.type}()`;
  if (a.type === "number" && a.int) s += ".int()";
  if (a.min !== undefined) s += `.min(${a.min})`;
  if (a.max !== undefined) s += `.max(${a.max})`;
  if (a.optional) s += ".optional()";
  return s;
}

export function renderZodSchema(args: Args): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "z.object({})";
  const fields = entries.map(([name, a]) => `${name}: ${renderOne(a)}`).join(", ");
  return `z.object({ ${fields} })`;
}

export function renderHoists(args: Args, param: string): string[] {
  const lines: string[] = [];
  for (const [name, a] of Object.entries(args)) {
    if (!isHoisted(a)) continue;
    const local = a.local ?? name;
    if (a.type === "boolean") {
      lines.push(`const ${local} = ${param}.${name} === true ? "true" : "false";`);
    } else {
      lines.push(`const ${local} = ${param}.${name} ?? ${JSON.stringify(a.default)};`);
    }
  }
  return lines;
}
```

> Object key order is insertion order for non-numeric string keys, so `Object.entries` preserves the order written in the spec JSON. Fixtures must list args in the order the real connector declares them.

- [ ] **Step 4: Run tests**

Run: `bun test test/emit/server/args.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/server/args.ts test/emit/server/args.test.ts
git commit -m "feat(emit): zod schema and hoist rendering for tool arguments"
```

---

### Task 9: Env accessor emitter

**Files:**
- Create: `src/emit/server/env.ts`, `test/emit/server/env.test.ts`

**Interfaces:**
- Produces: `renderEnvAccessor(entry: EnvEntry): string` — a complete `function` declaration
- Consumes: `EnvSchema` output from Task 2

**Background — the fixed pipeline.** `read → ?.trim() → (default XOR required check) → transform → prefix/suffix → auth wrapper`. Transform runs **before** prefix/suffix: `sentry` strips the trailing slash from the env value and only then appends `/api/0`, so the suffix's own characters are never stripped. Return type is `string`, or `Record<string, string>` when `auth` is set.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/server/env.test.ts
import { describe, expect, it } from "bun:test";
import { renderEnvAccessor } from "../../../src/emit/server/env.ts";
import { EnvSchema } from "../../../src/spec.ts";

const env = (raw: unknown) => EnvSchema.parse(raw);

describe("renderEnvAccessor", () => {
  it("renders a required string accessor", () => {
    const out = renderEnvAccessor(
      env({ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }),
    );
    expect(out).toBe(`function apiKey(): string {
  const k = process.env["NEW_RELIC_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("NEW_RELIC_API_KEY is not set");
  }
  return k;
}`);
  });

  it("applies transform before suffix", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["SENTRY_URL"],
        local: "apiRoot",
        bindings: ["u"],
        default: "https://sentry.io",
        transform: "stripTrailingSlash",
        suffix: "/api/0",
      }),
    );
    expect(out).toBe(`function apiRoot(): string {
  const u = process.env["SENTRY_URL"]?.trim() || "https://sentry.io";
  return \`\${u.replace(/\\/$/, "")}/api/0\`;
}`);
  });

  it("renders a defaulted accessor with a prefix", () => {
    const out = renderEnvAccessor(
      env({ vars: ["DD_SITE"], local: "siteHost", bindings: ["s"], default: "datadoghq.com", prefix: "api." }),
    );
    expect(out).toContain('const s = process.env["DD_SITE"]?.trim() || "datadoghq.com";');
    expect(out).toContain("return `api.${s}`;");
  });

  it("returns a bare expression when there is no prefix or suffix", () => {
    const out = renderEnvAccessor(
      env({ vars: ["GRAFANA_URL"], local: "baseUrl", bindings: ["u"], required: true, transform: "stripTrailingSlash" }),
    );
    expect(out).toContain('return u.replace(/\\/$/, "");');
    expect(out).not.toContain("`");
  });

  it("renders a bearer auth accessor", () => {
    const out = renderEnvAccessor(
      env({ vars: ["SENTRY_AUTH_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }),
    );
    expect(out).toBe(`function headers(): Record<string, string> {
  const t = process.env["SENTRY_AUTH_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("SENTRY_AUTH_TOKEN is not set");
  }
  return { Authorization: \`Bearer \${t}\`, Accept: "application/json" };
}`);
  });

  it("renders a multi-var header accessor with a joint error", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["DD_API_KEY", "DD_APP_KEY"],
        local: "headers",
        bindings: ["ak", "app"],
        auth: "headers",
        headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"],
      }),
    );
    expect(out).toContain(
      'if (ak === undefined || ak === "" || app === undefined || app === "") {',
    );
    expect(out).toContain('throw new Error("DD_API_KEY and DD_APP_KEY must be set");');
    expect(out).toContain('"DD-API-KEY": ak,');
    expect(out).toContain('"DD-APPLICATION-KEY": app,');
    expect(out).toContain("Accept: \"application/json\",");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/env.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/emit/server/env.ts`**

```ts
import type { z } from "zod";
import type { EnvSchema } from "../../spec.ts";

type EnvEntry = z.infer<typeof EnvSchema>;

const STRIP = 'replace(/\\/$/, "")';

function camel(varName: string): string {
  const parts = varName.toLowerCase().split("_");
  return parts[0]! + parts.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
}

function bindingOf(e: EnvEntry, i: number): string {
  return e.bindings?.[i] ?? camel(e.vars[i]!);
}

/** `<binding>.replace(...)` when a transform is set, else the bare binding. */
function transformed(e: EnvEntry, binding: string): string {
  return e.transform === "stripTrailingSlash" ? `${binding}.${STRIP}` : binding;
}

/** Wrap in a template literal only when a prefix or suffix exists. */
function wrapped(e: EnvEntry, expr: string): string {
  const hasAffix = e.prefix !== undefined || e.suffix !== undefined;
  if (!hasAffix) return expr;
  return `\`${e.prefix ?? ""}\${${expr}}${e.suffix ?? ""}\``;
}

function readLines(e: EnvEntry): string[] {
  return e.vars.map((v, i) => {
    const b = bindingOf(e, i);
    const read = `process.env[${JSON.stringify(v)}]?.trim()`;
    return e.default !== undefined
      ? `  const ${b} = ${read} || ${JSON.stringify(e.default)};`
      : `  const ${b} = ${read};`;
  });
}

function guardLines(e: EnvEntry): string[] {
  if (e.default !== undefined) return [];
  const needsGuard = e.required || e.auth !== undefined;
  if (!needsGuard) return [];
  const conds = e.vars
    .map((_, i) => {
      const b = bindingOf(e, i);
      return `${b} === undefined || ${b} === ""`;
    })
    .join(" || ");
  const message =
    e.vars.length === 1 ? `${e.vars[0]} is not set` : `${e.vars.join(" and ")} must be set`;
  return [`  if (${conds}) {`, `    throw new Error(${JSON.stringify(message)});`, `  }`];
}

function returnLines(e: EnvEntry): string[] {
  if (e.auth === "bearer") {
    const b = bindingOf(e, 0);
    return [`  return { Authorization: \`Bearer \${${b}}\`, Accept: "application/json" };`];
  }
  if (e.auth === "headers") {
    const entries = e.vars.map((_, i) => {
      const header = e.headerNames![i]!;
      return `    ${JSON.stringify(header)}: ${bindingOf(e, i)},`;
    });
    return ["  return {", ...entries, `    Accept: "application/json",`, "  };"];
  }
  return [`  return ${wrapped(e, transformed(e, bindingOf(e, 0)))};`];
}

export function renderEnvAccessor(e: EnvEntry): string {
  const returnType = e.auth === undefined ? "string" : "Record<string, string>";
  return [
    `function ${e.local}(): ${returnType} {`,
    ...readLines(e),
    ...guardLines(e),
    ...returnLines(e),
    "}",
  ].join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/emit/server/env.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/server/env.ts test/emit/server/env.test.ts
git commit -m "feat(emit): env accessor emitter with fixed transform pipeline"
```

---

### Task 10: Fetch helper emitter

**Files:**
- Create: `src/emit/server/fetch-helper.ts`, `test/emit/server/fetch-helper.test.ts`

**Interfaces:**
- Produces: `renderFetchHelper(spec: ConnectorSpec): string`

**★ Expansion matters.** `datadog`/`sentry` write `{ headers: headers() }` inline; `grafana` writes it expanded across three lines. Biome preserves both. The emitter expands the fetch options object iff `normalizeLeadingSlash` is set (the `grafana` shape) and inlines it otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/server/fetch-helper.test.ts
import { describe, expect, it } from "bun:test";
import { renderFetchHelper } from "../../../src/emit/server/fetch-helper.ts";
import { parseSpec } from "../../../src/spec.ts";

function make(over: Record<string, unknown>) {
  return parseSpec({
    name: "x",
    displayName: "X",
    description: "d.",
    serviceLabel: "X",
    style: "hand-rolled",
    fetchHelper: { local: "xGet", base: "https://x.test" },
    ...over,
  });
}

describe("renderFetchHelper", () => {
  it("renders inline headers against a literal base", () => {
    const out = renderFetchHelper(
      make({
        serviceLabel: "New Relic",
        fetchHelper: {
          local: "nrGet",
          base: "https://api.newrelic.com",
          inlineHeaders: { "X-Api-Key": "${env.apiKey}", Accept: "application/json" },
        },
      }),
    );
    expect(out).toContain("async function nrGet(path: string): Promise<unknown> {");
    expect(out).toContain("const res = await fetch(`https://api.newrelic.com${path}`, {");
    expect(out).toContain('headers: { "X-Api-Key": apiKey(), Accept: "application/json" },');
    expect(out).toContain(
      "throw new Error(`New Relic ${String(res.status)}: ${text.slice(0, 400)}`);",
    );
    expect(out).toContain("return JSON.parse(text) as unknown;");
  });

  it("inlines the options object when there is no leading-slash normalisation", () => {
    const out = renderFetchHelper(
      make({ serviceLabel: "Sentry", fetchHelper: { local: "sentryGet", base: "${env.apiRoot}", headers: "headers" } }),
    );
    expect(out).toContain("const res = await fetch(`${apiRoot()}${path}`, { headers: headers() });");
  });

  it("expands the options object and normalises the path when asked", () => {
    const out = renderFetchHelper(
      make({
        serviceLabel: "Grafana",
        fetchHelper: {
          local: "grafanaGet",
          base: "${env.baseUrl}",
          headers: "authHeaders",
          normalizeLeadingSlash: true,
          jsonFallbackRaw: true,
        },
      }),
    );
    expect(out).toContain('const pathPart = path.startsWith("/") ? path : `/${path}`;');
    expect(out).toContain("const res = await fetch(`${baseUrl()}${pathPart}`, {\n    headers: authHeaders(),\n  });");
    expect(out).toContain("  try {\n    return JSON.parse(text) as unknown;\n  } catch {\n    return { raw: text };\n  }");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/fetch-helper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/emit/server/fetch-helper.ts`**

```ts
import type { ConnectorSpec } from "../../spec.ts";

/** Replace ${env.X} with X() inside a base or header template. */
function resolveEnvRefs(tpl: string): string {
  return tpl.replaceAll(/\$\{env\.([A-Za-z0-9_]+)\}/g, "${$1()}");
}

function headerOption(spec: ConnectorSpec): string {
  const fh = spec.fetchHelper;
  if (fh.inlineHeaders !== undefined) {
    const fields = Object.entries(fh.inlineHeaders)
      .map(([k, v]) => {
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        const inner = /^\$\{env\.[A-Za-z0-9_]+\}$/.test(v)
          ? resolveEnvRefs(v).slice(2, -1)
          : JSON.stringify(v);
        return `${key}: ${inner}`;
      })
      .join(", ");
    return `headers: { ${fields} }`;
  }
  return `headers: ${fh.headers}()`;
}

export function renderFetchHelper(spec: ConnectorSpec): string {
  const fh = spec.fetchHelper;
  const pathVar = fh.normalizeLeadingSlash ? "pathPart" : "path";
  const url = `\`${resolveEnvRefs(fh.base)}\${${pathVar}}\``;
  const opts = headerOption(spec);

  const lines: string[] = [`async function ${fh.local}(path: string): Promise<unknown> {`];

  if (fh.normalizeLeadingSlash) {
    lines.push('  const pathPart = path.startsWith("/") ? path : `/${path}`;');
    // Expanded form — Biome preserves this, matching grafana.
    lines.push(`  const res = await fetch(${url}, {`, `    ${opts},`, `  });`);
  } else {
    lines.push(`  const res = await fetch(${url}, { ${opts} });`);
  }

  lines.push(
    "  const text = await res.text();",
    "  if (!res.ok) {",
    `    throw new Error(\`${spec.serviceLabel} \${String(res.status)}: \${text.slice(0, 400)}\`);`,
    "  }",
  );

  if (fh.jsonFallbackRaw) {
    lines.push(
      "  try {",
      "    return JSON.parse(text) as unknown;",
      "  } catch {",
      "    return { raw: text };",
      "  }",
    );
  } else {
    lines.push("  return JSON.parse(text) as unknown;");
  }

  lines.push("}");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/emit/server/fetch-helper.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/server/fetch-helper.ts test/emit/server/fetch-helper.test.ts
git commit -m "feat(emit): fetch helper emitter with explicit object expansion"
```

---

### Task 11: Style H tool registrations

**Files:**
- Create: `src/emit/server/tools-hand.ts`, `test/emit/server/tools-hand.test.ts`

**Interfaces:**
- Produces: `renderHandRolledTools(spec: ConnectorSpec): string`

**Background — body form.** No hoisted consts → concise arrow, `async () =>` when the tool has no args and `async (p) =>` when it does. Any hoisted const → block body ending in `return`. Handler param is `p`. Stubs throw.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/server/tools-hand.test.ts
import { describe, expect, it } from "bun:test";
import { renderHandRolledTools } from "../../../src/emit/server/tools-hand.ts";
import { parseSpec } from "../../../src/spec.ts";

function make(tools: unknown[]) {
  return parseSpec({
    name: "nr",
    displayName: "NR",
    description: "d.",
    serviceLabel: "New Relic",
    style: "hand-rolled",
    fetchHelper: { local: "nrGet", base: "https://api.newrelic.com" },
    tools,
  });
}

describe("renderHandRolledTools", () => {
  it("renders a no-arg tool as a concise arrow with no parameter", () => {
    const out = renderHandRolledTools(
      make([{ name: "nr_app_list", description: "List APM applications.", path: "/v2/applications.json" }]),
    );
    expect(out).toBe(
      'reg("nr_app_list", "List APM applications.", z.object({}), async () =>\n' +
        '  jsonResult(await nrGet("/v2/applications.json")),\n);',
    );
  });

  it("renders an arg tool with no hoists as a concise arrow taking p", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "s_release_list",
          description: "List releases for a project.",
          args: { projectSlug: { type: "string", min: 1 } },
          path: "/projects/${arg.projectSlug}/releases/",
        },
      ]),
    );
    expect(out).toContain(
      "async (p) => jsonResult(await nrGet(`/projects/${p.projectSlug}/releases/`)),",
    );
  });

  it("renders a hoisting tool as a block body", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "nr_alert_violations",
          description: "List recent alert violations.",
          args: { only_open: { type: "boolean", optional: true, local: "only" } },
          path: "/v2/alerts_violations.json?only_open=${arg.only_open|bool}",
        },
      ]),
    );
    expect(out).toContain("async (p) => {");
    expect(out).toContain('const only = p.only_open === true ? "true" : "false";');
    expect(out).toContain(
      "return jsonResult(await nrGet(`/v2/alerts_violations.json?only_open=${only}`));",
    );
  });

  it("renders a stub tool that throws", () => {
    const out = renderHandRolledTools(
      make([{ name: "nr_write", description: "Write.", impl: "stub" }]),
    );
    expect(out).toContain('throw new Error("nr_write is not implemented");');
  });

  it("separates multiple tools with a blank line", () => {
    const out = renderHandRolledTools(
      make([
        { name: "a", description: "A.", path: "/a" },
        { name: "b", description: "B.", path: "/b" },
      ]),
    );
    expect(out.split("\n\n").length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/tools-hand.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/emit/server/tools-hand.ts`**

```ts
import type { ConnectorSpec } from "../../spec.ts";
import { hoistedLocals, renderHoists, renderZodSchema } from "./args.ts";
import { parsePathTemplate, renderPath } from "./path-template.ts";

const PARAM = "p";

function renderTool(spec: ConnectorSpec, tool: ConnectorSpec["tools"][number]): string {
  const schema = renderZodSchema(tool.args);
  const head = `${JSON.stringify(tool.name)}, ${JSON.stringify(tool.description)}, ${schema}`;
  const hasArgs = Object.keys(tool.args).length > 0;

  if (tool.impl === "stub") {
    return [
      "reg(",
      `  ${JSON.stringify(tool.name)},`,
      `  ${JSON.stringify(tool.description)},`,
      `  ${schema},`,
      `  async (${hasArgs ? PARAM : ""}) => {`,
      `    throw new Error(${JSON.stringify(`${tool.name} is not implemented`)});`,
      "  },",
      ");",
    ].join("\n");
  }

  if (tool.path === undefined) {
    throw new Error(`Tool "${tool.name}" has impl "get" but no "path".`);
  }

  const hoisted = hoistedLocals(tool.args);
  const pathExpr = renderPath(parsePathTemplate(tool.path), { param: PARAM, hoisted });
  const call = `jsonResult(await ${spec.fetchHelper.local}(${pathExpr}))`;

  if (hoisted.size === 0) {
    const param = hasArgs ? `(${PARAM})` : "()";
    return `reg(${head}, async ${param} =>\n  ${call},\n);`;
  }

  const hoists = renderHoists(tool.args, PARAM).map((l) => `    ${l}`);
  return [
    "reg(",
    `  ${JSON.stringify(tool.name)},`,
    `  ${JSON.stringify(tool.description)},`,
    `  ${schema},`,
    `  async (${PARAM}) => {`,
    ...hoists,
    `    return ${call};`,
    "  },",
    ");",
  ].join("\n");
}

export function renderHandRolledTools(spec: ConnectorSpec): string {
  return spec.tools.map((t) => renderTool(spec, t)).join("\n\n");
}
```

> Biome will re-wrap the concise-arrow form as needed; the emitter only has to produce valid, semantically correct code with the right *object expansion*. Line breaking inside call arguments is Biome's job.

- [ ] **Step 4: Run tests**

Run: `bun test test/emit/server/tools-hand.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/server/tools-hand.ts test/emit/server/tools-hand.test.ts
git commit -m "feat(emit): hand-rolled style tool registrations"
```

---

### Task 12: Style R tool registrations

**Files:**
- Create: `src/emit/server/tools-rest.ts`, `test/emit/server/tools-rest.test.ts`

**Interfaces:**
- Produces: `renderRestKitTools(spec: ConnectorSpec): string` — the `makeRestToolRegistrar` block followed by the registrations

**Background.** Handler param is `parsed`. The registrar is named `register<Title>Tool` with `Title` = `spec.title` stripped of non-alphanumerics. `tokenEnv` is the single var of the env entry whose `auth` is set. Body is a `buildPath` lambda returning the path, not a full handler.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/server/tools-rest.test.ts
import { describe, expect, it } from "bun:test";
import { renderRestKitTools } from "../../../src/emit/server/tools-rest.ts";
import { parseSpec } from "../../../src/spec.ts";

const spec = parseSpec({
  name: "discord",
  title: "Discord",
  displayName: "Discord",
  description: "d.",
  serviceLabel: "Discord",
  style: "rest-kit",
  env: [{ vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" }],
  fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
  tools: [
    { name: "discord_guild_list", description: "List guilds the bot is a member of.", path: "/users/@me/guilds" },
    {
      name: "discord_channel_list",
      description: "List channels in a guild (id, type, name).",
      args: { guildId: { type: "string", min: 1 } },
      path: "/guilds/${arg.guildId|enc}/channels",
    },
  ],
});

describe("renderRestKitTools", () => {
  it("emits the registrar factory block", () => {
    const out = renderRestKitTools(spec);
    expect(out).toContain("const registerDiscordTool = makeRestToolRegistrar({");
    expect(out).toContain("  registrar: reg,");
    expect(out).toContain('  tokenEnv: "DISCORD_BOT_TOKEN",');
    expect(out).toContain('  serviceLabel: "Discord",');
    expect(out).toContain("  fetch: discordFetch,");
    expect(out).toContain("});");
  });

  it("emits a no-arg tool with an empty lambda", () => {
    expect(renderRestKitTools(spec)).toContain('  () => "/users/@me/guilds",');
  });

  it("emits an arg tool using the parsed parameter", () => {
    expect(renderRestKitTools(spec)).toContain(
      "  (parsed) => `/guilds/${encodeURIComponent(parsed.guildId)}/channels`,",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/tools-rest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/emit/server/tools-rest.ts`**

```ts
import type { ConnectorSpec } from "../../spec.ts";
import { hoistedLocals, renderHoists, renderZodSchema } from "./args.ts";
import { parsePathTemplate, renderPath } from "./path-template.ts";

const PARAM = "parsed";

export function registrarName(spec: ConnectorSpec): string {
  return `register${spec.title.replaceAll(/[^A-Za-z0-9]/g, "")}Tool`;
}

function tokenEnvVar(spec: ConnectorSpec): string {
  const authEntry = spec.env.find((e) => e.auth !== undefined);
  if (authEntry === undefined) {
    throw new Error('style "rest-kit" requires one env entry with an "auth" field.');
  }
  return authEntry.vars[0]!;
}

function renderTool(spec: ConnectorSpec, tool: ConnectorSpec["tools"][number]): string {
  const name = registrarName(spec);
  const schema = renderZodSchema(tool.args);
  const hasArgs = Object.keys(tool.args).length > 0;
  const head = [
    `${name}(`,
    `  ${JSON.stringify(tool.name)},`,
    `  ${JSON.stringify(tool.description)},`,
    `  ${schema},`,
  ];

  if (tool.impl === "stub") {
    return [
      ...head,
      `  () => {`,
      `    throw new Error(${JSON.stringify(`${tool.name} is not implemented`)});`,
      "  },",
      ");",
    ].join("\n");
  }

  if (tool.path === undefined) {
    throw new Error(`Tool "${tool.name}" has impl "get" but no "path".`);
  }

  const hoisted = hoistedLocals(tool.args);
  const pathExpr = renderPath(parsePathTemplate(tool.path), { param: PARAM, hoisted });
  const param = hasArgs ? `(${PARAM})` : "()";

  if (hoisted.size === 0) {
    return [...head, `  ${param} => ${pathExpr},`, ");"].join("\n");
  }

  const hoists = renderHoists(tool.args, PARAM).map((l) => `    ${l}`);
  return [...head, `  ${param} => {`, ...hoists, `    return ${pathExpr};`, "  },", ");"].join("\n");
}

export function renderRestKitTools(spec: ConnectorSpec): string {
  const factory = [
    `const ${registrarName(spec)} = makeRestToolRegistrar({`,
    "  registrar: reg,",
    `  tokenEnv: ${JSON.stringify(tokenEnvVar(spec))},`,
    `  serviceLabel: ${JSON.stringify(spec.serviceLabel)},`,
    `  fetch: ${spec.fetchHelper.local},`,
    "});",
  ].join("\n");

  return [factory, ...spec.tools.map((t) => renderTool(spec, t))].join("\n\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/emit/server/tools-rest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/server/tools-rest.ts test/emit/server/tools-rest.test.ts
git commit -m "feat(emit): rest-tool-kit style tool registrations"
```

---

### Task 13: Compose `server.ts` and `generate()`

**Files:**
- Create: `src/emit/server/index.ts`, `src/emit/index.ts`, `test/emit/generate.test.ts`

**Interfaces:**
- Produces:
  - `emitServer(spec: ConnectorSpec): GeneratedFile`
  - `generate(spec: ConnectorSpec): GeneratedFile[]` — validates, then emits all six files
- Consumes: every emitter from Tasks 5–12, `validateSpec` from Task 3

**Background — import blocks.** Style H imports `McpServer`, `StdioServerTransport`, `z`, then a blank line, then `createRegisterSimpleTool`, `createZodToolRegistrar`, `mcpJsonResult as jsonResult` from `../../shared/mcp-tool-kit.ts`. Style R additionally imports `makeRestToolRegistrar` from `../../shared/rest-tool-kit.ts`. The server variable is `mcp` for Style H and `server` for Style R.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/generate.test.ts
import { describe, expect, it } from "bun:test";
import { generate } from "../../src/emit/index.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

const spec = parseSpec({
  name: "newrelic",
  displayName: "New Relic",
  description: "d.",
  serviceLabel: "New Relic",
  style: "hand-rolled",
  network: ["api.newrelic.com"],
  env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }],
  fetchHelper: {
    local: "nrGet",
    base: "https://api.newrelic.com",
    inlineHeaders: { "X-Api-Key": "${env.apiKey}", Accept: "application/json" },
  },
  tools: [{ name: "newrelic_application_list", description: "List APM applications.", path: "/v2/applications.json" }],
});

describe("generate", () => {
  it("emits exactly the six-file connector tree", () => {
    expect(generate(spec).map((f) => displayPath(f.path)).sort()).toEqual([
      "README.md",
      "nimbus.extension.json",
      "package.json",
      "src/server.ts",
      "test/sandbox.test.ts",
      "tsconfig.json",
    ]);
  });

  it("wires the hand-rolled server with relative shared imports", () => {
    const src = generate(spec).find((f) => displayPath(f.path) === "src/server.ts")!.content;
    expect(src).toContain('import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";');
    expect(src).toContain('} from "../../shared/mcp-tool-kit.ts";');
    expect(src).toContain('const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });');
    expect(src).toContain("const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));");
    expect(src).toContain("const transport = new StdioServerTransport();");
    expect(src).toContain("await mcp.connect(transport);");
  });

  it("uses server/rest-tool-kit wiring for rest-kit style", () => {
    const restSpec = parseSpec({
      ...JSON.parse(JSON.stringify({ ...spec, title: undefined, id: undefined })),
      style: "rest-kit",
      env: [{ vars: ["NR_TOKEN"], local: "hdrs", bindings: ["t"], auth: "bearer" }],
    });
    const src = generate(restSpec).find((f) => displayPath(f.path) === "src/server.ts")!.content;
    expect(src).toContain('} from "../../shared/rest-tool-kit.ts";');
    expect(src).toContain('const server = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });');
    expect(src).toContain("await server.connect(transport);");
  });

  it("propagates validation failures", () => {
    const bad = parseSpec({ ...spec, fetchHelper: { local: "apiKey", base: "https://x" } });
    expect(() => generate(bad)).toThrow(/apiKey/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/generate.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/emit/server/index.ts`**

```ts
import type { ConnectorSpec } from "../../spec.ts";
import type { GeneratedFile } from "../../types.ts";
import { renderEnvAccessor } from "./env.ts";
import { renderFetchHelper } from "./fetch-helper.ts";
import { renderHandRolledTools } from "./tools-hand.ts";
import { renderRestKitTools } from "./tools-rest.ts";

function imports(spec: ConnectorSpec): string {
  const head = [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    'import { z } from "zod";',
    "",
  ];
  if (spec.style === "hand-rolled") {
    head.push(
      "import {",
      "  createRegisterSimpleTool,",
      "  createZodToolRegistrar,",
      "  mcpJsonResult as jsonResult,",
      '} from "../../shared/mcp-tool-kit.ts";',
    );
  } else {
    head.push(
      'import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
      'import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";',
    );
  }
  return head.join("\n");
}

function wiring(spec: ConnectorSpec): string {
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return [
    `const ${v} = new McpServer({ name: "nimbus-${spec.name}", version: "0.1.0" });`,
    `const reg = createZodToolRegistrar(createRegisterSimpleTool(${v}));`,
  ].join("\n");
}

function tail(spec: ConnectorSpec): string {
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return ["const transport = new StdioServerTransport();", `await ${v}.connect(transport);`].join("\n");
}

export function emitServer(spec: ConnectorSpec): GeneratedFile {
  const sections = [
    imports(spec),
    ...spec.env.map((e) => renderEnvAccessor(e)),
    renderFetchHelper(spec),
    wiring(spec),
    spec.style === "hand-rolled" ? renderHandRolledTools(spec) : renderRestKitTools(spec),
    tail(spec),
  ].filter((s) => s.trim() !== "");

  return { path: ["src", "server.ts"], content: `${sections.join("\n\n")}\n` };
}
```

- [ ] **Step 4: Implement `src/emit/index.ts`**

```ts
import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import { validateSpec } from "../validate.ts";
import { emitManifest } from "./manifest.ts";
import { emitPackageJson } from "./package-json.ts";
import { emitReadme } from "./readme.ts";
import { emitSandboxTest } from "./sandbox-test.ts";
import { emitServer } from "./server/index.ts";
import { emitTsconfig } from "./tsconfig.ts";

/** Pure. Returns UNFORMATTED files — callers pass the result through formatAll(). */
export function generate(spec: ConnectorSpec): GeneratedFile[] {
  validateSpec(spec);
  return [
    emitServer(spec),
    emitSandboxTest(),
    emitPackageJson(spec),
    emitManifest(spec),
    emitTsconfig(),
    emitReadme(spec),
  ];
}
```

- [ ] **Step 5: Run tests**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/emit/server/index.ts src/emit/index.ts test/emit/generate.test.ts
git commit -m "feat(emit): compose server.ts and the generate() entry point"
```

---

### Task 14: Diff harness and the `newrelic` fixture

**Files:**
- Create: `scripts/diff-golden.ts`, `fixtures/newrelic.spec.json`, `test/golden/resolve.test.ts`, `src/golden/resolve.ts`

**Interfaces:**
- Produces:
  - `resolveNimbusRoot(opts: { flag?: string; env?: string; scriptDir: string }): string` — throws with all attempted paths
  - `scripts/diff-golden.ts` CLI: `bun run diff:golden [fixture...] [--nimbus-root <path>]`

**Background.** Marker file `packages/mcp-connectors/shared/mcp-tool-kit.ts` proves a candidate is a Nimbus checkout. Exit 1 when the monorepo is absent — never skip silently.

- [ ] **Step 1: Write the failing resolver test**

```ts
// test/golden/resolve.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNimbusRoot } from "../../src/golden/resolve.ts";

function fakeNimbus(): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-"));
  mkdirSync(join(root, "packages", "mcp-connectors", "shared"), { recursive: true });
  writeFileSync(join(root, "packages", "mcp-connectors", "shared", "mcp-tool-kit.ts"), "");
  return root;
}

describe("resolveNimbusRoot", () => {
  it("prefers the explicit flag", () => {
    const root = fakeNimbus();
    expect(resolveNimbusRoot({ flag: root, scriptDir: "/nowhere" })).toBe(root);
  });

  it("falls back to the environment variable", () => {
    const root = fakeNimbus();
    expect(resolveNimbusRoot({ env: root, scriptDir: "/nowhere" })).toBe(root);
  });

  it("rejects a path that exists but lacks the marker file", () => {
    const empty = mkdtempSync(join(tmpdir(), "empty-"));
    expect(() => resolveNimbusRoot({ flag: empty, scriptDir: "/nowhere" })).toThrow(/marker/i);
  });

  it("lists every attempted path when nothing resolves", () => {
    expect(() => resolveNimbusRoot({ scriptDir: "/nowhere" })).toThrow(/tried/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/golden/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/golden/resolve.ts`**

```ts
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const MARKER = join("packages", "mcp-connectors", "shared", "mcp-tool-kit.ts");

export type ResolveOptions = {
  readonly flag?: string;
  readonly env?: string;
  /** Directory of the running script; siblings are probed relative to this, not cwd. */
  readonly scriptDir: string;
};

export function resolveNimbusRoot(opts: ResolveOptions): string {
  const tried: string[] = [];
  const candidates: { path: string; source: string }[] = [];

  if (opts.flag !== undefined) candidates.push({ path: resolve(opts.flag), source: "--nimbus-root" });
  if (opts.env !== undefined && opts.env !== "") {
    candidates.push({ path: resolve(opts.env), source: "$NIMBUS_ROOT" });
  }
  for (const name of ["Nimbus", "nimbus"]) {
    candidates.push({ path: resolve(opts.scriptDir, "..", "..", name), source: "sibling directory" });
  }

  for (const c of candidates) {
    if (!existsSync(c.path)) {
      tried.push(`  ${c.path}  (${c.source}) — does not exist`);
      continue;
    }
    if (!existsSync(join(c.path, MARKER))) {
      if (c.source === "--nimbus-root" || c.source === "$NIMBUS_ROOT") {
        throw new Error(
          `${c.path} (${c.source}) exists but is not a Nimbus checkout — marker file missing: ${MARKER}`,
        );
      }
      tried.push(`  ${c.path}  (${c.source}) — marker file missing: ${MARKER}`);
      continue;
    }
    return c.path;
  }

  throw new Error(
    `Could not locate the Nimbus monorepo. Tried:\n${tried.join("\n")}\n\n` +
      `Pass --nimbus-root <path> or set NIMBUS_ROOT.`,
  );
}
```

- [ ] **Step 4: Write `fixtures/newrelic.spec.json`**

```json
{
  "name": "newrelic",
  "title": "Newrelic",
  "displayName": "New Relic",
  "description": "New Relic NerdGraph + REST connector (alerts, incidents, dashboards). Read-focused.",
  "serviceLabel": "New Relic",
  "style": "hand-rolled",
  "network": ["api.newrelic.com", "api.eu.newrelic.com"],
  "syncInterval": 300,
  "minNimbusVersion": "0.2.0",
  "env": [
    { "vars": ["NEW_RELIC_API_KEY"], "local": "apiKey", "bindings": ["k"], "required": true }
  ],
  "fetchHelper": {
    "local": "nrGet",
    "base": "https://api.newrelic.com",
    "inlineHeaders": { "X-Api-Key": "${env.apiKey}", "Accept": "application/json" }
  },
  "tools": [
    {
      "name": "newrelic_application_list",
      "description": "List APM applications.",
      "path": "/v2/applications.json"
    },
    {
      "name": "newrelic_alert_violations",
      "description": "List recent alert violations.",
      "args": { "only_open": { "type": "boolean", "optional": true, "local": "only" } },
      "path": "/v2/alerts_violations.json?only_open=${arg.only_open|bool}"
    }
  ]
}
```

- [ ] **Step 5: Implement `scripts/diff-golden.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../src/emit/index.ts";
import { biomeVersion, formatAll } from "../src/format.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { parseSpec } from "../src/spec.ts";
import { displayPath, type GeneratedFile } from "../src/types.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, "..", "fixtures");

function parseArgs(argv: string[]): { names: string[]; nimbusRoot?: string } {
  const names: string[] = [];
  let nimbusRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nimbus-root") {
      nimbusRoot = argv[++i];
    } else if (argv[i]?.startsWith("--")) {
      throw new Error(`Unknown flag: ${argv[i]}`);
    } else {
      names.push(argv[i]!);
    }
  }
  return { names, nimbusRoot };
}

function unifiedDiff(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      if (e[i] !== undefined) out.push(`    - ${e[i]}`);
      if (a[i] !== undefined) out.push(`    + ${a[i]}`);
    }
  }
  return out.slice(0, 40).join("\n");
}

async function main(): Promise<void> {
  const { names, nimbusRoot } = parseArgs(process.argv.slice(2));
  const root = resolveNimbusRoot({
    flag: nimbusRoot,
    env: process.env["NIMBUS_ROOT"],
    scriptDir,
  });

  const all = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".spec.json"))
    .map((f) => f.replace(/\.spec\.json$/, ""));
  const selected = names.length > 0 ? names : all;

  console.log(`Nimbus root: ${root}`);
  console.log(`Biome:       ${biomeVersion()}\n`);

  let failures = 0;

  for (const name of selected) {
    const spec = parseSpec(JSON.parse(readFileSync(join(fixturesDir, `${name}.spec.json`), "utf8")));
    const files: GeneratedFile[] = formatAll(generate(spec));
    const realDir = join(root, "packages", "mcp-connectors", name);

    const stubs = spec.tools.filter((t) => t.impl === "stub").length;
    let identical = 0;
    const problems: string[] = [];

    for (const f of files) {
      const rel = displayPath(f.path);
      let expected: string;
      try {
        expected = readFileSync(join(realDir, ...f.path), "utf8").replaceAll("\r\n", "\n");
      } catch {
        problems.push(`  MISSING  ${rel} — not present in the real connector`);
        continue;
      }
      if (expected === f.content) {
        identical++;
      } else {
        problems.push(`  DIFF     ${rel}\n${unifiedDiff(expected, f.content)}`);
      }
    }

    const ok = problems.length === 0;
    if (!ok) failures++;
    const stubNote = stubs > 0 ? `, ${stubs} stub tool(s)` : "";
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}  ${identical}/${files.length} files identical${stubNote}`,
    );
    for (const p of problems) console.log(p);
  }

  if (failures > 0) {
    console.log(`\n${failures} fixture(s) differ.`);
    process.exit(1);
  }
  console.log("\nAll fixtures byte-identical.");
}

await main();
```

- [ ] **Step 6: Run the resolver tests, then the harness**

Run: `bun test test/golden/resolve.test.ts`
Expected: PASS (4 tests).

Run: `bun run diff:golden newrelic --nimbus-root C:\gitrep\Nimbus`
Expected: prints a per-file report. It will very likely FAIL on the first run — that is the point. Iterate on the emitters until it prints `PASS newrelic 6/6 files identical`. Do **not** change the fixture spec to paper over an emitter bug; the spec must describe the connector honestly.

- [ ] **Step 7: Verify the failure mode**

Run: `bun run diff:golden newrelic --nimbus-root C:\definitely\not\here`
Expected: exits **1** with a message naming the marker file. It must not skip or pass.

- [ ] **Step 8: Commit**

```bash
git add src/golden/resolve.ts scripts/diff-golden.ts fixtures/newrelic.spec.json test/golden/resolve.test.ts
git commit -m "feat(golden): diff harness and newrelic fixture at zero diff"
```

---

### Task 15: `datadog`, `grafana` and `sentry` fixtures to zero diff

**Files:**
- Create: `fixtures/datadog.spec.json`, `fixtures/grafana.spec.json`, `fixtures/sentry.spec.json`
- Modify: emitters under `src/emit/server/` as the diffs require

**Interfaces:** none new — this task drives the existing emitters to correctness.

**Background.** These three exercise the axes `newrelic` does not: defaulted env vars, multi-var joint-error accessors, `stripTrailingSlash`, prefix and suffix, an env value interpolated as a path segment, `encodeURIComponent`, numeric defaults, expanded fetch options, and the JSON-parse fallback.

- [ ] **Step 1: Write `fixtures/datadog.spec.json`**

```json
{
  "name": "datadog",
  "title": "Datadog",
  "displayName": "Datadog",
  "description": "Datadog connector (monitors, incidents). Read-focused.",
  "serviceLabel": "Datadog",
  "style": "hand-rolled",
  "network": ["api.datadoghq.com", "api.datadoghq.eu"],
  "env": [
    { "vars": ["DD_SITE"], "local": "siteHost", "bindings": ["s"], "default": "datadoghq.com", "prefix": "api." },
    {
      "vars": ["DD_API_KEY", "DD_APP_KEY"],
      "local": "headers",
      "bindings": ["ak", "app"],
      "auth": "headers",
      "headerNames": ["DD-API-KEY", "DD-APPLICATION-KEY"]
    }
  ],
  "fetchHelper": { "local": "ddGet", "base": "https://${env.siteHost}", "headers": "headers" },
  "tools": [
    { "name": "datadog_monitor_list", "description": "List monitors.", "path": "/api/v1/monitor" },
    {
      "name": "datadog_incident_list",
      "description": "List incidents (v2).",
      "args": { "limit": { "type": "number", "int": true, "min": 1, "max": 50, "optional": true, "default": 10, "local": "lim" } },
      "path": "/api/v2/incidents?page[size]=${arg.limit|num}"
    }
  ]
}
```

- [ ] **Step 2: Run the harness for datadog**

Run: `bun run diff:golden datadog --nimbus-root C:\gitrep\Nimbus`
Expected: iterate the emitters until `PASS datadog 6/6 files identical`.

- [ ] **Step 3: Write `fixtures/grafana.spec.json`**

```json
{
  "name": "grafana",
  "title": "Grafana",
  "displayName": "Grafana",
  "description": "Grafana connector (alert rules, dashboards). Read-focused.",
  "serviceLabel": "Grafana",
  "style": "hand-rolled",
  "network": [],
  "env": [
    { "vars": ["GRAFANA_URL"], "local": "baseUrl", "bindings": ["u"], "required": true, "transform": "stripTrailingSlash" },
    { "vars": ["GRAFANA_API_TOKEN"], "local": "authHeaders", "bindings": ["tok"], "auth": "bearer" }
  ],
  "fetchHelper": {
    "local": "grafanaGet",
    "base": "${env.baseUrl}",
    "headers": "authHeaders",
    "normalizeLeadingSlash": true,
    "jsonFallbackRaw": true
  },
  "tools": [
    { "name": "grafana_alert_list", "description": "List alert rules (Ruler API).", "path": "/api/ruler/grafana/api/v1/rules" },
    {
      "name": "grafana_dashboard_list",
      "description": "Search dashboards.",
      "args": { "query": { "type": "string", "optional": true, "default": "", "local": "q" } },
      "path": "/api/search?type=dash-db&query=${arg.query|enc}"
    }
  ]
}
```

> Read the real `nimbus.extension.json` for `network` and `description` before running — copy the *values* into the fixture by reading them, since they are configuration data the spec must state, not source text.

- [ ] **Step 4: Run the harness for grafana**

Run: `bun run diff:golden grafana --nimbus-root C:\gitrep\Nimbus`
Expected: `PASS grafana 6/6 files identical`. This is the fixture that proves object-expansion control works.

- [ ] **Step 5: Write `fixtures/sentry.spec.json`**

```json
{
  "name": "sentry",
  "title": "Sentry",
  "displayName": "Sentry",
  "description": "Sentry connector (issues, releases). Read-focused.",
  "serviceLabel": "Sentry",
  "style": "hand-rolled",
  "network": ["sentry.io"],
  "env": [
    {
      "vars": ["SENTRY_URL"],
      "local": "apiRoot",
      "bindings": ["u"],
      "default": "https://sentry.io",
      "transform": "stripTrailingSlash",
      "suffix": "/api/0"
    },
    { "vars": ["SENTRY_ORG_SLUG"], "local": "org", "bindings": ["o"], "required": true },
    { "vars": ["SENTRY_AUTH_TOKEN"], "local": "headers", "bindings": ["t"], "auth": "bearer" }
  ],
  "fetchHelper": { "local": "sentryGet", "base": "${env.apiRoot}", "headers": "headers" },
  "tools": [
    {
      "name": "sentry_issue_list",
      "description": "List unresolved issues for a project.",
      "args": {
        "projectSlug": { "type": "string", "min": 1 },
        "limit": { "type": "number", "int": true, "min": 1, "max": 100, "optional": true, "default": 20, "local": "lim" }
      },
      "path": "/projects/${env.org}/${arg.projectSlug}/issues/?query=is:unresolved&limit=${arg.limit|num}"
    },
    {
      "name": "sentry_release_list",
      "description": "List releases for a project.",
      "args": { "projectSlug": { "type": "string", "min": 1 } },
      "path": "/projects/${env.org}/${arg.projectSlug}/releases/"
    }
  ]
}
```

- [ ] **Step 6: Run the full harness**

Run: `bun run diff:golden --nimbus-root C:\gitrep\Nimbus`
Expected: `PASS` on all four of `newrelic`, `datadog`, `grafana`, `sentry`, then `All fixtures byte-identical.`

- [ ] **Step 7: Record any irreducible diff**

If a residual diff cannot be closed without adding a purely cosmetic spec field, **stop and write it down** in the design doc's acceptance section rather than growing the spec — that is the documented policy. Add a short "Known irreducible diffs" subsection naming the file, the bytes, and why.

- [ ] **Step 8: Run the full check and commit**

Run: `bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/`
Expected: all green.

```bash
git add fixtures/ src/
git commit -m "feat(golden): datadog, grafana and sentry fixtures at zero diff"
```

---

### Task 16: Style R fixtures — `discord` and `google-meet`

**Files:**
- Create: `fixtures/discord.spec.json`, `fixtures/google-meet.spec.json`
- Modify: `src/emit/server/tools-rest.ts`, `src/emit/server/fetch-helper.ts` as required
- Modify: the design doc, to record gaps

**Background.** These are Style R and **not expected to reach zero diff**. `discord` hand-writes its own `discordFetch` with `Bot` auth plus a `User-Agent`, and one of its tools builds a URL with `new URL()` and conditional `searchParams` — outside the D3 boundary. `google-meet` uses `fetchBearerAuthorizedJson` + `resolveUrlWithBase` from a different shared module. The deliverable is an **honest report**, not a forced pass.

- [ ] **Step 1: Read both real connectors**

Run:
```bash
cat C:/gitrep/Nimbus/packages/mcp-connectors/discord/src/server.ts
cat C:/gitrep/Nimbus/packages/mcp-connectors/google-meet/src/server.ts
```
Note every construct the current emitters cannot produce.

- [ ] **Step 2: Write both fixture specs**

Model them on the real connectors. Mark every tool the DSL cannot express as `"impl": "stub"` — do **not** invent spec fields to force a match.

- [ ] **Step 3: Run the harness**

Run: `bun run diff:golden discord google-meet --nimbus-root C:\gitrep\Nimbus`
Expected: partial. Record which of the six files reach identical and which do not.

- [ ] **Step 4: Close only the cheap gaps**

Fix anything that is a genuine emitter bug (wrong import order, wrong wiring variable). Do not add spec surface to chase the `new URL()` tool or a bespoke fetch helper.

- [ ] **Step 5: Document the gaps in the design doc**

Add to `docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md`, under acceptance criterion 2, a subsection listing for each of the two connectors: files identical, files differing, and the specific construct that blocks each remaining diff.

- [ ] **Step 6: Commit**

```bash
git add fixtures/discord.spec.json fixtures/google-meet.spec.json src/ docs/
git commit -m "feat(golden): style R fixtures with documented coverage gaps"
```

---

### Task 17: CLI and interactive prompts

**Files:**
- Create: `src/cli.ts`, `src/prompts.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `generate`, `formatAll`, `parseSpec`
- Produces:
  - `parseCliArgs(argv: string[]): CliOptions` where `CliOptions = { name?: string; specPath?: string; outDir?: string; dryRun: boolean }`
  - `renderTree(files): string` — the `--dry-run` output
  - `writeFiles(files, outDir): Promise<void>`

**Background.** Prompts collect: connector name, display name, service label, base API URL, auth type (API token / bearer / basic), credential env var name, and read tool names. They build a `ConnectorSpec` which then follows the exact same path as `--spec`. Do **not** add a dependency for this.

Use Bun's global **`prompt(message, default)`**. It is synchronous, prints the ` [default]` hint itself, and returns the default on empty input or EOF — all verified on Bun 1.3.14.

Do not use `for await (const line of console)`. Bun *does* make `console` async-iterable, so it is not invalid — but each call to a helper built on it opens a fresh iterator over the same stdin stream, and returning early from the loop closes that iterator. Across the nine sequential questions here that is a real hazard, and `prompt()` avoids the whole class of problem.

- [ ] **Step 1: Write the failing test**

```ts
// test/cli.test.ts
import { describe, expect, it } from "bun:test";
import { parseCliArgs, renderTree } from "../src/cli.ts";

describe("parseCliArgs", () => {
  it("reads a positional name", () => {
    expect(parseCliArgs(["slack"])).toEqual({ name: "slack", dryRun: false });
  });

  it("reads --spec and --dry-run", () => {
    expect(parseCliArgs(["--spec", "fixtures/sentry.spec.json", "--dry-run"])).toEqual({
      specPath: "fixtures/sentry.spec.json",
      dryRun: true,
    });
  });

  it("reads --out-dir", () => {
    expect(parseCliArgs(["x", "--out-dir", "/tmp/x"])).toEqual({
      name: "x",
      outDir: "/tmp/x",
      dryRun: false,
    });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(/--nope/);
  });
});

describe("renderTree", () => {
  it("lists every file with its byte count", () => {
    const out = renderTree([
      { path: ["src", "server.ts"], content: "abc" },
      { path: ["README.md"], content: "hello" },
    ]);
    expect(out).toContain("src/server.ts");
    expect(out).toContain("3 bytes");
    expect(out).toContain("README.md");
    expect(out).toContain("5 bytes");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generate } from "./emit/index.ts";
import { formatAll } from "./format.ts";
import { promptForSpec } from "./prompts.ts";
import { parseSpec } from "./spec.ts";
import { displayPath, type GeneratedFile } from "./types.ts";

export type CliOptions = {
  name?: string;
  specPath?: string;
  outDir?: string;
  dryRun: boolean;
};

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--spec") opts.specPath = argv[++i];
    else if (a === "--out-dir") opts.outDir = argv[++i];
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else opts.name = a;
  }
  return opts;
}

export function renderTree(files: readonly GeneratedFile[]): string {
  return files
    .map((f) => `  ${displayPath(f.path).padEnd(28)} ${Buffer.byteLength(f.content)} bytes`)
    .join("\n");
}

export async function writeFiles(
  files: readonly GeneratedFile[],
  outDir: string,
): Promise<void> {
  for (const f of files) {
    const target = join(outDir, ...f.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content, "utf8");
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const opts = parseCliArgs(argv);
  const spec =
    opts.specPath !== undefined
      ? parseSpec(JSON.parse(await Bun.file(opts.specPath).text()))
      : promptForSpec(opts.name);

  const files = formatAll(generate(spec));
  const outDir = opts.outDir ?? join("packages", "mcp-connectors", spec.name);

  if (opts.dryRun) {
    console.log(`Would write ${files.length} files to ${outDir}/\n`);
    console.log(renderTree(files));
    return;
  }

  await writeFiles(files, outDir);
  console.log(`Created ${outDir}/ (${files.length} files)`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
```

- [ ] **Step 4: Implement `src/prompts.ts`**

```ts
import { parseSpec, type ConnectorSpec } from "./spec.ts";

/**
 * Bun implements the browser `prompt(message, default)`: synchronous, prints
 * the ` [default]` hint itself, and returns the default on empty input or EOF.
 * Verified on Bun 1.3.14.
 */
function ask(question: string, fallback = ""): string {
  return prompt(question, fallback) ?? fallback;
}

const AUTH_HEADER: Record<string, "bearer" | "headers"> = {
  bearer: "bearer",
  token: "headers",
  basic: "headers",
};

export function promptForSpec(seedName?: string): ConnectorSpec {
  const name = seedName ?? ask("Connector name (lower-kebab-case)");
  const displayName = ask("Display name", name);
  const serviceLabel = ask("Service label used in error messages", displayName);
  const description = ask("Description", `${displayName} connector. Read-focused.`);
  const baseUrl = ask("Base API URL", `https://api.${name}.com`);
  const authKind = ask("Auth type (bearer | token | basic)", "bearer");
  const envVar = ask("Credential env var", `${name.toUpperCase().replaceAll("-", "_")}_TOKEN`);
  const headerName = authKind === "bearer" ? undefined : ask("Header name", "X-Api-Key");
  const toolCsv = ask("Read tool names (comma-separated)", `${name}_list`);

  const auth = AUTH_HEADER[authKind] ?? "bearer";
  const host = new URL(baseUrl).host;

  return parseSpec({
    name,
    displayName,
    description,
    serviceLabel,
    style: "rest-kit",
    network: [host],
    env: [
      {
        vars: [envVar],
        local: "authHeaders",
        auth,
        ...(auth === "headers" ? { headerNames: [headerName ?? "X-Api-Key"] } : {}),
      },
    ],
    fetchHelper: { local: `${name.replaceAll("-", "")}Fetch`, base: baseUrl },
    tools: toolCsv
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "")
      .map((t) => ({ name: t, description: `TODO: describe ${t}.`, impl: "stub" })),
  });
}
```

> Prompted tools default to `"impl": "stub"` deliberately: the CLI cannot know a service's URL paths, and emitting a stub the author fills in is honest where guessing a path would not be.

- [ ] **Step 5: Run tests and try it end to end**

Run: `bun test test/cli.test.ts`
Expected: PASS (5 tests).

Run: `bun src/cli.ts --spec fixtures/sentry.spec.json --dry-run`
Expected: prints six files with byte counts, writes nothing.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/prompts.ts test/cli.test.ts
git commit -m "feat(cli): interactive prompts, --spec and --dry-run"
```

---

### Task 18: End-to-end acceptance in the monorepo

**Files:**
- Create: `fixtures/zzscratch.spec.json`, `scripts/acceptance.ts`, `README.md` (this repo's own)
- Modify: `package.json` (add the `acceptance` script), `docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md` (record results)

**Background.** This is the only task that proves criterion 3 — that a generated connector actually compiles and lints inside Nimbus. It is also the only task that **writes into someone else's repository**, so cleanup must be guaranteed rather than a final step that a crash can skip.

- [ ] **Step 1: Write `fixtures/zzscratch.spec.json`**

A purpose-built scratch spec whose `name` is `zzscratch`, so the emitted `package.json` name and README slug are self-consistent. Copy the shape of `fixtures/sentry.spec.json`, changing `name`, `title`, `displayName`, `serviceLabel`, and the env var names to `ZZSCRATCH_*`.

- [ ] **Step 2: Write `scripts/acceptance.ts` with guaranteed cleanup**

```ts
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../src/emit/index.ts";
import { formatAll } from "../src/format.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { parseSpec } from "../src/spec.ts";
import { writeFiles } from "../src/cli.ts";

const NAME = "zzscratch";
const scriptDir = dirname(fileURLToPath(import.meta.url));

function run(cmd: string[], cwd: string): { ok: boolean; output: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: r.exitCode === 0,
    output: `${r.stdout.toString()}${r.stderr.toString()}`.trim(),
  };
}

const root = resolveNimbusRoot({
  flag: process.argv[2],
  env: process.env["NIMBUS_ROOT"],
  scriptDir,
});
const outDir = join(root, "packages", "mcp-connectors", NAME);

const checks: { name: string; ok: boolean; output: string }[] = [];

try {
  const spec = parseSpec(
    JSON.parse(await Bun.file(join(scriptDir, "..", "fixtures", `${NAME}.spec.json`)).text()),
  );
  await writeFiles(formatAll(generate(spec)), outDir);

  checks.push({ name: "tsc --noEmit", ...run(["bunx", "tsc", "--noEmit"], outDir) });
  checks.push({
    name: "biome check",
    ...run(["bunx", "biome", "check", `packages/mcp-connectors/${NAME}/src/`], root),
  });
  checks.push({
    name: "audit:package-readmes",
    ...run(["bun", "run", "audit:package-readmes"], root),
  });
} finally {
  // Runs even if generation threw or a check crashed. Never leave the monorepo dirty.
  await rm(outDir, { recursive: true, force: true });
}

const status = run(["git", "status", "--short", "packages/mcp-connectors/"], root);
checks.push({
  name: "monorepo working tree clean",
  ok: status.output === "",
  output: status.output,
});

for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.ok && c.output !== "") console.log(c.output);
}

if (checks.some((c) => !c.ok)) process.exit(1);
console.log("\nAll acceptance checks passed.");
```

Add to `package.json` scripts: `"acceptance": "bun scripts/acceptance.ts"`.

- [ ] **Step 3: Run it**

Run: `bun run acceptance C:/gitrep/Nimbus`
Expected: four `PASS` lines. If `tsc` fails on `../../shared/*` imports, the emitted import paths are wrong — fix the emitter, not the generated file.

- [ ] **Step 4: Verify cleanup survives failure**

Temporarily break the generator (e.g. emit a syntax error from `emitServer`), run `bun run acceptance C:/gitrep/Nimbus` again, and confirm it exits non-zero **and** that `git -C C:/gitrep/Nimbus status --short` is still empty. Then revert the break. Cleanup that only works on the happy path is not cleanup.

- [ ] **Step 5: Write this repo's `README.md`**

Cover: what it does, `bunx create-nimbus-connector <name>`, `--spec`, `--dry-run`, the Stage A boundary (single GET, read tools, monorepo-internal), how to run the harness including `--nimbus-root`, and a pointer to the design doc.

- [ ] **Step 6: Record acceptance results in the design doc**

Under "Acceptance criteria", state for each of the five criteria whether it passed, with the command run and the observed output. If a criterion did not pass, say so plainly and describe what is missing — do not quietly restate the criterion.

- [ ] **Step 7: Final full verification**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun run diff:golden --nimbus-root C:/gitrep/Nimbus && bun run acceptance C:/gitrep/Nimbus
```
Expected: all green; four fixtures byte-identical; four acceptance checks pass.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/ scripts/acceptance.ts fixtures/zzscratch.spec.json package.json
git commit -m "feat: acceptance harness with guaranteed monorepo cleanup"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Pure `generate` / `formatAll` split | 13, 4 |
| Module layout | 1–13 |
| `ConnectorSpec` + defaults | 2 |
| Path template language | 7 |
| Env accessors + pipeline order | 9 |
| Fetch helper knobs | 10 |
| Spec validation: identifier uniqueness | 3 |
| Spec validation: strict schemas | 2 |
| Formatting + version pinning | 4, Global Constraints |
| Harness + monorepo resolution | 14 |
| Acceptance criteria 1 (4 fixtures zero diff) | 14, 15 |
| Acceptance criterion 2 (Style R gaps documented) | 16 |
| Acceptance criterion 3 (`tsc` + `biome` in monorepo) | 18 |
| Acceptance criterion 4 (README audit) | 18 |
| Acceptance criterion 5 (unit tests independent of monorepo) | 1–13 |
| Spec cosmetics policy | 15 step 7 |
| CLI, `--dry-run`, prompts | 17 |

No spec section is unimplemented.

**Corrections applied after plan review (all verified empirically, not reasoned about):**

Probe run: `js-api@6.0.0` + `wasm-nodejs@2.5.6` on **Bun 1.3.14**.

| Finding | Result |
|---|---|
| Does `@biomejs/wasm-nodejs` init under Bun without flags? | **Yes.** `new Biome()` from `@biomejs/js-api/nodejs` works. No CLI or `wasm-web` fallback needed. |
| Is the WASM self-contained / offline-safe? | **Yes.** `biome_wasm_bg.wasm` (37.6 MB) ships in the tarball; no network fetch at init. |
| `js-api@6` call shapes | **Task 4 was wrong.** `applyConfiguration` and `formatContent` both take `projectKey` first, obtained from `openProject()`. There is no `biome.version`; read it from `@biomejs/wasm-nodejs/package.json`. |
| `formatAll` async? | **No.** The `/nodejs` constructor is synchronous, so `formatAll`/`biomeVersion` are sync. Callers in Tasks 14, 17, 18 updated. |
| Is `for await (const line of console)` valid in Bun? | **Yes** — `console[Symbol.asyncIterator]` is a function, so the review's premise was wrong for Bun (right for Node). Switched to `prompt()` anyway: it is synchronous, prints the `[default]` hint itself, returns the default on EOF, and avoids the repeated-iterator-over-stdin hazard across nine sequential questions. |
| Does `prompt(msg, default)` honour the default? | **Yes**, including on EOF. |
| Does a `newrelic`-shaped `reg()` call round-trip through the formatter unchanged? | **Yes** — earliest evidence Task 14 can reach zero diff. Added as a Task 4 test. |

Task 18 was additionally restructured into `scripts/acceptance.ts` with `try/finally`, so the scratch connector is removed from the Nimbus working tree even when generation or a check crashes, with an explicit step to verify cleanup survives failure.

**Known deviations from the spec, deliberate:**

- The spec's module layout named `src/emit/server/index.ts` but did not mention `src/golden/resolve.ts`. Added in Task 14 so the resolver is unit-testable without running the harness script.
- `bindings` (per-var internal variable names) is not shown in the spec's example JSON. It is required for byte-exactness — `newrelic` uses `k`, `datadog` `ak`/`app`, `grafana` `u`/`tok`, `sentry` `u`/`o`/`t`, none derivable. This falls under the approved cosmetics policy ("`local` is permitted everywhere as one optional string defaulting to a sensible derivation"); **update the spec's `env` example to include it** as part of Task 15's documentation step.

**Type consistency:** `GeneratedFile` (Task 1) is consumed unchanged by Tasks 4, 5, 6, 13, 14, 17. `ConnectorSpec` (Task 2) is consumed by 3, 5, 6, 10, 11, 12, 13. `hoistedLocals`/`renderHoists`/`renderZodSchema` (Task 8) are used by 11 and 12 with identical signatures. `renderPath`'s `RenderContext` (Task 7) is constructed identically in 11 (`param: "p"`) and 12 (`param: "parsed"`). `parseSpec` returns the widened `ConnectorSpec` with non-optional `title`/`id`, which Tasks 6 and 12 rely on.
