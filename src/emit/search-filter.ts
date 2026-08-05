import {
  type ConnectorSpec,
  type FieldEntry,
  isPathEntry,
  resolveKeyedShape,
  type ToolSpec,
} from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import type { GenerateTarget } from "./index.ts";

const SHARED = "../../shared/search-filter.ts";
const SEARCH_TOOL = "../../shared/mcp-search-tool.ts";
const KIT = "@nimbus-dev/sdk/connector-kit";

/** The `fieldsFromKeys`-expressible shape of one filter's entries. */
type KeyedShape = { keys: readonly string[]; tags: boolean };

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

/**
 * The keyed shape, or undefined when the entries need a bespoke extractor. Thin wrapper over
 * `resolveKeyedShape` (src/spec.ts) — the single source of truth for the trailing-tags
 * convergence rule, shared with the schema's own superRefine and validateSpec's at-most-one-
 * extractor rule, so the three call sites cannot drift apart.
 */
function keyedShape(tool: ToolSpec): KeyedShape | undefined {
  const resolved = resolveKeyedShape(tool.filter!.fields!);
  if (resolved === undefined) return undefined;
  return { keys: resolved.keys, tags: tool.filter!.tags || resolved.trailingTagText };
}

/** One element of the extractor's returned array. */
function renderEntry(e: FieldEntry): string {
  if (typeof e === "string") return `stringField(row, ${JSON.stringify(e)})`;
  if (isPathEntry(e)) return `nestedString(row, ${renderStringArray(e.path)})`;
  return e.tags === "objects" ? "tagNamesFromObjects(row)" : "tagText(row)";
}

/**
 * The bespoke-extractor form. The guard is always asObjectish; argocd's asRecord is not
 * derivable from the field list and stays a documented difference (Stage E design).
 */
function extractorFilter(tool: ToolSpec): string {
  const entries = tool.filter!.fields!;
  return [
    "function fieldsOf(item: unknown): readonly string[] | null {",
    "  const row = asObjectish(item);",
    "  if (row === undefined) {",
    "    return null;",
    "  }",
    "  return [",
    ...entries.map((e) => `    ${renderEntry(e)},`),
    "  ];",
    "}",
    "",
    `export const ${tool.filter!.export} = makeQueryFilter(fieldsOf);`,
  ].join("\n");
}

/** The shared primitives a set of entries names, for the import list. */
function primitivesFor(entries: readonly FieldEntry[]): string[] {
  const names = new Set<string>(["asObjectish"]);
  for (const e of entries) {
    if (typeof e === "string") names.add("stringField");
    else if (isPathEntry(e)) names.add("nestedString");
    else names.add(e.tags === "objects" ? "tagNamesFromObjects" : "tagText");
  }
  return [...names];
}

function keyedFilter(tool: ToolSpec, shape: KeyedShape): string {
  const keys = renderStringArray(shape.keys);
  const opts = shape.tags ? ", { tags: true }" : "";
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

/**
 * Only the symbols something in the emitted file actually names — an unused import is a
 * noUnusedLocals error in the generated package, and biome's own lint rejects it too.
 * Returned already sorted by `byBareName`, the order both import forms print in.
 */
function filterImportNames(
  keyedTools: readonly ToolSpec[],
  extractorTools: readonly ToolSpec[],
): string[] {
  const filterNames: string[] = [];
  if (keyedTools.length > 0) filterNames.push("fieldsFromKeys");
  if (keyedTools.length > 0 || extractorTools.length > 0) filterNames.push("makeQueryFilter");
  for (const t of extractorTools) {
    for (const n of primitivesFor(t.filter!.fields!)) {
      if (!filterNames.includes(n)) filterNames.push(n);
    }
  }
  filterNames.push("type SearchMatchOptions");
  filterNames.sort(byBareName);
  return filterNames;
}

/** The emitted file's import prologue: one barrel standalone, two modules in the monorepo. */
function renderImportLines(
  target: GenerateTarget,
  filterNames: readonly string[],
  anyStub: boolean,
): string[] {
  if (target === "standalone") {
    // One barrel, so one import: the SDK's connector-kit re-exports SearchFilter
    // alongside the rest (Task 12). Gated on anyStub for the same reason as the
    // monorepo branch below — a standalone spec whose search tool(s) are all keyed
    // never names SearchFilter in its body, so importing it unconditionally would be
    // an unused import under the generated package's own noUnusedLocals.
    const names = anyStub ? [...filterNames, "type SearchFilter"] : [...filterNames];
    return [renderBlockImport(names.toSorted(byBareName), KIT)];
  }
  // Two modules in the monorepo, and the split is not cosmetic: SearchFilter is
  // declared in shared/mcp-search-tool.ts, NOT in shared/search-filter.ts. Emitting it
  // from the latter is an unresolved import that fails the connector's own tsc.
  // Both specifiers are relative, and "mcp-search-tool" sorts before "search-filter".
  return [
    ...(anyStub ? [renderBlockImport(["type SearchFilter"], SEARCH_TOOL)] : []),
    renderBlockImport(filterNames, SHARED),
  ];
}

/** Which of the three filter forms one search tool emits: stub, bespoke extractor, or keyed. */
function renderToolFilter(tool: ToolSpec, shape: KeyedShape | undefined): string {
  if (tool.filter!.fields === undefined) return stubFilter(tool);
  return shape === undefined ? extractorFilter(tool) : keyedFilter(tool, shape);
}

export function emitSearchFilter(
  spec: ConnectorSpec,
  target: GenerateTarget,
): GeneratedFile | undefined {
  const tools = spec.tools.filter((t) => t.impl === "search");
  if (tools.length === 0) return undefined;

  const shapes = new Map<ToolSpec, KeyedShape | undefined>();
  for (const t of tools) {
    shapes.set(t, t.filter!.fields === undefined ? undefined : keyedShape(t));
  }

  const keyedTools = tools.filter((t) => shapes.get(t) !== undefined);
  const extractorTools = tools.filter(
    (t) => t.filter!.fields !== undefined && shapes.get(t) === undefined,
  );
  const anyStub = tools.some((t) => t.filter!.fields === undefined);

  const importLines = renderImportLines(
    target,
    filterImportNames(keyedTools, extractorTools),
    anyStub,
  );

  const sections = [
    importLines.join("\n"),
    `export type ${spec.title}SearchMatchOptions = SearchMatchOptions;`,
    ...tools.map((t) => renderToolFilter(t, shapes.get(t))),
  ];

  return { path: ["src", "search-filter.ts"], content: `${sections.join("\n\n")}\n` };
}
