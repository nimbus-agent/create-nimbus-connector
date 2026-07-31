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
    ({ Biome: BiomeCtor } = (await import("@biomejs/js-api/nodejs")) as {
      Biome: new () => BiomeLike;
    });
  } catch {
    // The ONLY tolerated failure: the optional dependency is not installed.
    available = false;
    return;
  }

  // Past this point Biome is present, so any failure is a programming error in the
  // configuration below — let it propagate rather than masquerading as "unavailable".
  const biome = new BiomeCtor();
  const { projectKey } = biome.openProject();
  biome.applyConfiguration(projectKey, FORMATTER_CONFIG);
  cached = { biome, projectKey };
  available = true;
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
