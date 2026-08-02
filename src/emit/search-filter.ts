import type { ConnectorSpec, ToolSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import type { GenerateTarget } from "./index.ts";

const SHARED = "../../shared/search-filter.ts";
const SEARCH_TOOL = "../../shared/mcp-search-tool.ts";
const KIT = "@nimbus-dev/sdk/connector-kit";

/** Sort key ignoring the `type ` prefix, which Biome does not consider when ordering. */
function byBareName(a: string, b: string): number {
  return a.replace("type ", "").localeCompare(b.replace("type ", ""));
}

/** A single-name import stays on one line; two or more use the wrapped block form. */
function renderBlockImport(names: readonly string[], from: string): string {
  if (names.length === 1) return `import { ${names[0]} } from "${from}";`;
  return ["import {", ...names.map((n) => `  ${n},`), `} from "${from}";`].join("\n");
}

/** Renders a string array the way Biome's formatter prints one: comma-space, no trailing comma
 *  on a single line. `JSON.stringify` alone omits the space after each comma. */
function renderStringArray(values: readonly string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

function keyedFilter(tool: ToolSpec): string {
  const keys = renderStringArray(tool.filter!.fields!);
  const opts = tool.filter!.tags ? ", { tags: true }" : "";
  return [
    `export const ${tool.filter!.export} = makeQueryFilter(`,
    `  fieldsFromKeys(${keys}${opts}),`,
    ");",
  ].join("\n");
}

/**
 * The stub replaces the FILTER, not the extractor, and that is load-bearing rather than
 * stylistic. makeQueryFilter returns a closure that defers to filterByQuery, which calls
 * options.fields(item) once per row — so a throwing extractor never fires on an empty
 * result set and the tool reports `{ matches: [] }` as success. Throwing from the filter
 * position fires on every invocation. See Stage D design §4.3.1.
 */
function stubFilter(tool: ToolSpec): string {
  // Deliberately does not name makeQueryFilter/fieldsFromKeys in this string: a stub-only
  // file imports neither (see filterNames below), and spelling them out here would make the
  // whole file "contain" those identifiers as a matter of prose, defeating any caller (e.g.
  // this emitter's own tests) that greps the emitted source to confirm the import is absent.
  const message = JSON.stringify(
    `${tool.name}: supply the searchable fields for this resource — replace this stub ` +
      "with a keyed filter (see search-filter.ts docs) or a bespoke extractor.",
  );
  return [
    `export const ${tool.filter!.export}: SearchFilter = () => {`,
    `  throw new Error(${message});`,
    "};",
  ].join("\n");
}

export function emitSearchFilter(
  spec: ConnectorSpec,
  target: GenerateTarget,
): GeneratedFile | undefined {
  const tools = spec.tools.filter((t) => t.impl === "search");
  if (tools.length === 0) return undefined;

  const anyKeyed = tools.some((t) => t.filter!.fields !== undefined);
  const anyStub = tools.some((t) => t.filter!.fields === undefined);

  // Only the symbols something in this file actually names — an unused import is a
  // noUnusedLocals error in the generated package, and biome's own lint rejects it too.
  const filterNames: string[] = [];
  if (anyKeyed) filterNames.push("fieldsFromKeys", "makeQueryFilter");
  filterNames.push("type SearchMatchOptions");
  filterNames.sort((a, b) => a.replace("type ", "").localeCompare(b.replace("type ", "")));

  const importLines =
    target === "standalone"
      ? // One barrel, so one import: the SDK's connector-kit re-exports SearchFilter
        // alongside the rest (Task 12). Gated on anyStub for the same reason as the
        // monorepo branch below — a standalone spec whose search tool(s) are all keyed
        // never names SearchFilter in its body, so importing it unconditionally would be
        // an unused import under the generated package's own noUnusedLocals.
        [
          renderBlockImport(
            (anyStub ? [...filterNames, "type SearchFilter"] : filterNames).sort(byBareName),
            KIT,
          ),
        ]
      : // Two modules in the monorepo, and the split is not cosmetic: SearchFilter is
        // declared in shared/mcp-search-tool.ts, NOT in shared/search-filter.ts. Emitting it
        // from the latter is an unresolved import that fails the connector's own tsc.
        // Both specifiers are relative, and "mcp-search-tool" sorts before "search-filter".
        [
          ...(anyStub ? [renderBlockImport(["type SearchFilter"], SEARCH_TOOL)] : []),
          renderBlockImport(filterNames, SHARED),
        ];

  const sections = [
    importLines.join("\n"),
    `export type ${spec.title}SearchMatchOptions = SearchMatchOptions;`,
    ...tools.map((t) => (t.filter!.fields === undefined ? stubFilter(t) : keyedFilter(t))),
  ];

  return { path: ["src", "search-filter.ts"], content: `${sections.join("\n\n")}\n` };
}
