import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { writeFiles } from "../../src/cli.ts";
import { initParser } from "../../src/derive/ast.ts";
import {
  ambiguityNote,
  deriveFromDirectory,
  PARTIAL_MARKER,
  renderBlockers,
} from "../../src/derive/from-connector.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

async function emitInto(fixture: string, dir: string): Promise<void> {
  const raw = JSON.parse(
    await Bun.file(join(import.meta.dir, "..", "..", "fixtures", `${fixture}.spec.json`)).text(),
  );
  await writeFiles(formatAll(generate(parseSpec(raw))), dir);
}

describe("deriveFromDirectory", () => {
  it("round-trips a connector this repo generated", async () => {
    const dir = tmp.make("from-connector-");
    await emitInto("zzscratch", dir);
    const result = await deriveFromDirectory(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.name).toBe("zzscratch");
  });

  it("reads src/search-filter.ts alongside src/server.ts for a connector with a search tool", async () => {
    const dir = tmp.make("from-connector-");
    await emitInto("zzsearch", dir);
    // writeFiles wrote src/search-filter.ts into the directory too — deriveFromDirectory must
    // read it, or the search tools inside would derive as a blocker instead of round-tripping.
    const result = await deriveFromDirectory(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.name).toBe("zzsearch");
  });

  it("reports blockers by name rather than throwing", async () => {
    const dir = tmp.make("from-connector-");
    await emitInto("zzscratch", dir);
    // Append a statement no recognizer models. The totality rule must surface it.
    const server = join(dir, "src", "server.ts");
    await Bun.write(server, `${await Bun.file(server).text()}\nconst leftover = compute();\n`);

    const result = await deriveFromDirectory(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.length).toBeGreaterThan(0);
      const text = renderBlockers(dir, result.blockers);
      expect(text).toContain("cannot read");
      expect(text).toMatch(/statement:|call:/);
    }
  });

  it("names the missing file rather than throwing a raw ENOENT", async () => {
    const result = await deriveFromDirectory(tmp.make("from-connector-"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(renderBlockers("x", result.blockers)).toContain("src/server.ts");
  });

  // I2 (final whole-branch review): `deriveSpec`'s `ok: true` only means every AST construct was
  // recognized, not that the recovered spec passes `validateSpec` — `token` is one of the
  // RESERVED_IDENTIFIERS (alongside `path`, `res`, `text`, `url`, `u`, `server`), and a
  // hand-authored connector is free to name its fetch helper that. Built by taking THIS repo's
  // own emitted output and renaming the fetch helper post-hoc (never hand-writing
  // connector-shaped source): `generate()` itself calls `validateSpec` internally, so a spec
  // naming the helper "token" could never reach `generate()` in the first place — the rejection
  // this test pins can only be produced this way.
  it("rejects a derived spec that RESERVED_IDENTIFIERS would refuse, rather than reporting success", async () => {
    const dir = tmp.make("from-connector-");
    await emitInto("zzscratch", dir);
    const server = join(dir, "src", "server.ts");
    const renamed = (await Bun.file(server).text()).replaceAll("zzGet", "token");
    await Bun.write(server, renamed);

    const result = await deriveFromDirectory(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.kind).toBe("rejected-by-validate");
    expect(result.blockers[0]?.detail).toContain('"token"');
  });

  it("the same reserved-identifier rejection becomes a partial draft under --partial", async () => {
    const dir = tmp.make("from-connector-");
    await emitInto("zzscratch", dir);
    const server = join(dir, "src", "server.ts");
    const renamed = (await Bun.file(server).text()).replaceAll("zzGet", "token");
    await Bun.write(server, renamed);

    const result = await deriveFromDirectory(dir, { partial: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec).toHaveProperty(PARTIAL_MARKER);
    expect(() => parseSpec(result.spec)).toThrow();
    const marker = (result.spec as Record<string, { blockers: string[] }>)[PARTIAL_MARKER];
    expect(marker?.blockers).toEqual(["rejected-by-validate"]);
  });

  it("emits a partial spec the schema REFUSES", async () => {
    const dir = tmp.make("from-connector-");
    await emitInto("zzscratch", dir);
    // Same unrecognized-construct trigger as "reports blockers by name" above, but this time
    // asking for a draft instead of only a blocker report.
    const server = join(dir, "src", "server.ts");
    await Bun.write(server, `${await Bun.file(server).text()}\nconst leftover = compute();\n`);

    const result = await deriveFromDirectory(dir, { partial: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec).toHaveProperty(PARTIAL_MARKER);
    // The whole point: a draft must not be generatable until a human has resolved it. (This
    // spec is missing every other required field too, so on its own this only proves SOME
    // issue rejects it — test/spec.test.ts pins the marker key itself as sufficient cause.)
    expect(() => parseSpec(result.spec)).toThrow();
    // src/cli.ts prints every entry in `notes` to the user — this is the ONLY on-screen
    // signal that what was just printed is a draft rather than a real spec. A `notes: []`
    // here would pass every assertion above while silently dropping that warning, so the
    // count and the wording are both pinned rather than just checking non-empty.
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatch(/partial/i);
    expect(result.notes[0]).toMatch(/marker/i);
  });
});

describe("ambiguityNote", () => {
  // No fixture in this repo's corpus currently derives with an ambiguous effect — see the
  // comment on ambiguityNote itself — so this is unit-tested directly with a plain string
  // rather than through a full deriveFromDirectory round trip.
  it("names the effect and flags it as unverified", () => {
    const note = ambiguityNote("write");
    expect(note).toContain('effect "write"');
    expect(note).toMatch(/more than one tool/);
    expect(note).toMatch(/confirm each before generating/);
  });
});
