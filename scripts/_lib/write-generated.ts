/**
 * The write half of the two generators — `bun run schema` and `bun run build:spec-doc` — which
 * carried the same three lines each, and the line both print once the file is on disk.
 *
 * What each document IS, and where it goes, stays with its own module (scripts/_lib/build-schema.ts
 * and scripts/_lib/build-spec-doc.ts), because the drift tests import the same function and the
 * same path; this only puts bytes at a path and says how many.
 *
 * The count is UTF-8 bytes, which is what the line has always claimed and what lands on disk. Both
 * drivers used to print `text.length` — UTF-16 code units — which happens to agree for the ASCII
 * schema and under-reported docs/SPEC.md, whose em-dashes are three bytes each.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write `text` to `path`, creating its directory, and return the line to print. */
export function writeGenerated(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return `Wrote ${path} (${Buffer.byteLength(text, "utf8")} bytes)`;
}
