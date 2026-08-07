/**
 * Rewrites schema/connector-spec.schema.json from ConnectorSpecSchema.
 *
 * A driver and nothing else: the document, the destination and the reasoning all live in
 * scripts/_lib/build-schema.ts, which test/schema.test.ts imports too. See that file's header for
 * why the writer and the drift test must share the function AND the path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildSchema, SCHEMA_PATH } from "./_lib/build-schema.ts";

if (import.meta.main) {
  const text = buildSchema();
  mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
  writeFileSync(SCHEMA_PATH, text);
  console.log(`Wrote ${SCHEMA_PATH} (${text.length} bytes)`);
}
