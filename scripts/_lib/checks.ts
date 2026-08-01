/**
 * The named-verdict record every acceptance harness collects, and its report format.
 *
 * scripts/acceptance.ts and scripts/standalone-acceptance.ts declared the same type and then
 * printed it with the same four-line loop, inline at module scope. Sharing it is the same
 * move scripts/_lib/stdio-rpc.ts made, for the same reason — and it puts the one piece of
 * pure logic in either driver somewhere a test can reach.
 */

/** One named verdict, with whatever the underlying command printed. */
export type Check = { name: string; ok: boolean; output: string };

/**
 * The report lines for a check list, in the order they are printed.
 *
 * A check's output is shown only when it FAILED and there is something to show: a passing
 * command's stdout is noise, and an empty one would print a blank line that reads like a
 * message went missing.
 */
export function formatCheckLines(checks: readonly Check[]): string[] {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
    if (!c.ok && c.output !== "") lines.push(c.output);
  }
  return lines;
}
