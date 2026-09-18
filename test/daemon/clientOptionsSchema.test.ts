import { describe, expect, test } from "bun:test";
import { daemonOptionsSchema, daemonOptionsSchemaCoversAllKeys } from "../../src/daemon/client";
import { STARTUP_OPTION_DEFICIT_KEYS } from "../../src/daemon/daemonMcpProxy";

describe("daemonOptionsSchema", () => {
  test("covers every option startupOptionDeficits can reconcile", () => {
    const schemaKeys = new Set(Object.keys(daemonOptionsSchema.shape));

    expect(STARTUP_OPTION_DEFICIT_KEYS.every((key) => schemaKeys.has(key))).toBe(true);
    // The compile-time assertion over keyof DaemonOptions is the real gate.
    expect(daemonOptionsSchemaCoversAllKeys).toBe(true);
  });
});
