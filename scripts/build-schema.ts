/**
 * Rewrites schema/connector-spec.schema.json from ConnectorSpecSchema.
 *
 * A driver and nothing else: the document, the destination and the reasoning all live in
 * scripts/_lib/build-schema.ts, which test/schema.test.ts imports too, and the write itself in
 * scripts/_lib/write-generated.ts. See build-schema.ts's header for why the writer and the drift
 * test must share the function AND the path.
 */

import { buildSchema, SCHEMA_PATH } from "./_lib/build-schema.ts";
import { writeGenerated } from "./_lib/write-generated.ts";

if (import.meta.main) {
  console.log(writeGenerated(SCHEMA_PATH, buildSchema()));
}
