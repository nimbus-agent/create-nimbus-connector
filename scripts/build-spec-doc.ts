/**
 * Rewrites docs/SPEC.md from ConnectorSpecSchema.
 *
 * A driver and nothing else: the page, the destination and the reasoning all live in
 * scripts/_lib/build-spec-doc.ts, which test/spec-doc.test.ts imports too, and the write itself in
 * scripts/_lib/write-generated.ts. See build-spec-doc.ts's header for why the writer and the drift
 * test must share the function AND the path.
 */

import { buildSpecDoc, SPEC_DOC_PATH } from "./_lib/build-spec-doc.ts";
import { writeGenerated } from "./_lib/write-generated.ts";

if (import.meta.main) {
  console.log(writeGenerated(SPEC_DOC_PATH, buildSpecDoc()));
}
