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
