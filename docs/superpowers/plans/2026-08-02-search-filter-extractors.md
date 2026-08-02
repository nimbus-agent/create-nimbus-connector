# Search-filter field extractors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `filter.fields` from a flat key list to three entry kinds — plain key, dotted path, tag helper — so the emitter composes the primitives `shared/search-filter.ts` already exports instead of emitting a throwing stub.

**Architecture:** One new rendering branch in `src/emit/search-filter.ts`. Which branch is taken is *derived* from the entry kinds present, never selected by a spec field. Specs containing only plain-string entries cannot reach the new branch, which is how the existing byte-matches are preserved. The emitter composes only helpers that already ship in both `../../shared/search-filter.ts` (monorepo) and `@nimbus-dev/sdk/connector-kit` (standalone).

**Tech Stack:** Bun, TypeScript, zod 4 (`^4.4.2`), Biome 2.5.6, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-02-search-filter-extractors-design.md`

## Global Constraints

- **Bun only.** No Node, npm or pnpm path. Tests import `bun:test`.
- **No connector source, and no `shared/` source, may be copied from Nimbus into this repository** — not into `src/`, `test/` or `fixtures/`. Fixture specs are hand-written from the API shape. This is a licensing constraint, not a style preference.
- **Emitters return UNFORMATTED source.** `generate()` is pure; output goes through `formatAll()`, which runs the real Biome. Never hand-align indentation. Do hand-manage line breaks.
- **The byte-safety invariant:** `newrelic`, `datadog`, `grafana` and `sentry` reproduce 6/6 files and must stay there. Run `diff:golden` after any emitter change and confirm all four still report `6/6`.
- **`fixtures/expectations.json` is never edited to hide a mismatch.** The harness treats matching *more* files than declared as a failure ("improved"), so a new fixture's entry must list exactly the files that byte-match — no more, no less.
- **Never commit on `main`.** This work happens on `worktree-stage-e`.
- **Conventional Commits.** `feat:` bumps the minor, `fix:` the patch.
- Comments explain **why**, and cite the corpus measurement behind a choice where one exists.
- Nimbus checkout for local gates: `C:/gitrep/Nimbus`. SDK checkout: `C:/gitrep/nimbus-sdk`.

---

### Task 1: Spec schema — the three entry kinds

**Files:**
- Modify: `src/spec.ts:51-60` (`SearchFilterSchema`)
- Test: `test/spec.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FieldEntry` type and `SearchFilterSchema`. Later tasks rely on these exact shapes:
  - a plain key is a `string`
  - a path entry is `{ path: string[] }` (length ≥ 2, each segment non-empty)
  - a tag entry is `{ tags: "text" | "objects" }`
  - `filter.fields?: FieldEntry[]`, `filter.tags: boolean` (defaulted, unchanged)

  These are **mutable** arrays, because that is what `z.array()` infers and what `fields`
  already infers today. Do not add `.readonly()` to make them match a `readonly` annotation:
  a mutable array is assignable to a `readonly string[]` parameter, so `renderStringArray`
  and `primitivesFor` accept them unchanged, and adding it would ripple through inferred
  types across `ConnectorSpec` for no benefit.

- [ ] **Step 1: Write the failing tests**

Add to `test/spec.test.ts`:

```ts
describe("SearchFilterSchema field entries", () => {
  const withFilter = (filter: unknown) =>
    parseSpec({
      name: "mercury",
      title: "Mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style: "read-only-kit",
      fetchHelper: { local: "mercuryGet", base: "https://api.mercury.com" },
      tools: [
        { name: "s", description: "S.", impl: "search", path: "/v1/x", filter },
      ],
    });

  it("accepts a plain key, a path entry and a tag entry together", () => {
    const spec = withFilter({
      export: "filterX",
      fields: ["name", { path: ["spec", "source", "repoURL"] }, { tags: "objects" }],
    });
    expect(spec.tools[0]!.filter!.fields).toEqual([
      "name",
      { path: ["spec", "source", "repoURL"] },
      { tags: "objects" },
    ]);
  });

  it("rejects a single-segment path and names the plain-string spelling", () => {
    expect(() => withFilter({ export: "filterX", fields: [{ path: ["name"] }] })).toThrow(
      /"name"/,
    );
  });

  it("rejects an empty path segment", () => {
    expect(() => withFilter({ export: "filterX", fields: [{ path: ["spec", ""] }] })).toThrow();
  });

  it("accepts a whitespace-only path segment, which is a legal JSON key", () => {
    const spec = withFilter({ export: "filterX", fields: [{ path: ["spec", " "] }] });
    expect(spec.tools[0]!.filter!.fields).toEqual([{ path: ["spec", " "] }]);
  });

  it("rejects an unknown key inside an entry object", () => {
    expect(() =>
      withFilter({ export: "filterX", fields: [{ path: ["a", "b"], tag: "objects" }] }),
    ).toThrow();
  });

  it("rejects an unknown tag format", () => {
    expect(() => withFilter({ export: "filterX", fields: [{ tags: "nope" }] })).toThrow();
  });

  it("rejects legacy tags:true alongside a tag entry, naming both", () => {
    expect(() =>
      withFilter({ export: "filterX", fields: ["name", { tags: "text" }], tags: true }),
    ).toThrow(/tags/);
  });

  it("reports a malformed entry with the three legal shapes, not \"Invalid input\"", () => {
    // Verified against zod 4.4.2: an untagged union reports ONE issue, not one per branch,
    // and its default message is the useless "Invalid input". The custom error is what makes
    // the failure actionable.
    expect(() =>
      withFilter({ export: "filterX", fields: [{ pat: ["a", "b"] }] }),
    ).toThrow(/a field entry must be a key string/);
  });

  it("still accepts the flat 0.4.0 shape unchanged", () => {
    const spec = withFilter({ export: "filterX", fields: ["id", "name"], tags: true });
    expect(spec.tools[0]!.filter!.fields).toEqual(["id", "name"]);
    expect(spec.tools[0]!.filter!.tags).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/spec.test.ts`
Expected: FAIL — the path/tag entry cases fail because `fields` is still `z.array(z.string())`.

- [ ] **Step 3: Implement the schema**

Replace `src/spec.ts:51-60` with:

```ts
/**
 * One searchable field. A plain string is a top-level key; `path` reads a nested one via the
 * shared `nestedString`; `tags` selects one of the two shared tag helpers.
 *
 * The union is untagged because the required-key sets are disjoint — an entry is a string, or
 * has `path`, or has `tags`. A `"type"` discriminator was declined in review: it is paid on
 * every entry an author writes, and a future kind is either a new disjoint shape or an optional
 * key on an existing one.
 */
const PathEntrySchema = z.strictObject({
  path: z.array(z.string().min(1, "a path segment cannot be empty")),
});

const TagsEntrySchema = z.strictObject({
  /** "text" -> tagText (a string[] under `tags`); "objects" -> tagNamesFromObjects ({name}[]). */
  tags: z.enum(["text", "objects"]),
});

/**
 * The custom error is not decoration. Verified against zod 4.4.2: a failing untagged union
 * reports a single issue whose default message is "Invalid input" — it names neither what was
 * given nor what was expected. (It does *not* dump one failure per branch; that is zod 3
 * behaviour.) This message is the only thing that makes a malformed entry actionable.
 */
export const FieldEntrySchema = z.union([z.string().min(1), PathEntrySchema, TagsEntrySchema], {
  error:
    'a field entry must be a key string, { "path": [...] } with two or more segments, or ' +
    '{ "tags": "text" | "objects" }',
});

export type FieldEntry = z.infer<typeof FieldEntrySchema>;

export function isPathEntry(e: FieldEntry): e is z.infer<typeof PathEntrySchema> {
  return typeof e === "object" && "path" in e;
}

export function isTagsEntry(e: FieldEntry): e is z.infer<typeof TagsEntrySchema> {
  return typeof e === "object" && "tags" in e;
}

/**
 * The per-connector search filter. `fields` omitted means the emitter cannot express the
 * extraction and emits a throwing stub instead — of the 40 corpus filter files that hand-write
 * an extractor, 7 are reachable with these entry kinds, 32 call a locally-defined helper and
 * one is hand-rolled. See the Stage E extractor design.
 */
export const SearchFilterSchema = z
  .strictObject({
    export: identifierField(),
    fields: z
      .array(FieldEntrySchema)
      .min(1, "a filter must name at least one field")
      .optional(),
    tags: z.boolean().default(false),
  })
  .superRefine((f, ctx) => {
    if (f.fields === undefined) return;

    for (const [i, e] of f.fields.entries()) {
      // A one-segment path and a plain key emit identical output. Accepting both spellings for
      // one emission is an ambiguity, and normalising it silently would hide a likely typo.
      if (isPathEntry(e) && e.path.length < 2) {
        const only = e.path[0];
        ctx.addIssue({
          code: "custom",
          path: ["fields", i, "path"],
          message:
            `"path": ${JSON.stringify(e.path)} has fewer than two segments. A single-segment ` +
            `path emits the same call as the plain key ${JSON.stringify(only ?? "")} — write ` +
            "the plain string form instead.",
        });
      }
    }

    // A precedence rule here would be invisible in the emitted file, so both spellings at once
    // is an error rather than one winning.
    if (f.tags && f.fields.some(isTagsEntry)) {
      ctx.addIssue({
        code: "custom",
        path: ["tags"],
        message:
          'a filter sets legacy "tags": true and also lists a { "tags": ... } entry in ' +
          '"fields". Use one: the entry form if you need "objects", otherwise "tags": true.',
      });
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/spec.test.ts`
Expected: PASS.

Then run the whole suite:

Run: `bun test && bunx tsc --noEmit`
Expected: PASS.

`ToolSchema` calls `.optional()` on `SearchFilterSchema`, which now carries a `superRefine`.
That is safe here and needs no workaround: **verified against zod 4.4.2**, `.superRefine()` on
a `strictObject` returns a `ZodObject`, not a `ZodEffects` — `.optional()`, `.extend()` and
`.pick()` all remain present and working. The `ZodEffects`-loses-object-methods problem is zod 3
behaviour and does not apply to this codebase.

- [ ] **Step 5: Commit**

```bash
git add src/spec.ts test/spec.test.ts
git commit -m "feat(spec): accept path and tag entries in filter.fields"
```

---

### Task 2: Identifier safety

**Files:**
- Modify: `src/validate.ts:6-76` (`RESERVED_IDENTIFIERS`), `src/validate.ts:119-138` (the tool loop in `validateSpec`)
- Test: `test/validate.test.ts`

**Interfaces:**
- Consumes: `filter.export` from Task 1's schema.
- Produces: nothing later tasks call directly. Task 4 and 5 fixtures must not use any newly reserved name.

**Collision pre-check — already run, no action needed.** The reserved list constrains *this
repository's* `fixtures/*.spec.json`, not Nimbus: Nimbus connectors are hand-written, not
generated, so no Nimbus-side spec exists to collide. Checked on 2026-08-02 across all 17
fixtures for `local`, `tokenLocal`, `baseConst`, `export` and argument names matching any of
the eight new entries — **none**. Re-run it in Task 4 and 5 when adding a fixture:

```bash
grep -nE '"(local|tokenLocal|baseConst|export)"\s*:\s*"(fieldsOf|asObjectish|stringField|nestedString|tagText|tagNamesFromObjects|makeQueryFilter|fieldsFromKeys)"' fixtures/*.spec.json
```

- [ ] **Step 1: Write the failing tests**

Add to `test/validate.test.ts`:

```ts
it("rejects a filter export that collides with the fetch helper", () => {
  expect(() =>
    parseSpec({
      name: "mercury",
      title: "Mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style: "read-only-kit",
      fetchHelper: { local: "mercuryGet", base: "https://api.mercury.com" },
      tools: [
        {
          name: "s",
          description: "S.",
          impl: "search",
          path: "/v1/x",
          filter: { export: "mercuryGet", fields: ["id"] },
        },
      ],
    }),
  ).toThrow(/mercuryGet/);
});

it.each(["fieldsOf", "stringField", "nestedString", "tagText", "tagNamesFromObjects", "asObjectish", "makeQueryFilter", "fieldsFromKeys"])(
  "reserves %s against a filter export",
  (name) => {
    expect(() =>
      parseSpec({
        name: "mercury",
        title: "Mercury",
        displayName: "Mercury",
        description: "d.",
        serviceLabel: "Mercury",
        style: "read-only-kit",
        fetchHelper: { local: "mercuryGet", base: "https://api.mercury.com" },
        tools: [
          {
            name: "s",
            description: "S.",
            impl: "search",
            path: "/v1/x",
            filter: { export: name, fields: ["id"] },
          },
        ],
      }),
    ).toThrow(/reserved/);
  },
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/validate.test.ts`
Expected: FAIL — `filter.export` is currently never claimed, so no error is thrown.

- [ ] **Step 3: Implement**

In `src/validate.ts`, append to `RESERVED_IDENTIFIERS` before the closing `];`:

```ts
  // Stage E's extractor branch. src/server.ts imports the filter export from
  // ./search-filter.ts, so that name lands in server.ts's module scope beside the fetch
  // helper; the rest are declared or imported by src/search-filter.ts itself.
  //
  //   fieldsOf                 the extractor the fieldsOf branch declares
  //   asObjectish              its guard
  //   stringField              plain-key entries
  //   nestedString             path entries
  //   tagText/tagNamesFromObjects   tag entries
  //   makeQueryFilter/fieldsFromKeys  emitted since Stage D, never reserved until now
  //
  // Reserved flat and unconditionally, matching the rule the list already states: making an
  // entry conditional would mean a spec validating or failing depending on a field elsewhere
  // in the file. This slightly over-rejects — an env accessor named "stringField" collides
  // with nothing real — and that cost is accepted for one rule instead of two.
  "fieldsOf",
  "asObjectish",
  "stringField",
  "nestedString",
  "tagText",
  "tagNamesFromObjects",
  "makeQueryFilter",
  "fieldsFromKeys",
```

In `validateSpec`, inside `for (const t of spec.tools) {`, immediately after the `toolNames.add(t.name);` line:

```ts
    // server.ts does `import { <export> } from "./search-filter.ts"`, so the filter export
    // occupies server.ts's module scope too — not only search-filter.ts's.
    if (t.filter !== undefined) {
      claim(seen, t.filter.export, `the search filter for tool ${t.name}`);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/validate.test.ts && bun test && bunx tsc --noEmit`
Expected: PASS. If an existing fixture spec now fails to parse because its `filter.export` collides, that is a real finding — report it rather than renaming the reserved entry.

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts test/validate.test.ts
git commit -m "fix(validate): claim filter.export and reserve the extractor identifiers"
```

---

### Task 3: The emitter

**Files:**
- Modify: `src/emit/search-filter.ts`
- Test: `test/emit/search-filter.test.ts`

**Interfaces:**
- Consumes: `FieldEntry`, `isPathEntry`, `isTagsEntry` from `src/spec.ts` (Task 1).
- Produces: no new exports. `emitSearchFilter(spec, target)` keeps its current signature: `(spec: ConnectorSpec, target: GenerateTarget) => GeneratedFile | undefined`.

**Rendering table this task implements** (from the spec):

| Spec shape | Emission |
| --- | --- |
| all plain strings, `tags` absent/false | `makeQueryFilter(fieldsFromKeys([...]))` |
| all plain strings, `tags: true` | `makeQueryFilter(fieldsFromKeys([...], { tags: true }))` |
| all plain strings + trailing `{"tags":"text"}` | `makeQueryFilter(fieldsFromKeys([...], { tags: true }))` |
| any `path`, non-trailing `{"tags":…}`, or `{"tags":"objects"}` | `function fieldsOf(…)` + `makeQueryFilter(fieldsOf)` |
| `fields` omitted | throwing stub (unchanged) |

- [ ] **Step 1: Write the failing tests**

Add to `test/emit/search-filter.test.ts`:

```ts
const PATHS = {
  ...KEYED,
  filter: {
    export: "filterMercuryAccounts",
    fields: ["name", { path: ["spec", "source", "repoURL"] }],
  },
};

it("emits a fieldsOf extractor when a path entry is present", () => {
  const file = emitSearchFilter(make([PATHS]), "monorepo")!;
  expect(file.content).toContain("function fieldsOf(item: unknown): readonly string[] | null {");
  expect(file.content).toContain("const row = asObjectish(item);");
  expect(file.content).toContain('stringField(row, "name")');
  expect(file.content).toContain('nestedString(row, ["spec", "source", "repoURL"])');
  expect(file.content).toContain(
    "export const filterMercuryAccounts = makeQueryFilter(fieldsOf);",
  );
});

it("renders each tag format with its own helper", () => {
  const objects = emitSearchFilter(
    make([{ ...KEYED, filter: { export: "f", fields: ["a", { tags: "objects" }] } }]),
    "monorepo",
  )!;
  expect(objects.content).toContain("tagNamesFromObjects(row)");

  const midText = emitSearchFilter(
    make([{ ...KEYED, filter: { export: "f", fields: [{ tags: "text" }, "a"] } }]),
    "monorepo",
  )!;
  expect(midText.content).toContain("tagText(row)");
  expect(midText.content).toContain("function fieldsOf(");
});

it("falls back to fieldsOf for multiple tag entries", () => {
  // Only a SINGLE trailing {tags:"text"} converges, because fieldsFromKeys appends exactly one
  // tagText. Two tag entries cannot be expressed by it, whatever their order.
  const twoText = emitSearchFilter(
    make([{ ...KEYED, filter: { export: "f", fields: ["a", { tags: "text" }, { tags: "text" }] } }]),
    "monorepo",
  )!;
  expect(twoText.content).toContain("function fieldsOf(");
  expect(twoText.content).not.toContain("fieldsFromKeys");

  const mixed = emitSearchFilter(
    make([
      { ...KEYED, filter: { export: "f", fields: ["a", { tags: "text" }, { tags: "objects" }] } },
    ]),
    "monorepo",
  )!;
  expect(mixed.content).toContain("function fieldsOf(");
  expect(mixed.content).toContain("tagText(row)");
  expect(mixed.content).toContain("tagNamesFromObjects(row)");
});

it("converges a trailing {tags:'text'} with legacy tags:true, byte for byte", () => {
  const entry = emitSearchFilter(
    make([{ ...KEYED, filter: { export: "f", fields: ["id", { tags: "text" }] } }]),
    "monorepo",
  )!;
  const legacy = emitSearchFilter(
    make([{ ...KEYED, filter: { export: "f", fields: ["id"], tags: true } }]),
    "monorepo",
  )!;
  expect(entry.content).toBe(legacy.content);
  expect(entry.content).toContain('fieldsFromKeys(["id"], { tags: true })');
  expect(entry.content).not.toContain("fieldsOf");
});

it("imports only the primitives the entries actually use", () => {
  const file = emitSearchFilter(make([PATHS]), "monorepo")!;
  expect(file.content).toContain("nestedString");
  expect(file.content).not.toContain("tagText");
  expect(file.content).not.toContain("tagNamesFromObjects");
  // The emitted form is a function declaration that annotates its own signature, and the
  // guard is always asObjectish.
  expect(file.content).not.toContain("FieldExtractor");
  expect(file.content).not.toContain("asRecord");
});

it("resolves the extractor primitives from the kit on standalone", () => {
  const file = emitSearchFilter(make([PATHS]), "standalone")!;
  expect(file.content).toContain('} from "@nimbus-dev/sdk/connector-kit";');
  expect(file.content).not.toContain("../../shared/search-filter.ts");
});

it("leaves a plain-string-only filter on the fieldsFromKeys path", () => {
  const file = emitSearchFilter(make([KEYED]), "monorepo")!;
  expect(file.content).not.toContain("fieldsOf");
  expect(file.content).toContain('fieldsFromKeys(["id", "name"])');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/emit/search-filter.test.ts`
Expected: FAIL — no `fieldsOf` branch exists yet.

- [ ] **Step 3: Implement**

In `src/emit/search-filter.ts`, add the import of the entry helpers to the existing `import type { ConnectorSpec, ToolSpec } from "../spec.ts";` line:

```ts
import { type ConnectorSpec, type FieldEntry, isPathEntry, isTagsEntry, type ToolSpec } from "../spec.ts";
```

Add these functions above `keyedFilter`:

```ts
/**
 * The keyed shape, or undefined when the entries need a bespoke extractor.
 *
 * `fieldsFromKeys` appends `tagText(row)` *after* the keyed fields when `opts.tags` is set, so
 * a trailing `{ tags: "text" }` is byte-identical to legacy `tags: true` and is emitted as
 * such — an author who prefers the newer spelling does not silently lose a byte-match. Trailing
 * is load-bearing: that helper can only append, so a tag entry in any other position changes
 * field order. `{ tags: "objects" }` has no equivalent — fieldsFromKeys hardcodes tagText.
 */
function keyedShape(tool: ToolSpec): { keys: string[]; tags: boolean } | undefined {
  const entries = tool.filter!.fields!;
  const last = entries.at(-1);
  const trailingTagText = last !== undefined && isTagsEntry(last) && last.tags === "text";
  const body = trailingTagText ? entries.slice(0, -1) : entries;
  if (!body.every((e): e is string => typeof e === "string")) return undefined;
  return { keys: body, tags: tool.filter!.tags || trailingTagText };
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
```

Change `keyedFilter` to take the resolved shape rather than re-deriving it:

```ts
function keyedFilter(tool: ToolSpec, shape: { keys: string[]; tags: boolean }): string {
  const keys = renderStringArray(shape.keys);
  const opts = shape.tags ? ", { tags: true }" : "";
  return [
    `export const ${tool.filter!.export} = makeQueryFilter(`,
    `  fieldsFromKeys(${keys}${opts}),`,
    ");",
  ].join("\n");
}
```

In `emitSearchFilter`, replace the `anyKeyed` / `filterNames` / `sections` logic with:

```ts
  const shapes = new Map<ToolSpec, { keys: string[]; tags: boolean } | undefined>();
  for (const t of tools) {
    shapes.set(t, t.filter!.fields === undefined ? undefined : keyedShape(t));
  }

  const keyedTools = tools.filter((t) => shapes.get(t) !== undefined);
  const extractorTools = tools.filter(
    (t) => t.filter!.fields !== undefined && shapes.get(t) === undefined,
  );
  const anyStub = tools.some((t) => t.filter!.fields === undefined);

  // Only the symbols something in this file actually names — an unused import is a
  // noUnusedLocals error in the generated package, and biome's own lint rejects it too.
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
```

and the `sections` array's last element with:

```ts
    ...tools.map((t) => {
      if (t.filter!.fields === undefined) return stubFilter(t);
      const shape = shapes.get(t);
      return shape === undefined ? extractorFilter(t) : keyedFilter(t, shape);
    }),
```

Note the pre-existing sort in the current code uses an inline comparator identical to `byBareName`; use `byBareName` so there is one comparator.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/emit/search-filter.test.ts && bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/`
Expected: PASS.

- [ ] **Step 5: Confirm the byte-safety invariant is intact**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: `newrelic`, `datadog`, `grafana`, `sentry` each `6/6`; `mercury` and `zendesk` each `6/7`; every fixture `PASS`; final line `All fixtures match their declared expectations.`

If any of those six moved, stop and report — a plain-string-only spec must not be able to reach the new branch.

- [ ] **Step 6: Commit**

```bash
git add src/emit/search-filter.ts test/emit/search-filter.test.ts
git commit -m "feat(emit): compose shared extractor primitives for path and tag entries"
```

---

### Task 4: The `dependencytrack` fixture — the byte proof

**Files:**
- Create: `fixtures/dependencytrack.spec.json`
- Modify: `fixtures/expectations.json`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: the one real connector this change makes byte-exact. This task is what distinguishes "the emission is plausible" from "the emission is right".

`dependencytrack` is the target because it guards with `asObjectish`, names its extractor `fieldsOf`, carries no hand-written doc comment, and its fields are three plain keys plus `tagNamesFromObjects`.

- [ ] **Step 1: Read the real connector to derive the spec**

Read `C:/gitrep/Nimbus/packages/mcp-connectors/dependencytrack/` — `nimbus.extension.json`, `package.json`, `src/server.ts`, `src/*-filter.ts`, `tsconfig.json`.

**Write the spec by hand from what those describe.** Do not copy source into this repository — see Global Constraints.

- [ ] **Step 2: Write the fixture spec**

Create `fixtures/dependencytrack.spec.json` following the shape of `fixtures/zendesk.spec.json`, with the filter block:

```jsonc
"filter": {
  "export": "filterDependencyTrackProjects",
  "fields": ["name", "version", "classifier", { "tags": "objects" }]
}
```

Match `export`, field names and field **order** to the real file — order is load-bearing for a byte match, because it is the order of the returned array.

- [ ] **Step 3: Run the harness to discover what actually matches**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: `FAIL dependencytrack` — it has no `expectations.json` entry yet, so every matching file is "gained".

Read the reported `gained` list. That list *is* the expectation entry.

- [ ] **Step 4: Record the expectation honestly**

Add a `"dependencytrack"` key to `fixtures/expectations.json` listing **exactly** the files the harness reported as identical — no more, no less. Files that do not match are omitted so the gap stays on screen on every run.

Do not add a file to the list hoping it will match. Do not remove a file from the emitted set to make the list shorter.

- [ ] **Step 5: Verify**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: `PASS dependencytrack`, and `src/search-filter.ts` among its identical files. All four locked fixtures still `6/6`.

If `src/search-filter.ts` does **not** match, read the diff. The likely causes, in order: field order, the import list order, or Biome collapsing the returned array onto one line where the real file breaks it (or the reverse). Line breaks inside the returned array are Biome's decision based on width, not the emitter's — do not hand-tune indentation to chase it.

- [ ] **Step 6: Commit**

```bash
git add fixtures/dependencytrack.spec.json fixtures/expectations.json
git commit -m "test(golden): add the dependencytrack fixture, byte-exact on its filter"
```

---

### Task 5: The `zzextract` fixture — all three kinds, standalone path

**Files:**
- Create: `fixtures/zzextract.spec.json`
- Modify: `fixtures/expectations.json`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: coverage of all three entry kinds in one emitted file, and the standalone/registry path for the new primitives.

No snapshot is needed: `listWriteFixtures` only snapshots fixtures with a tool whose `effect` is not `read`, and this fixture is read-only.

- [ ] **Step 1: Write the fixture**

Create `fixtures/zzextract.spec.json` modelled on `fixtures/zzsearch.spec.json`, with two search tools:

```jsonc
{
  "name": "zzextract",
  "title": "Zzextract",
  "displayName": "ZZ Extract",
  "description": "Throwaway standalone acceptance connector exercising all three filter entry kinds: plain keys, a dotted path, and both tag helpers.",
  "serviceLabel": "ZZ Extract",
  "style": "read-only-kit",
  "network": ["api.zzextract.test"],
  "syncInterval": 300,
  "minNimbusVersion": "0.2.0",
  "env": [
    { "vars": ["ZZEXTRACT_TOKEN"], "local": "headers", "bindings": ["t"], "auth": "bearer" }
  ],
  "fetchHelper": {
    "local": "zzGet",
    "base": "https://api.zzextract.test",
    "headers": "headers"
  },
  "tools": [
    {
      "name": "zzextract_app_search",
      "description": "Substring search across apps. Matches name, nested repo URL and tag names.",
      "impl": "search",
      "path": "/v1/apps",
      "rows": "items",
      "filter": {
        "export": "filterZzextractApps",
        "fields": [
          "name",
          { "path": ["spec", "source", "repoURL"] },
          { "tags": "objects" }
        ]
      }
    },
    {
      "name": "zzextract_item_search",
      "description": "Substring search across items. Matches id and status, plus plain tag names.",
      "impl": "search",
      "path": "/v1/items",
      "rows": "items",
      "filter": {
        "export": "filterZzextractItems",
        "fields": ["id", "status", { "tags": "text" }]
      }
    }
  ]
}
```

The second tool's trailing `{ "tags": "text" }` deliberately exercises the convergence rule — it must emit `fieldsFromKeys(["id", "status"], { tags: true })`, not a `fieldsOf`, and the emitted file must therefore contain **both** forms.

- [ ] **Step 2: Register the expectation**

Add `"zzextract": []` to `fixtures/expectations.json`, matching every other `zz*` fixture — there is no real connector to compare against, so nothing is expected to be identical.

- [ ] **Step 3: Verify the emission**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: `PASS zzextract  0/7 files identical (expected partial)` with each file reported `MISSING`.

Then inspect the generated file directly:

Run: `bun run src/cli.ts --spec fixtures/zzextract.spec.json --dry-run`
(`--spec` takes the file and supplies the name; there is no positional argument in this form.)
Expected: `src/search-filter.ts` contains one `fieldsOf` extractor **and** one `fieldsFromKeys([...], { tags: true })`, and its import list contains `asObjectish`, `fieldsFromKeys`, `makeQueryFilter`, `nestedString`, `stringField`, `tagNamesFromObjects` — but **not** `tagText` (no non-trailing text entry) and not `asRecord` or `FieldExtractor`.

- [ ] **Step 4: Verify the standalone path against the published SDK**

Run: `bun run standalone-acceptance --registry`
Expected: fully verified, **not** `SKIP`. All six primitives ship in `@nimbus-dev/sdk` from the 1.15.0 release commit and npm is at 1.16.0, so a `SKIP` here means the fixture's declared SDK floor is wrong, not that the primitives are missing.

A skipped run does not print the sentence a fully-verified run prints. Do not report a skipped run as a pass.

- [ ] **Step 5: Commit**

```bash
git add fixtures/zzextract.spec.json fixtures/expectations.json
git commit -m "test(golden): add zzextract covering all three filter entry kinds"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/ROADMAP.md` (Stage E, *Known limitations*)
- Modify: `README.md` if it documents `filter.fields`

**Interfaces:**
- Consumes: the measured outcome of Tasks 3–5.
- Produces: the durable record. Live numbers stay out — `diff:golden` is the answer.

- [ ] **Step 1: Rewrite the Stage E bespoke-extractor bullet**

Replace:

```markdown
- [ ] **Bespoke field extractors.** 40 of the 49 filter files hand-write an extractor the
      generator emits a throwing stub for.
```

with a `[~]` item recording the A/B/C breakdown (7 reachable / 32 local-helper / 1 hand-rolled) and stating that `filter.fields` now takes path and tag entries. Do not restate a pass rate.

- [ ] **Step 2: Correct the multi-file bullet**

The current bullet names `elasticsearch` and `storybook`. Measured against the checkout at `f4e9d93d`, **16** connectors carry `src/tools.ts` and `server.ts` imports it in **15** of them. Correct the count and keep the two names as examples.

- [ ] **Step 3: Add the byte gap to *Known limitations***

Under *Shape variance the emitter models one way*, add: Group A files that will not byte-match, and why — the guard (`argocd` uses `asRecord`, the emitter always writes `asObjectish`, and these differ for array rows), the extractor form (`const buildFields: FieldExtractor = …` in `firebase`/`testflight`), the extractor name, and the hand-written 4–5 line doc comments in `canva`, `figma`, `firebase`, `salesforce` and `testflight` — the same content gap already recorded for hand-authored READMEs.

- [ ] **Step 4: Verify the docs build and lint**

Run: `bunx biome check src/ test/ scripts/ && bun test && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/ROADMAP.md README.md
git commit -m "docs: record the extractor entry kinds and the byte gap that remains"
```

---

### Task 7: Full preflight

**Files:** none — this task only runs gates.

- [ ] **Step 1: Run the gates CI can run**

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```
Expected: all PASS.

- [ ] **Step 2: Run the gates CI cannot run**

```bash
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run acceptance C:/gitrep/Nimbus
bun run wiring:conformance --nimbus-root C:/gitrep/Nimbus
```
Expected: all PASS; `newrelic`/`datadog`/`grafana`/`sentry` still `6/6`; `dependencytrack` matching its declared expectation.

- [ ] **Step 3: Run the registry gate**

```bash
bun run standalone-acceptance --registry
bun run runtime:acceptance --registry
```
Expected: fully verified. `--registry` and local-checkout mode answer different questions — local mode rewrites the SDK dependency to `file:`, so only `--registry` catches a `dist` missing from the published tarball's `files` array. Report which one was run.

- [ ] **Step 4: Report honestly**

State each gate's actual result. If a gate was skipped or could not run, say so and say why. "Generated and it looked right" is not verification.

---

## Self-Review

**Spec coverage.** Every design section maps to a task: spec language and rejections → Task 1; identifier safety (both `RESERVED_IDENTIFIERS` and the `filter.export` claim) → Task 2; rendering table, convergence rule, import rules and the `FieldExtractor`/`asRecord` exclusions → Task 3; `dependencytrack` → Task 4; `zzextract` and the registry path → Task 5; ROADMAP updates including the multi-file correction → Task 6; the gate table → Task 7. The design's *Considered and declined* section needs no task by construction.

**Type consistency.** `keyedShape` returns `{ keys: string[]; tags: boolean } | undefined` and is consumed by `keyedFilter(tool, shape)` with that same type in Task 3. `isPathEntry` / `isTagsEntry` / `FieldEntry` are exported from `src/spec.ts` in Task 1 and imported in Task 3 under those exact names. `emitSearchFilter`'s signature is unchanged throughout.

**Known risk, flagged rather than hidden.** Task 4 Step 5 may find that Biome's line-breaking inside the returned array does not match the real file. Line breaks inside an array are Biome's decision based on print width, not the emitter's, so the plan tells the implementer to read the diff rather than hand-tune indentation. If it cannot be closed, the honest outcome is that `dependencytrack`'s expectation entry omits `src/search-filter.ts` and the gap is documented — not that `expectations.json` is edited to claim a match that does not exist.
