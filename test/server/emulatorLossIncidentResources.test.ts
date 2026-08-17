import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerEmulatorLossIncidentResources,
  resetEmulatorLossIncidentReaderForTesting,
  setEmulatorLossIncidentReaderForTesting,
} from "../../src/server/emulatorLossIncidentResources";
import { EMULATOR_LOSS_INCIDENT_RESOURCE_URIS } from "../../src/server/emulatorLossIncidentResourceUris";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import type { EmulatorLossIncident } from "../../src/daemon/emulatorLossIncident";

const incident: EmulatorLossIncident = {
  id: "emulator-loss-1",
  observedAtMs: 1,
  updatedAtMs: 2,
  deviceId: "emulator-5554",
  detectionPath: "watched-process-exit",
  recovery: {
    policy: { onLoss: true, maxAttempts: 2 },
    attempts: [{ attempt: 1, outcome: "succeeded" }],
    outcome: "recovered",
  },
};

describe("emulatorLossIncidentResources", () => {
  beforeEach(() => {
    registerEmulatorLossIncidentResources();
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
    resetEmulatorLossIncidentReaderForTesting();
  });

  test("lists persisted incidents through a stable resource URI", async () => {
    setEmulatorLossIncidentReaderForTesting({
      list: async () => [incident],
    });
    const resource = ResourceRegistry.getResource(EMULATOR_LOSS_INCIDENT_RESOURCE_URIS.ARCHIVE);

    expect(resource).toBeDefined();
    const content = await resource!.handler();
    expect(JSON.parse(content.text ?? "{}")).toEqual({
      incidents: [incident],
      count: 1,
    });
  });
});
