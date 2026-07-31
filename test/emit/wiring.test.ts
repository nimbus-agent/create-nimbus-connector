import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { emitWiring, renderWiringInstructions } from "../../src/emit/wiring.ts";
import { parseSpec } from "../../src/spec.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

const base = {
  displayName: "New Relic",
  description: "New Relic connector. Read-focused.",
  serviceLabel: "New Relic",
  style: "hand-rolled" as const,
  env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }],
  fetchHelper: {
    local: "nrGet",
    base: "https://api.newrelic.com",
    inlineHeaders: { "X-Api-Key": "${env.apiKey}" },
  },
};

const spec = parseSpec({
  ...base,
  name: "newrelic",
  tools: [
    { name: "newrelic_application_list", description: "List applications.", path: "/apps" },
    { name: "newrelic_alert_violations", description: "List violations.", path: "/violations" },
  ],
});

describe("emitWiring", () => {
  it("returns exactly two files named <name>-sync.ts and <name>-mapping.ts", () => {
    const files = emitWiring(spec);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path)).toEqual([["newrelic-sync.ts"], ["newrelic-mapping.ts"]]);
  });

  it("the sync file declares createXSyncable and references the spec's list-tool id", () => {
    const [sync] = emitWiring(spec);
    expect(sync!.content).toContain("export function createNewrelicSyncable(): Syncable");
    expect(sync!.content).toContain('"newrelic_application_list"');
    // Not the non-list tool.
    expect(sync!.content).not.toContain("newrelic_alert_violations");
  });

  it("the sync file drains the list tool via listConnectorItems and upserts through the mapping fn", () => {
    const [sync] = emitWiring(spec);
    expect(sync!.content).toContain("import { listConnectorItems } from ");
    expect(sync!.content).toContain("listConnectorItems(ctx, SERVICE_ID, LIST_TOOL_ID)");
    expect(sync!.content).toContain("mapNewrelicItemToItem(rawItem, { syncedAt: now })");
    expect(sync!.content).toContain("upsertIndexedItemForSync(ctx, mapped)");
  });

  it("the mapping file is a stub naming what must be implemented", () => {
    const [, mapping] = emitWiring(spec);
    expect(mapping!.content).toContain("export function mapNewrelicItemToItem");
    expect(mapping!.content).toContain("newrelic_application_list");
    expect(mapping!.content).toContain("throw new Error(");
  });

  it("the mapping stub actually throws when called — an unfilled stub cannot look like a working mapping", async () => {
    const [, mapping] = emitWiring(spec);
    // Write the emitted source to a real file and import it, so this test exercises the
    // REAL generated code path (Bun transpiling it as .ts) rather than a hand-written
    // stand-in. mapping.ts has no imports of its own, so it runs standalone outside Nimbus.
    const dir = tmp.make("cnc-wiring-");
    const file = join(dir, "newrelic-mapping.ts");
    writeFileSync(file, mapping!.content, "utf8");
    const mod = (await import(pathToFileURL(file).href)) as {
      mapNewrelicItemToItem: (raw: unknown, ctx: { syncedAt: number }) => unknown;
    };
    expect(() => mod.mapNewrelicItemToItem({}, { syncedAt: 0 })).toThrow(
      /mapNewrelicItemToItem is a create-nimbus-connector stub/,
    );
    expect(() => mod.mapNewrelicItemToItem({}, { syncedAt: 0 })).toThrow(
      /newrelic_application_list/,
    );
  });

  it("picks the first tool ending in _list when more than one looks like a list tool", () => {
    const multi = parseSpec({
      ...base,
      name: "datadog",
      tools: [
        { name: "datadog_monitor_list", description: "List monitors.", path: "/monitors" },
        { name: "datadog_incident_list", description: "List incidents.", path: "/incidents" },
      ],
    });
    const [sync] = emitWiring(multi);
    expect(sync!.content).toContain('"datadog_monitor_list"');
    expect(sync!.content).not.toContain('"datadog_incident_list"');
  });

  it("throws a clear error when no tool name ends in _list", () => {
    const noList = parseSpec({
      ...base,
      name: "acme",
      tools: [{ name: "acme_get", description: "Get one.", path: "/x" }],
    });
    expect(() => emitWiring(noList)).toThrow(/no tool in "acme" has a name ending in "_list"/);
  });
});

describe("renderWiringInstructions", () => {
  it("prints the exact import and register lines for assemble-sync-registrations.ts", () => {
    const text = renderWiringInstructions(spec);
    expect(text).toContain(
      'import { createNewrelicSyncable } from "../connectors/newrelic-sync.ts";',
    );
    expect(text).toContain("syncScheduler.register(createNewrelicSyncable());");
    expect(text).toContain("platform/assemble-sync-registrations.ts");
  });

  it("points at connector-catalog.ts, not gateway-syncable-ids.ts, for the second edit", () => {
    const text = renderWiringInstructions(spec);
    expect(text).toContain("connector-catalog.ts");
    expect(text).toContain('CONNECTOR_SERVICE_IDS: add "newrelic"');
    expect(text).toContain("CONNECTOR_SYNC_INTERVAL_MS");
    // The original brief named gateway-syncable-ids.ts as the file to edit; it is not, and
    // this asserts the printed guidance never tells the user to touch its actual export.
    expect(text).not.toContain("GATEWAY_SYNCABLE_SERVICE_IDS");
  });

  it("notes any other list-shaped tool left unwired", () => {
    const multi = parseSpec({
      ...base,
      name: "datadog",
      tools: [
        { name: "datadog_monitor_list", description: "List monitors.", path: "/monitors" },
        { name: "datadog_incident_list", description: "List incidents.", path: "/incidents" },
      ],
    });
    expect(renderWiringInstructions(multi)).toContain("datadog_incident_list");
  });
});
