import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { writeFiles } from "../../src/cli.ts";
import { initParser } from "../../src/derive/ast.ts";
import {
  ambiguityNote,
  deriveFromDirectory,
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
