import { createRequire } from "node:module";
import { Biome } from "@biomejs/js-api/nodejs";
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
