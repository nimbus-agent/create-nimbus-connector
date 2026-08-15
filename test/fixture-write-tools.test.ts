/**
 * That no real-connector fixture declares a write tool — the fact `docs/TESTING.md`'s
 * *No real-connector fixture declares a write tool* section builds its argument on.
 *
 * The section's consequence is the reason this is a gate rather than prose: `diff:golden` has
 * **zero purchase** on the Stage C emitter paths, because every fixture it byte-compares is
 * read-only. That claim is only true while it stays true, and a fixture added later would
 * falsify it silently — the document would keep asserting it and no run would disagree. The
 * section previously said "verified at HEAD", which is a measurement with no expiry and no
 * check; this file is what makes it checkable.
 *
 * **The fixture list is derived, never transcribed.** It is the non-`zz` keys of
 * `fixtures/expectations.json` — `zz*` fixtures are synthetic, and three of them (`zzwrite`,
 * `zzwriteonly`, `zzwriterest`) exist precisely to carry the write paths. Transcribing the
 * twelve names here would add one more list to drift, which is the failure
 * `test/gate-lists.test.ts` documents at length.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

/** The non-`zz` keys of expectations.json: the fixtures transcribed from real Nimbus connectors. */
function realConnectorFixtures(): string[] {
  const raw = readFileSync(join(repoRoot, "fixtures", "expectations.json"), "utf8");
  return Object.keys(JSON.parse(raw) as Record<string, unknown>)
    .filter((name) => !name.startsWith("zz"))
    .sort();
}

/** Every tool in a fixture that is not a plain read — a `write` effect or a body-carrying method. */
function writeTools(name: string): readonly string[] {
  const raw = readFileSync(join(repoRoot, "fixtures", `${name}.spec.json`), "utf8");
  const spec = JSON.parse(raw) as {
    tools?: readonly { name?: string; effect?: string; method?: string }[];
  };
  return (spec.tools ?? [])
    .filter((t) => t.effect === "write" || (t.method !== undefined && t.method !== "GET"))
    .map((t) => t.name ?? "<unnamed>");
}

describe("real-connector fixtures are read-only", () => {
  // Non-vacuity: if expectations.json is ever restructured, an empty list would make every
  // assertion below pass while checking nothing. The set is named in docs/TESTING.md — a
  // floor, not an equality, so adding a fixture does not fail here (which is why the doc's
  // enumeration silently fell two behind the corpus and had to be corrected by hand).
  it("finds the real-connector fixtures", () => {
    expect(realConnectorFixtures().length).toBeGreaterThanOrEqual(12);
  });

  it.each(realConnectorFixtures())("%s declares no write tool", (name) => {
    expect(writeTools(name)).toEqual([]);
  });

  // The other half of non-vacuity: the detector must actually fire on the shape it looks for,
  // or the assertions above would pass for a fixture full of writes.
  it.each(["zzwrite", "zzwriteonly", "zzwriterest"])("detects the write tools in %s", (name) => {
    expect(writeTools(name).length).toBeGreaterThan(0);
  });
});
