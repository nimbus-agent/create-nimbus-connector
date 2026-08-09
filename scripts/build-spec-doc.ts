/**
 * Rewrites docs/SPEC.md from ConnectorSpecSchema.
 *
 * A driver and nothing else: the page, the destination and the reasoning all live in
 * scripts/_lib/build-spec-doc.ts, which test/spec-doc.test.ts imports too. See that file's header
 * for why the writer and the drift test must share the function AND the path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildSpecDoc, SPEC_DOC_PATH } from "./_lib/build-spec-doc.ts";

if (import.meta.main) {
  const text = buildSpecDoc();
  mkdirSync(dirname(SPEC_DOC_PATH), { recursive: true });
  writeFileSync(SPEC_DOC_PATH, text);
  console.log(`Wrote ${SPEC_DOC_PATH} (${text.length} bytes)`);
}
