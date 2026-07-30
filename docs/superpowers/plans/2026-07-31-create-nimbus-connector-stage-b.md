# create-nimbus-connector Stage B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated connectors work outside the Nimbus monorepo by publishing the shared kit as `@nimbus-dev/sdk/connector-kit`, and make the CLI installable as `bunx create-nimbus-connector`.

**Architecture:** `generate(spec, { target })` gains a second parameter selecting `"monorepo"` (relative `../../shared/*` imports, unchanged) or `"standalone"` (one import from the published kit). Biome moves to an `optionalDependency` loaded by an explicit `await initFormatter()`, keeping `formatAll` synchronous. A new acceptance script proves a standalone connector installs, typechecks and answers a real MCP `tools/list` over stdio.

**Tech Stack:** Bun, TypeScript, Zod 4, `@biomejs/js-api` + `@biomejs/wasm-nodejs` (now optional), `bun test`.

**Source spec:** `docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md`

## ★ Task ordering spans three repositories

Most tasks are in `C:\gitrep\create-nimbus-connector`. **Each task names its working directory.** The order below is forced by real dependencies, not preference:

| Tasks | Repo | Why here |
|---|---|---|
| 1–4 | `create-nimbus-connector` | Emitters and CLI only change the import *string* they emit. Nothing needs the SDK to exist. |
| 5 | `nimbus-sdk` | Adds `./connector-kit` on a branch, **not released**. Task 6 cannot install it otherwise. |
| 6–7 | `create-nimbus-connector` | Acceptance harness installs the SDK from the local checkout, so it needs Task 5. |
| 8 | `nimbus-sdk` | **Release 1.11.0** — only after Task 6 has proven the export resolves from `dist`. A bad export map in a published release cannot be withdrawn. |
| 9 | `Nimbus` | Re-exports. **Blocked on Task 8** being on the registry. |

## Global Constraints

- **Runtime is Bun.** Tests `bun test`; typecheck `bunx tsc --noEmit`; lint `bunx biome check src/ test/ scripts/`.
- **All three gates green before every commit.** A task is not done until `bun test` (0 fail), `tsc --noEmit` (exit 0) and `biome check` (exit 0) all pass.
- **Stage A must not regress.** After every task in this repo, `bun run diff:golden --nimbus-root C:/gitrep/Nimbus` must report all seven fixtures matching declared expectations, exit 0, with `newrelic`/`datadog`/`grafana`/`sentry` at 6/6. If a change moves a single byte of monorepo-target output, it is wrong.
- **`noNonNullAssertion` and `noTemplateCurlyInString` are disabled repo-wide**, deliberately. Do not re-enable or remove the suppressions.
- **SDK version floor for standalone output:** `"@nimbus-dev/sdk": "^1.11.0"`. Monorepo output keeps `"^1.8.1"`.
- **Emitted connector deps otherwise unchanged:** `"@modelcontextprotocol/sdk": "1.30.0"`, `"zod": "^4.4.2"`, devDeps `{"@types/bun": "latest"}`, license `AGPL-3.0-only`.
- **Emitted files end with a trailing newline.** JSON is `JSON.stringify(x, undefined, 2) + "\n"`, then formatted through Biome.
- **Never commit on `main`.** Work lands on `stage-b-standalone` (this repo) or a feature branch in the other two.
- **Generated standalone connectors are Bun-only by design (B7).** Do not add Node-compatibility shims.

---

### Task 1: Make Biome optional without breaking the synchronous contract

**Working directory:** `C:\gitrep\create-nimbus-connector`

**Files:**
- Modify: `src/format.ts`
- Modify: `src/cli.ts` (call `initFormatter`), `scripts/diff-golden.ts`, `scripts/acceptance.ts`
- Modify: `package.json` (move Biome to `optionalDependencies`)
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: `GeneratedFile` from `src/types.ts`
- Produces:
  - `initFormatter(): Promise<void>` — idempotent; loads Biome if installed, records absence otherwise. Never throws for a missing dependency.
  - `formatterAvailable(): boolean`
  - `formatAll(files: readonly GeneratedFile[]): GeneratedFile[]` — **still synchronous**. Throws if `initFormatter()` has not resolved. Passes files through unchanged when a formatter is genuinely unavailable.
  - `biomeVersion(): string` — returns `"unknown"` rather than throwing when the backend cannot be resolved.

**Background:** Stage A established `formatAll` as synchronous and Tasks 14/17/18 depend on it. Loading an optional dependency needs a dynamic import, which is async — so the load moves out of `formatAll` into an explicit init. Critically, "Biome absent → degrade" and "nobody called init → programming error" must be **distinguishable**, or the second silently emits unformatted output. That is the failure class Stage A removed from this exact function.

- [ ] **Step 1: Write the failing tests**

Add to `test/format.test.ts` (keep every existing test unchanged):

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { biomeVersion, formatAll, formatterAvailable, initFormatter } from "../src/format.ts";

beforeAll(async () => {
  await initFormatter();
});

describe("initFormatter", () => {
  it("is idempotent", async () => {
    await initFormatter();
    await initFormatter();
    expect(formatterAvailable()).toBe(true);
  });

  it("reports the formatter as available in this repo", () => {
    expect(formatterAvailable()).toBe(true);
  });
});

describe("formatAll before init", () => {
  // Run in a subprocess with a pristine module registry. A query-string import
  // (`../src/format.ts?x=1`) does currently give a fresh module in Bun 1.3.14 — verified —
  // but that is loader behaviour, not a documented contract, and this test exists precisely
  // to pin a guarantee. A subprocess also tests what a real caller hits: a program that
  // forgot to init. No test-only reset export is added to production code.
  it("throws a message naming initFormatter", () => {
    const r = Bun.spawnSync(
      [
        "bun",
        "-e",
        'const { formatAll } = await import("./src/format.ts");' +
          'formatAll([{ path: ["a.ts"], content: "const x=1\\n" }]);',
      ],
      { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/initFormatter/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/format.test.ts`
Expected: FAIL — `initFormatter` and `formatterAvailable` are not exported.

- [ ] **Step 3: Rewrite `src/format.ts`**

```ts
import { createRequire } from "node:module";
import type { GeneratedFile } from "./types.ts";

type BiomeLike = {
  openProject: () => { projectKey: unknown };
  applyConfiguration: (key: unknown, config: unknown) => void;
  formatContent: (
    key: unknown,
    content: string,
    options: { filePath: string },
  ) => {
    content: string;
    diagnostics: ReadonlyArray<{ severity: string; category?: string; description: string }>;
  };
};

type Instance = { biome: BiomeLike; projectKey: unknown };

let cached: Instance | undefined;
let initialised = false;
let available = false;

/**
 * Load Biome if it is installed. Idempotent, and never throws for a missing
 * dependency — @biomejs/js-api is an optionalDependency, so a consumer running
 * `bunx create-nimbus-connector` may not have it.
 */
export async function initFormatter(): Promise<void> {
  if (initialised) return;
  initialised = true;
  try {
    const { Biome } = (await import("@biomejs/js-api/nodejs")) as {
      Biome: new () => BiomeLike;
    };
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
    available = true;
  } catch {
    available = false;
  }
}

export function formatterAvailable(): boolean {
  return available;
}

/** Returns "unknown" rather than throwing when the backend is not installed. */
export function biomeVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("@biomejs/wasm-nodejs/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export function formatAll(files: readonly GeneratedFile[]): GeneratedFile[] {
  if (!initialised) {
    throw new Error(
      "formatAll() was called before initFormatter() resolved. Await initFormatter() once at " +
        "startup. This is a programming error, distinct from Biome being unavailable.",
    );
  }
  if (cached === undefined) {
    return files.map((f) => ({ path: f.path, content: f.content }));
  }
  const { biome, projectKey } = cached;
  return files.map((f) => {
    const name = f.path[f.path.length - 1] ?? "";
    if (!(name.endsWith(".ts") || name.endsWith(".json"))) {
      return { path: f.path, content: f.content };
    }
    const { content, diagnostics } = biome.formatContent(projectKey, f.content, {
      filePath: f.path.join("/"),
    });
    const fatal = diagnostics.filter((d) => d.severity === "error" || d.severity === "fatal");
    if (fatal.length > 0) {
      const details = fatal.map((d) => `  [${d.category ?? "unknown"}] ${d.description}`).join("\n");
      const kind = name.endsWith(".json") ? "JSON" : "TypeScript";
      throw new Error(
        `Biome could not format ${f.path.join("/")} — the emitted code is not valid ${kind}:\n${details}`,
      );
    }
    return { path: f.path, content };
  });
}
```

- [ ] **Step 4: Update the three callers**

In `src/cli.ts`'s `main`, immediately before the `formatAll` call:

```ts
  await initFormatter();
  if (!formatterAvailable()) {
    console.error(
      "note: @biomejs/biome is not installed, so the generated files are unformatted.\n" +
        "      they are valid TypeScript and will compile as-is. to format them:\n\n" +
        `        cd ${outDir} && bunx @biomejs/biome format --write .\n`,
    );
  }
```

Compute `outDir` before this block so the message can name it. Add `initFormatter, formatterAvailable` to the import from `./format.ts`.

In `scripts/diff-golden.ts` and `scripts/acceptance.ts`, `await initFormatter()` before any `formatAll` call, then **fail** rather than degrade:

```ts
await initFormatter();
if (!formatterAvailable()) {
  throw new Error(
    "@biomejs/biome is required here — byte-exactness is the point of this check, and " +
      "unformatted output would produce spurious diffs that look like emitter regressions. " +
      "Run `bun install` to restore the optional dependency.",
  );
}
```

- [ ] **Step 5: Move Biome to `optionalDependencies` in `package.json`**

```jsonc
"dependencies": {
  "zod": "^4.4.2"
},
"optionalDependencies": {
  "@biomejs/js-api": "^6.0.0",
  "@biomejs/wasm-nodejs": "^2.5.6"
},
```

Leave `devDependencies` untouched — `@biomejs/biome` stays there for linting this repo.

- [ ] **Step 6: Verify**

Run: `bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/`
Expected: all green.

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: seven fixtures matching, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/format.ts src/cli.ts scripts/ package.json test/format.test.ts
git commit -m "feat(format): make Biome optional via initFormatter, keeping formatAll sync"
```

---

### Task 2: `generate(spec, { target })` and the standalone import block

**Working directory:** `C:\gitrep\create-nimbus-connector`

**Files:**
- Modify: `src/emit/index.ts`, `src/emit/server/index.ts`
- Test: `test/emit/generate.test.ts`

**Interfaces:**
- Produces:
  - `type GenerateTarget = "monorepo" | "standalone"` exported from `src/emit/index.ts`
  - `type GenerateOptions = { target?: GenerateTarget }`
  - `generate(spec: ConnectorSpec, options?: GenerateOptions): GeneratedFile[]` — defaults to `"monorepo"`
  - `emitServer(spec: ConnectorSpec, target: GenerateTarget): GeneratedFile`

**Background:** Where a connector is going is a property of *this generation*, not of the connector — so it is a parameter, not a spec field. Fixture spec files stay byte-identical and Stage A's harness is untouched.

Standalone emits **one** import for the kit, because the SDK export is a single barrel. All three shapes:

```ts
// standalone, hand-rolled, has a non-stub tool
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "@nimbus-dev/sdk/connector-kit";

// standalone, hand-rolled, all tools are stubs
import { createRegisterSimpleTool, createZodToolRegistrar } from "@nimbus-dev/sdk/connector-kit";

// standalone, rest-kit
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  makeRestToolRegistrar,
} from "@nimbus-dev/sdk/connector-kit";
```

- [ ] **Step 1: Write the failing tests**

Add to `test/emit/generate.test.ts`:

```ts
import { generate } from "../../src/emit/index.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

const handRolled = parseSpec({
  name: "acme",
  displayName: "Acme",
  description: "d.",
  serviceLabel: "Acme",
  style: "hand-rolled",
  env: [{ vars: ["ACME_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
  fetchHelper: { local: "acmeGet", base: "https://api.acme.test", headers: "headers" },
  tools: [{ name: "acme_item_list", description: "List items.", path: "/v1/items" }],
});

const restKit = parseSpec({
  name: "acme",
  displayName: "Acme",
  description: "d.",
  serviceLabel: "Acme",
  style: "rest-kit",
  env: [{ vars: ["ACME_TOKEN"], local: "hdrs", bindings: ["t"], auth: "bearer" }],
  fetchHelper: { local: "acmeFetch", base: "https://api.acme.test" },
  tools: [{ name: "acme_item_list", description: "List items.", path: "/v1/items" }],
});

function server(spec: Parameters<typeof generate>[0], target?: "monorepo" | "standalone"): string {
  const opts = target === undefined ? undefined : { target };
  return generate(spec, opts).find((f) => displayPath(f.path) === "src/server.ts")!.content;
}

describe("generate target", () => {
  it("defaults to monorepo, keeping relative shared imports", () => {
    expect(server(handRolled)).toContain('} from "../../shared/mcp-tool-kit.ts";');
    expect(server(handRolled)).not.toContain("@nimbus-dev/sdk/connector-kit");
  });

  it("emits one kit import for standalone hand-rolled", () => {
    const src = server(handRolled, "standalone");
    expect(src).toContain('} from "@nimbus-dev/sdk/connector-kit";');
    expect(src).not.toContain("../../shared/");
    expect(src.match(/@nimbus-dev\/sdk\/connector-kit/g)).toHaveLength(1);
  });

  it("emits one kit import for standalone rest-kit, including makeRestToolRegistrar", () => {
    const src = server(restKit, "standalone");
    expect(src).toContain("makeRestToolRegistrar,");
    expect(src).not.toContain("../../shared/");
    expect(src.match(/@nimbus-dev\/sdk\/connector-kit/g)).toHaveLength(1);
  });

  it("omits jsonResult for an all-stub standalone hand-rolled spec", () => {
    const allStub = parseSpec({
      name: "acme",
      displayName: "Acme",
      description: "d.",
      serviceLabel: "Acme",
      style: "hand-rolled",
      env: [{ vars: ["ACME_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
      fetchHelper: { local: "acmeGet", base: "https://api.acme.test", headers: "headers" },
      tools: [{ name: "acme_write", description: "Write.", impl: "stub" }],
    });
    const src = server(allStub, "standalone");
    expect(src).not.toContain("jsonResult");
    expect(src).toContain('import { createRegisterSimpleTool, createZodToolRegistrar } from "@nimbus-dev/sdk/connector-kit";');
  });

  it("no relative import escapes a standalone package", () => {
    for (const spec of [handRolled, restKit]) {
      for (const f of generate(spec, { target: "standalone" })) {
        expect(f.content).not.toContain("../../");
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/generate.test.ts`
Expected: FAIL — `generate` takes one argument.

- [ ] **Step 3: Add the target parameter**

In `src/emit/index.ts`:

```ts
export type GenerateTarget = "monorepo" | "standalone";
export type GenerateOptions = { target?: GenerateTarget };

/** Pure. Returns UNFORMATTED files — callers pass the result through formatAll(). */
export function generate(spec: ConnectorSpec, options: GenerateOptions = {}): GeneratedFile[] {
  const target = options.target ?? "monorepo";
  validateSpec(spec);
  return [
    emitServer(spec, target),
    emitSandboxTest(),
    emitPackageJson(spec, target),
    emitManifest(spec),
    emitTsconfig(target),
    emitReadme(spec, target),
  ];
}
```

`emitPackageJson`, `emitTsconfig` and `emitReadme` gain their parameters in Task 3 — for this task, add the parameter to `emitServer` only and leave the other three calls as they are, adding their arguments when Task 3 lands.

In `src/emit/server/index.ts`, thread `target` through `imports` and `emitServer`:

```ts
const KIT = "@nimbus-dev/sdk/connector-kit";

function imports(spec: ConnectorSpec, target: GenerateTarget): string {
  const usesZod = spec.tools.length > 0;
  const usesJsonResult = spec.style === "hand-rolled" && spec.tools.some((t) => t.impl !== "stub");

  const head = [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    ...(usesZod ? ['import { z } from "zod";'] : []),
    "",
  ];

  if (target === "standalone") {
    // One barrel export, so one import regardless of style.
    const names = ["createRegisterSimpleTool", "createZodToolRegistrar"];
    if (usesJsonResult) names.push("mcpJsonResult as jsonResult");
    if (spec.style === "rest-kit") names.push("makeRestToolRegistrar");
    if (names.length === 2) {
      head.push(`import { ${names.join(", ")} } from "${KIT}";`);
    } else {
      head.push("import {", ...names.map((n) => `  ${n},`), `} from "${KIT}";`);
    }
    return head.join("\n");
  }

  // monorepo — unchanged from Stage A
  if (spec.style === "hand-rolled") {
    if (usesJsonResult) {
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
      );
    }
  } else {
    head.push(
      'import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
      'import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";',
    );
  }
  return head.join("\n");
}
```

and change the signature to `export function emitServer(spec: ConnectorSpec, target: GenerateTarget): GeneratedFile`, passing `target` to `imports(spec, target)`. Import `GenerateTarget` from `../index.ts`.

**Nothing else in `emitServer` changes.** Env accessors, fetch helper, wiring, tools and tail are identical for both targets.

- [ ] **Step 4: Verify**

Run: `bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/`

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: seven fixtures matching, exit 0. **If any hand-rolled fixture moved, the monorepo branch was disturbed — stop and report.**

- [ ] **Step 5: Commit**

```bash
git add src/emit/ test/emit/generate.test.ts
git commit -m "feat(emit): add generate target, emitting the published kit for standalone"
```

---

### Task 3: Standalone `package.json`, `tsconfig.json` and `README.md`

**Working directory:** `C:\gitrep\create-nimbus-connector`

**Files:**
- Modify: `src/emit/package-json.ts`, `src/emit/tsconfig.ts`, `src/emit/readme.ts`, `src/emit/index.ts`
- Test: `test/emit/static.test.ts`, `test/emit/readme.test.ts`

**Interfaces:**
- Produces: `emitPackageJson(spec, target)`, `emitTsconfig(target)`, `emitReadme(spec, target)` — all taking `GenerateTarget`

- [ ] **Step 1: Write the failing tests**

Add to `test/emit/static.test.ts`:

```ts
describe("standalone package.json", () => {
  const pkg = () => JSON.parse(emitPackageJson(spec, "standalone").content);

  it("raises the SDK floor to the version carrying connector-kit", () => {
    expect(pkg().dependencies["@nimbus-dev/sdk"]).toBe("^1.11.0");
  });

  it("keeps the other two connector dependencies unchanged", () => {
    expect(pkg().dependencies["@modelcontextprotocol/sdk"]).toBe("1.30.0");
    expect(pkg().dependencies.zod).toBe("^4.4.2");
  });

  it("adds dev and build scripts producing the manifest's declared entrypoint", () => {
    expect(pkg().scripts.build).toBe("bun build src/server.ts --outdir dist --target bun");
    expect(pkg().scripts.dev).toBe("bun run --watch src/server.ts");
  });

  it("declares no bin — a connector is spawned via its manifest entrypoint", () => {
    expect(pkg().bin).toBeUndefined();
  });

  it("leaves the monorepo target untouched", () => {
    const mono = JSON.parse(emitPackageJson(spec, "monorepo").content);
    expect(mono.dependencies["@nimbus-dev/sdk"]).toBe("^1.8.1");
    expect(mono.scripts.build).toBeUndefined();
  });
});

describe("standalone tsconfig", () => {
  const cfg = () => JSON.parse(emitTsconfig("standalone").content);

  it("is self-contained, not extending the monorepo base", () => {
    expect(cfg().extends).toBeUndefined();
    expect(cfg().compilerOptions.strict).toBe(true);
    expect(cfg().compilerOptions.target).toBe("ESNext");
    expect(cfg().compilerOptions.moduleResolution).toBe("bundler");
  });

  it("omits customConditions so the SDK resolves to dist like a real consumer", () => {
    expect(cfg().compilerOptions.customConditions).toBeUndefined();
  });

  it("omits allowImportingTsExtensions — no .ts imports remain", () => {
    expect(cfg().compilerOptions.allowImportingTsExtensions).toBeUndefined();
  });

  it("leaves the monorepo target extending the base", () => {
    expect(JSON.parse(emitTsconfig("monorepo").content).extends).toBe("../../../tsconfig.base.json");
  });
});
```

Add to `test/emit/readme.test.ts`:

```ts
describe("standalone README", () => {
  const md = () => emitReadme(spec, "standalone").content;

  it("still carries every H2 the monorepo audit requires", () => {
    expect(h2s(md())).toEqual(["what this is", "install", "quickstart", "see also", "license"]);
  });

  it("gives real install instructions instead of 'bundled with Nimbus'", () => {
    expect(md()).not.toContain("Bundled with Nimbus");
    expect(md()).toContain("bun install");
  });

  it("names the credential env var the connector actually reads", () => {
    expect(md()).toContain("NEW_RELIC_API_KEY");
  });

  it("leaves the monorepo README unchanged", () => {
    expect(emitReadme(spec, "monorepo").content).toContain("Bundled with Nimbus");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/`
Expected: FAIL — these emitters take no target.

- [ ] **Step 3: Implement the three emitters**

`src/emit/package-json.ts`:

```ts
export function emitPackageJson(spec: ConnectorSpec, target: GenerateTarget): GeneratedFile {
  const standalone = target === "standalone";
  const pkg = {
    name: `nimbus-mcp-${spec.name}`,
    version: "0.1.0",
    private: false,
    license: "AGPL-3.0-only",
    type: "module",
    scripts: {
      ...(standalone ? { dev: "bun run --watch src/server.ts" } : {}),
      ...(standalone ? { build: "bun build src/server.ts --outdir dist --target bun" } : {}),
      typecheck: "tsc --noEmit",
      lint: "biome check src/",
      test: "bun test",
      clean: "rm -rf dist",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "1.30.0",
      "@nimbus-dev/sdk": standalone ? "^1.11.0" : "^1.8.1",
      zod: "^4.4.2",
    },
    devDependencies: { "@types/bun": "latest" },
  };
  return { path: ["package.json"], content: `${JSON.stringify(pkg, undefined, 2)}\n` };
}
```

`src/emit/tsconfig.ts`:

```ts
const STANDALONE_COMPILER_OPTIONS = {
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "bundler",
  lib: ["ESNext"],
  types: ["bun"],

  strict: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noPropertyAccessFromIndexSignature: true,
  forceConsistentCasingInFileNames: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,

  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  isolatedModules: true,
  skipLibCheck: true,

  noEmit: true,
};

export function emitTsconfig(target: GenerateTarget): GeneratedFile {
  const cfg =
    target === "standalone"
      ? {
          compilerOptions: STANDALONE_COMPILER_OPTIONS,
          include: ["src/**/*"],
          exclude: ["node_modules", "dist"],
        }
      : {
          extends: "../../../tsconfig.base.json",
          compilerOptions: { types: ["bun"] },
          include: ["src/**/*"],
          exclude: ["node_modules", "dist"],
        };
  return { path: ["tsconfig.json"], content: `${JSON.stringify(cfg, undefined, 2)}\n` };
}
```

`src/emit/readme.ts` — keep the monorepo branch exactly as it is; add a standalone branch whose **Install** and **Quickstart** sections differ. The five H2 headings must stay identical and in the same order. Derive the env var list from `spec.env.flatMap((e) => e.vars)`:

```ts
## Install

```bash
bun install
bun run build
```

## Quickstart

Set the credentials this connector reads from the environment:

```bash
export NEW_RELIC_API_KEY=...        # one line per env var, generated from spec.env
```

Then register it with Nimbus, or run it directly over stdio:

```bash
bun src/server.ts
```
```

- [ ] **Step 4: Pass `target` through in `src/emit/index.ts`**

Update the three call sites to `emitPackageJson(spec, target)`, `emitTsconfig(target)`, `emitReadme(spec, target)`.

- [ ] **Step 5: Verify**

Run: `bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/`

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: seven fixtures matching, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/emit/ test/emit/
git commit -m "feat(emit): standalone package.json, tsconfig and README"
```

---

### Task 4: CLI `--standalone`

**Working directory:** `C:\gitrep\create-nimbus-connector`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces: `CliOptions` gains `standalone: boolean`

- [ ] **Step 1: Write the failing tests**

```ts
describe("--standalone", () => {
  it("defaults to false", () => {
    expect(parseCliArgs(["acme"]).standalone).toBe(false);
  });

  it("is set by the flag", () => {
    expect(parseCliArgs(["acme", "--standalone"]).standalone).toBe(true);
  });

  it("combines with --spec and --out-dir", () => {
    expect(parseCliArgs(["--spec", "x.json", "--standalone", "--out-dir", "/tmp/x"])).toEqual({
      specPath: "x.json",
      outDir: "/tmp/x",
      standalone: true,
      dryRun: false,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/cli.test.ts`
Expected: FAIL — `standalone` is not on `CliOptions`.

- [ ] **Step 3: Implement**

Add `standalone: boolean` to `CliOptions`, initialise `{ dryRun: false, standalone: false }`, handle `else if (a === "--standalone") opts.standalone = true;`, and in `main`:

```ts
const target = opts.standalone ? "standalone" : "monorepo";
const files = formatAll(generate(spec, { target }));
const outDir = opts.outDir ?? join("packages", "mcp-connectors", spec.name);
```

When `opts.standalone` is true and `--out-dir` was not given, the default `packages/mcp-connectors/<name>` is the wrong shape — a standalone connector does not live there. Default to `./<name>` instead:

```ts
const outDir =
  opts.outDir ?? (opts.standalone ? spec.name : join("packages", "mcp-connectors", spec.name));
```

- [ ] **Step 4: Verify**

Run: `bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/`

Run: `bun src/cli.ts --spec fixtures/sentry.spec.json --standalone --dry-run`
Expected: six files listed; nothing written.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat(cli): --standalone flag and standalone default out-dir"
```

---

### Task 5: `nimbus-sdk` — add the `./connector-kit` export (branch, NOT released)

**Working directory:** `C:\gitrep\nimbus-sdk`

**Files:**
- Create: `sdks/typescript/src/connector-kit/index.ts`, `mcp-tool-kit.ts`, `fetch-bearer-json.ts`, `rest-tool-kit.ts`
- Modify: `sdks/typescript/package.json` (exports map), the build config, the API-surface snapshot

**Background:** This repo is mid-work on `docs/release-pipeline-loose-ends-spec`. Branch from its default branch, not from that one.

**The contract, from the Stage B spec — do not improvise:**

- Export path `@nimbus-dev/sdk/connector-kit`, shaped exactly like the existing `./testing` and `./ipc` entries: a `bun` condition resolving to `src`, plus `types`/`import`/`default` resolving to `dist`.
- **It must build to `dist`.** Standalone consumers do not set the `bun` customCondition and resolve there. Source-only shipping breaks them.
- **Zero runtime dependencies.** The SDK's `dependencies` and `peerDependencies` must both remain empty — that invariant is part of the contract.

- [ ] **Step 1: Copy the three modules verbatim**

From `C:/gitrep/Nimbus/packages/mcp-connectors/shared/`, copy `mcp-tool-kit.ts`, `fetch-bearer-json.ts` and `rest-tool-kit.ts` into `sdks/typescript/src/connector-kit/`. Do not edit them beyond the import-extension adjustment the SDK's build requires, if any.

- [ ] **Step 2: Write the barrel**

`sdks/typescript/src/connector-kit/index.ts`, re-exporting the verified public surface:

```ts
export {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  encodeBasicAuthHeader,
  fetchWithTimeout,
  mcpJsonResult,
  mcpJsonResultFromTextIfOk,
  mcpJsonResultIfOk,
  parseJsonTextIfOk,
  putOptionalBoolean,
  putOptionalNonEmptyString,
  registerZodTool,
  requireProcessEnv,
} from "./mcp-tool-kit.ts";
export type {
  HttpJsonBodyResponse,
  HttpTextResponse,
  McpListResult,
  RegisterSimpleToolFn,
  ZodObjectSchema,
} from "./mcp-tool-kit.ts";

export { fetchBearerAuthorizedJson, resolveUrlWithBase } from "./fetch-bearer-json.ts";
export type { BearerJsonFetchResult } from "./fetch-bearer-json.ts";

export { makeRestFetcher, makeRestToolRegistrar } from "./rest-tool-kit.ts";
export type { RestFetchResult, RestFetcherConfig, RestToolRegistrar } from "./rest-tool-kit.ts";
```

- [ ] **Step 3: Add the exports-map entry**

In `sdks/typescript/package.json`, mirroring `./testing`:

```jsonc
"./connector-kit": {
  "bun": "./src/connector-kit/index.ts",
  "types": "./dist/connector-kit/index.d.ts",
  "import": "./dist/connector-kit/index.js",
  "default": "./dist/connector-kit/index.js"
}
```

- [ ] **Step 4: Build and confirm `dist` output exists**

Run: `bun run build`
Then confirm `dist/connector-kit/index.js` and `dist/connector-kit/index.d.ts` both exist. If the build config enumerates entry points explicitly, add this one.

- [ ] **Step 5: Confirm the zero-dependency invariant survived**

Run: `bun -e 'const p=require("./sdks/typescript/package.json"); console.log(JSON.stringify({deps:p.dependencies,peer:p.peerDependencies}))'`
Expected: both empty or absent. **If either gained an entry, stop — the contract is broken.**

- [ ] **Step 6: Update the API surface snapshot and run the repo's gates**

Run: `bun run api:surface`, then this repo's `typecheck`, `lint` and `test` scripts. Commit the regenerated snapshot alongside.

- [ ] **Step 7: Commit and open a PR — do NOT release yet**

```bash
git add sdks/typescript/
git commit -m "feat(connector-kit): publish the dependency-free MCP connector kit"
```

The release happens in Task 8, after Task 6 has proven the export actually resolves from `dist`.

---

### Task 6: SDK-root resolver and the standalone acceptance harness

**Working directory:** `C:\gitrep\create-nimbus-connector`

**Blocked on:** Task 5's branch existing locally and built.

**Files:**
- Create: `src/golden/sdk-root.ts`, `scripts/standalone-acceptance.ts`, `fixtures/zzstandalone.spec.json`
- Modify: `package.json` (add the `standalone-acceptance` script)
- Test: `test/golden/sdk-root.test.ts`

**Interfaces:**
- Produces: `resolveSdkRoot(opts: { flag?: string; env?: string; scriptDir: string }): string`

**Background:** This mirrors `src/golden/resolve.ts` deliberately, including the lesson learned there: an **explicit** source that does not exist must throw, never fall through to sibling probing. The marker file is `sdks/typescript/package.json`.

- [ ] **Step 1: Write the failing resolver tests**

Mirror `test/golden/resolve.test.ts`, including the hermetic regression test — build a temp workspace containing a **valid** sibling SDK checkout, point `scriptDir` two levels below it, pass an explicit bogus `flag`, and assert it throws naming the explicit path. That proves the fall-through is blocked *even when a valid fallback exists*, which is the condition under which the original bug hid.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/golden/sdk-root.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/golden/sdk-root.ts`**

Copy the structure of `src/golden/resolve.ts` exactly, changing only:
- `MARKER` to `join("sdks", "typescript", "package.json")`
- the sibling candidate names to `["nimbus-sdk"]`
- the flag name in messages to `--sdk-root` and the env var to `$NIMBUS_SDK_ROOT`

- [ ] **Step 4: Write `fixtures/zzstandalone.spec.json`**

A rest-kit spec, since that exercises the `makeRestToolRegistrar` half of the kit that the hand-rolled path does not:

```json
{
  "name": "zzstandalone",
  "title": "Zzstandalone",
  "displayName": "ZZ Standalone",
  "description": "Throwaway standalone acceptance connector. Read-focused.",
  "serviceLabel": "ZZ Standalone",
  "style": "rest-kit",
  "network": ["api.zzstandalone.test"],
  "syncInterval": 300,
  "minNimbusVersion": "0.2.0",
  "env": [
    { "vars": ["ZZSTANDALONE_TOKEN"], "local": "authHeaders", "bindings": ["t"], "auth": "bearer" }
  ],
  "fetchHelper": { "local": "zzFetch", "base": "https://api.zzstandalone.test" },
  "tools": [
    { "name": "zzstandalone_item_list", "description": "List items.", "path": "/v1/items" },
    {
      "name": "zzstandalone_item_get",
      "description": "Get one item by id.",
      "args": { "itemId": { "type": "string", "min": 1 } },
      "path": "/v1/items/${arg.itemId|enc}"
    }
  ]
}
```

Add `"zzstandalone": 0` to `fixtures/expectations.json` — there is no real `zzstandalone` connector in the monorepo, and the golden harness requires every fixture to declare an expectation. Do **not** weaken that guard.

- [ ] **Step 5: Write `scripts/standalone-acceptance.ts`**

Structure, with `try/finally` cleanup:

```ts
const NAME = "zzstandalone";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolveSdkRoot({ flag: process.argv[2], env: process.env["NIMBUS_SDK_ROOT"], scriptDir });
const sdkPkg = join(sdkRoot, "sdks", "typescript");

// A file: dependency installs BUILT output, which is what makes step 3 exercise
// the same dist resolution a real npm consumer takes.
if (!existsSync(join(sdkPkg, "dist", "connector-kit", "index.js"))) {
  throw new Error(
    `${sdkPkg}/dist/connector-kit/index.js is missing — run \`bun run build\` in the SDK first. ` +
      "A file: dependency installs dist, not src, so an unbuilt SDK cannot be verified here.",
  );
}

// realpathSync normalises a Windows short (8.3) path such as C:\Users\ASAFG~1\... to its
// long form. It does not differ on every machine — it did not on the one this plan was
// written on — but a mismatch between the path we write to and the path tooling resolves
// shows up as confusing module-resolution failures, and one call removes the class.
const outDir = realpathSync(mkdtempSync(join(tmpdir(), "cnc-standalone-")));
const checks: { name: string; ok: boolean; output: string }[] = [];

try {
  await initFormatter();
  if (!formatterAvailable()) throw new Error("@biomejs/biome is required for this check.");

  const spec = parseSpec(JSON.parse(await Bun.file(join(scriptDir, "..", "fixtures", `${NAME}.spec.json`)).text()));
  await writeFiles(formatAll(generate(spec, { target: "standalone" })), outDir);

  // Point the generated dependency at the local checkout until 1.11.0 is on the registry.
  const pkgPath = join(outDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies["@nimbus-dev/sdk"] = `file:${sdkPkg.replaceAll("\\", "/")}`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, undefined, 2)}\n`);

  // --force so a rebuilt SDK at the same path and version is not served from bun's cache.
  // The temp dir is fresh so node_modules is empty, but the cached *file:* package is not.
  checks.push({ name: "bun install", ...run(["bun", "install", "--force"], outDir) });

  // Do not trust --force to have worked — prove the built kit actually landed. A stale or
  // partial install would otherwise surface as a confusing tsc error about missing types.
  const installedKit = join(
    outDir,
    "node_modules",
    "@nimbus-dev",
    "sdk",
    "dist",
    "connector-kit",
    "index.js",
  );
  checks.push({
    name: "connector-kit present in node_modules",
    ok: existsSync(installedKit),
    output: existsSync(installedKit)
      ? installedKit
      : `${installedKit} is missing — the SDK installed without the connector-kit build output`,
  });

  checks.push({ name: "tsc --noEmit", ...run(["bunx", "tsc", "--noEmit"], outDir) });

  const escaping = run(["grep", "-rn", "\\.\\./\\.\\.", "src"], outDir);
  checks.push({
    name: "no relative import escapes the package",
    ok: escaping.output.trim() === "",
    output: escaping.output,
  });

  checks.push({ name: "tools/list over stdio", ...(await toolsListCheck(outDir)) });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
```

- [ ] **Step 5b: Write `toolsListCheck` — parse JSON-RPC properly, do not string-match**

This is the one genuinely fiddly piece. Three things make a naive implementation flaky, and all three must be handled:

**The full MCP handshake is three messages, not two.** The protocol is `initialize` request → server response → `notifications/initialized` **notification** (no `id`, no response expected) → only then normal requests. Sending `tools/list` immediately after `initialize` may be rejected as out-of-order.

**stdout is a stream, not a message boundary.** A single read can contain a partial line, several lines, or a line split across chunks. Accumulate into a buffer and split on `\n`, keeping any trailing partial fragment for the next chunk.

**Not every line is a response.** The runtime or a library may print warnings, and notifications carry no `id`. Parse each complete line as JSON, **skip anything that fails to parse**, and match the response by its `id` rather than by searching the raw text for a tool name.

```ts
async function toolsListCheck(cwd: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // No credential env vars are set. Accessors are only called inside tool handlers,
    // so a clean tools/list proves the server starts and describes itself without secrets.
  });

  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "standalone-acceptance", version: "0.0.0" },
      },
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let sawInitialized = false;

    // Read until the tools/list response (id 2) arrives, the process exits, or the timeout kills it.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      const lines = buffered.split("\n");
      buffered = lines.pop() ?? ""; // keep the trailing partial fragment

      for (const line of lines) {
        if (line.trim() === "") continue;
        let msg: { id?: unknown; result?: { tools?: Array<{ name?: string }> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a warning or other non-JSON output — not a protocol error
        }

        if (msg.id === 1 && !sawInitialized) {
          sawInitialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
          continue;
        }

        if (msg.id === 2) {
          const names = (msg.result?.tools ?? []).map((t) => t.name);
          const expected = ["zzstandalone_item_list", "zzstandalone_item_get"];
          const missing = expected.filter((n) => !names.includes(n));
          return {
            ok: missing.length === 0,
            output:
              missing.length === 0
                ? `tools/list returned ${names.join(", ")}`
                : `tools/list missing ${missing.join(", ")}; got ${names.join(", ") || "(none)"}`,
          };
        }
      }
    }

    const stderr = await new Response(proc.stderr).text();
    return { ok: false, output: `server exited before answering tools/list.\n${stderr.trim()}` };
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}
```

A hung server cannot wedge the script: the timeout kills it, and the `finally` kills it again on every exit path.

Add to `package.json`: `"standalone-acceptance": "bun scripts/standalone-acceptance.ts"`.

- [ ] **Step 6: Run it**

Run: `bun run standalone-acceptance C:/gitrep/nimbus-sdk`
Expected: four PASS lines, exit 0.

- [ ] **Step 7: Prove cleanup survives failure**

Temporarily make the generator throw after `writeFiles`, re-run, and confirm the script exits non-zero **and** the temp directory is gone. Revert, re-run clean. Paste both runs into the report.

- [ ] **Step 8: Verify nothing regressed and commit**

Run: `bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: all green; eight fixtures now, all matching declared expectations.

```bash
git add src/golden/sdk-root.ts scripts/standalone-acceptance.ts fixtures/ package.json test/golden/sdk-root.test.ts
git commit -m "feat(standalone): sdk-root resolver and live stdio acceptance harness"
```

---

### Task 7: Publishing metadata and documentation

**Working directory:** `C:\gitrep\create-nimbus-connector`

**Files:**
- Modify: `package.json`, `src/cli.ts` (shebang), `README.md`
- Modify: `docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md` (acceptance results)

- [ ] **Step 1: Add the shebang and publishing fields**

First line of `src/cli.ts`: `#!/usr/bin/env bun`

In `package.json`:

```jsonc
"bin": { "create-nimbus-connector": "./src/cli.ts" },
"files": ["src", "README.md"],
"publishConfig": { "access": "public" }
```

`fixtures/` stays out of the tarball — those specs describe monorepo connectors and are development artefacts, not runnable examples.

- [ ] **Step 2: Update `README.md`**

Document `--standalone`, the Bun-only constraint (B6, B7), that generated standalone connectors need `@nimbus-dev/sdk` ≥ 1.11.0, and both acceptance commands. State plainly that the package is **not published until SDK 1.11.0 exists**, since a generated standalone connector would otherwise depend on an export nobody can install.

- [ ] **Step 3: Record acceptance results in the design doc**

Under a new "Acceptance criteria — results" section, state each of the five criteria with the command run and the observed output. If one did not pass, say so plainly rather than restating it.

- [ ] **Step 4: Final verification**

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run acceptance C:/gitrep/Nimbus
bun run standalone-acceptance C:/gitrep/nimbus-sdk
```

- [ ] **Step 5: Commit**

```bash
git add package.json src/cli.ts README.md docs/
git commit -m "feat: publishing metadata and Stage B acceptance results"
```

---

### Task 8: `nimbus-sdk` — release 1.11.0

**Working directory:** `C:\gitrep\nimbus-sdk`

**Blocked on:** Task 6 passing against this SDK branch.

- [ ] **Step 1: Re-run the pre-release gate**

From `C:\gitrep\create-nimbus-connector`: `bun run standalone-acceptance C:/gitrep/nimbus-sdk`
Expected: four PASS, exit 0. **This is the gate.** A wrong export map or missing `dist` output cannot be withdrawn once released.

- [ ] **Step 2: Merge the Task 5 PR and release 1.11.0**

Follow this repo's existing release process (release-please manifest is present). The version must be **1.11.0** — additive minor, no breaking change.

- [ ] **Step 3: Confirm the published package**

Run: `npm view @nimbus-dev/sdk@1.11.0 exports --json`
Expected: the `./connector-kit` entry is present with `types`/`import`/`default` pointing into `dist`.

---

### Task 9: `Nimbus` — convert `shared/*.ts` to re-exports

**Working directory:** `C:\gitrep\Nimbus`

**Blocked on:** Task 8 — SDK 1.11.0 on the registry.

**Files:**
- Modify: `packages/mcp-connectors/shared/mcp-tool-kit.ts`, `fetch-bearer-json.ts`, `rest-tool-kit.ts`

- [ ] **Step 1: Replace each file's body with named re-exports**

Each file re-exports **its own symbols by name**, not `export *`. A blanket `export *` would make every shared file export every other's symbols, so a connector importing from two of them would see a much larger, ambiguous surface than it does today.

`shared/mcp-tool-kit.ts` becomes exactly the value and type re-exports listed in Task 5's barrel for that module, sourced from `@nimbus-dev/sdk/connector-kit`. Same for the other two.

**Do not touch `run-read-only-mcp-connector.ts`.** It imports `@modelcontextprotocol/sdk` directly, stays in Nimbus, and imports from `./mcp-tool-kit.ts` — which now re-exports, so it keeps working.

- [ ] **Step 2: Verify the monorepo still typechecks and lints**

Run the monorepo's own `typecheck` and `lint` across `packages/mcp-connectors/`. All 99 import sites must still resolve.

- [ ] **Step 3: The regression gate — Stage A's harness against the modified monorepo**

From `C:\gitrep\create-nimbus-connector`: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: all eight fixtures matching declared expectations, with `newrelic`/`datadog`/`grafana`/`sentry` still **6/6**.

This is the proof that the refactor did not change a single generated byte. **If any fixture moved, the re-export changed a connector's resolved surface — stop and report rather than adjusting the fixture.**

- [ ] **Step 4: Commit and open the PR**

```bash
git add packages/mcp-connectors/shared/
git commit -m "refactor(shared): re-export the connector kit from @nimbus-dev/sdk"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| B1 publish as `@nimbus-dev/sdk/connector-kit` | 5 |
| B2 SDK owns it; Nimbus re-exports | 5, 9 |
| B3 Biome optional with graceful degradation | 1 |
| B4 live stdio acceptance | 6 |
| B5 one spec, three repos, this one first | task ordering table |
| B6 CLI is Bun-only | 7 |
| B7 generated connectors are Bun-only | 3 (build target), 7 (documented) |
| The export barrel and its exact symbols | 5 |
| Must build to `dist` | 5 step 4, 6 step 5 guard |
| Version floor `^1.11.0` | 3 |
| Nimbus named re-exports, not `export *` | 9 |
| Target as a generation option | 2 |
| Per-target file differences | 2, 3 |
| Runtime support | 3, 7 |
| Build scripts | 3 |
| Standalone tsconfig | 3 |
| `formatAll` throws if uninitialised | 1 |
| Biome notice wording | 1 |
| Publishing (`bin`, `files`, shebang) | 7 |
| Acceptance criteria 1–5 | 6, 7 |
| Contract gates per step | 6 step 6, 8 step 1, 9 step 3 |

No spec section is unimplemented.

**Deliberate deviations:**

- The spec's export list for `fetch-bearer-json.ts` named two functions; the module also exports a type `BearerJsonFetchResult`. Task 5's barrel uses the verified list, which includes it.
- The spec does not say where a standalone connector lands when `--out-dir` is omitted. Task 4 defaults to `./<name>`, since `packages/mcp-connectors/<name>` is a monorepo-shaped path that makes no sense outside one.

**Type consistency:** `GenerateTarget` (Task 2) is consumed by Tasks 3, 4 and 6 under that exact name. `initFormatter`/`formatterAvailable`/`formatAll` (Task 1) are used by Tasks 4, 6 and 7 with those signatures. `resolveSdkRoot` (Task 6) mirrors `resolveNimbusRoot`'s option shape (`{ flag?, env?, scriptDir }`) rather than inventing a new one.
