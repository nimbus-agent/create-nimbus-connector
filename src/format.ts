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

/**
 * The one formatter configuration this project formats with. Exported so
 * src/emit/biome-json.ts can ship exactly these settings inside a generated standalone
 * package: if the two ever diverged, `biome check src/` in a freshly generated package
 * would reformat the very bytes the generator just produced.
 */
export const FORMATTER_CONFIG = {
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
} as const;

let cached: Instance | undefined;
let initialised = false;
let available = false;
let unavailableReason: string | undefined;

const JS_API = "@biomejs/js-api/nodejs";
/** The wasm backend @biomejs/js-api imports; a separate optionalDependency of this repo. */
const WASM_BACKEND = "@biomejs/wasm-nodejs";

/**
 * True only when `err` is a module-resolution failure for `specifier` itself.
 *
 * Under Bun a failed dynamic import rejects with a ResolveMessage carrying `code`
 * ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND and a `specifier` field naming the module that
 * could not be found — which is the *inner* specifier when a package resolves but one of
 * its own imports does not. That difference is exactly what separates "@biomejs/js-api is
 * not installed" from "@biomejs/js-api is installed but its wasm backend is missing".
 */
function isMissingModule(err: unknown, specifier: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; specifier?: unknown; message?: unknown };
  if (e.code !== "ERR_MODULE_NOT_FOUND" && e.code !== "MODULE_NOT_FOUND") return false;
  // Prefer the structured field; fall back to the message only if a runtime omits it.
  if (typeof e.specifier === "string") return e.specifier === specifier;
  return typeof e.message === "string" && e.message.includes(specifier);
}

/**
 * Load Biome if it is installed. Idempotent, and never throws for a missing
 * dependency — @biomejs/js-api is an optionalDependency, so a consumer running
 * `bunx create-nimbus-connector` may not have it.
 */
export async function initFormatter(): Promise<void> {
  if (initialised) return;
  initialised = true;

  let BiomeCtor: new () => BiomeLike;
  try {
    ({ Biome: BiomeCtor } = (await import(JS_API)) as {
      Biome: new () => BiomeLike;
    });
  } catch (err) {
    // Two very different failures land here, and conflating them sends the user to fix a
    // package that is already installed:
    //   1. the optional dependency is genuinely absent — the tolerated case, since a
    //      `bunx create-nimbus-connector` consumer may not have it;
    //   2. it is present but could not load, most plausibly because its @biomejs/wasm-nodejs
    //      backend (a separate optionalDependency) is missing or corrupt.
    // Both still degrade to unformatted output rather than throwing — that is what
    // optionalDependencies are for, and a platform that cannot install the wasm backend
    // must not lose the generator entirely — but the reason recorded here is what callers
    // report, so case 2 surfaces the underlying error instead of a misdiagnosis.
    available = false;
    unavailableReason = isMissingModule(err, JS_API)
      ? `${JS_API} is not installed. It is an optionalDependency, so the generated files ` +
        "are unformatted; they are valid TypeScript and compile as-is."
      : `${JS_API} is installed but failed to load, so the generated files are unformatted. ` +
        `Reinstalling it alone will not help — check that its ${WASM_BACKEND} backend is ` +
        `present and intact. Underlying error: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  // Past this point Biome is present, so any failure is a programming error in the
  // configuration below — let it propagate rather than masquerading as "unavailable".
  const biome = new BiomeCtor();
  const { projectKey } = biome.openProject();
  biome.applyConfiguration(projectKey, FORMATTER_CONFIG);
  cached = { biome, projectKey };
  available = true;
  unavailableReason = undefined;
}

export function formatterAvailable(): boolean {
  return available;
}

/**
 * Why formatting is unavailable, or undefined when it is available (or before
 * initFormatter() has run). Callers print this instead of assuming "not installed" —
 * see the two cases enumerated in initFormatter().
 */
export function formatterUnavailableReason(): string | undefined {
  return available ? undefined : unavailableReason;
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
      const details = fatal
        .map((d) => `  [${d.category ?? "unknown"}] ${d.description}`)
        .join("\n");
      const kind = name.endsWith(".json") ? "JSON" : "TypeScript";
      throw new Error(
        `Biome could not format ${f.path.join("/")} — the emitted code is not valid ${kind}:\n${details}`,
      );
    }
    return { path: f.path, content };
  });
}
