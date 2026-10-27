import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AndroidBootAdmissionGate } from "../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { IosSimFleetCostCollector } from "../../src/features/iosSimFleet/FleetCostCollector";
import { InMemoryBootDurationHistory } from "../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimCapacityGate } from "../../src/features/iosSimFleet/CapacityGate";
import { parsePsSnapshot } from "../../src/devices/bootAdmission/psSnapshot";
import { parseSimctlInventory } from "../../src/features/iosSimFleet/simctlInventory";
import { toJSONSchema } from "zod/v4";
import { compileAjv2020 } from "../helpers/jsonSchemaCompile";
import { listDevicesOutputSchema } from "../../src/server/deviceTools";
import { FakeAndroidCapacitySource } from "../fakes/FakeAndroidCapacitySource";
import { FakeFleetHostSource } from "../fakes/FakeFleetHostSource";
import { FakeTimer } from "../fakes/FakeTimer";

const FIXTURES = join(import.meta.dir, "../fixtures");
const PS = readFileSync(
  join(FIXTURES, "ios-sim-fleet/ps-snapshot-two-booted-simulators.txt"),
  "utf8",
);
const SIMCTL = readFileSync(join(FIXTURES, "ios-simctl/list-devices.json"), "utf8");
const GIB = 1024 ** 3;

// The server validates structuredContent against the advertised JSON schema, where unknown
// properties are rejected; zod's own parse would silently strip them and hide the mismatch.
const validate = compileAjv2020(toJSONSchema(listDevicesOutputSchema as never));

function envelope(capacity: unknown) {
  return {
    message: "Found 0 booted devices",
    devices: [],
    count: 0,
    discovery: {},
    capacity,
    note: "",
  };
}

describe("listDevices output schema accepts the real capacity shape (#11268)", () => {
  test("android describeCapacity output validates", async () => {
    const source = new FakeAndroidCapacitySource();
    const gate = new AndroidBootAdmissionGate(source, new FakeTimer(), { env: {} });
    const android = await gate.describeCapacity();
    expect(validate(envelope({ android })), JSON.stringify(validate.errors)).toBe(true);
  });

  test("android describeCapacity processTable diagnostics validate strictly", async () => {
    const source = new FakeAndroidCapacitySource();
    source.emulatorProcessRssBytes = undefined;
    source.processTableFailure = {
      reason: "timeout",
      transient: true,
      attempts: 3,
      detail: "ps timed out",
    };
    const gate = new AndroidBootAdmissionGate(source, new FakeTimer(), { env: {} });
    (await gate.admit({ avdName: "Pixel", timeoutMs: 60_000 })).release();
    const android = await gate.describeCapacity();
    expect(android.processTable).toMatchObject({
      unavailable: true,
      reason: "timeout",
      attempts: 3,
      admissionsWithoutProcessTable: 1,
      lastAdmissionWithoutProcessTableAtMs: 0,
    });
    expect(validate(envelope({ android })), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate(
        envelope({
          android: { ...android, processTable: { ...android.processTable, unexpected: true } },
        }),
      ),
    ).toBe(false);
  });

  test("ios describeCapacity output, including hostPressure, validates", async () => {
    const source = new FakeFleetHostSource();
    source.inventory = parseSimctlInventory(SIMCTL);
    source.snapshot = {
      takenAtMs: 0,
      resources: {
        totalMemoryBytes: 128 * GIB,
        cpuCount: 16,
        loadAverage1m: 2,
        memoryPressure: "normal",
      },
      processes: parsePsSnapshot(PS).rows,
    };
    const timer = new FakeTimer();
    const collector = new IosSimFleetCostCollector(
      source,
      new InMemoryBootDurationHistory(),
      timer,
    );
    const ios = await new IosSimCapacityGate(collector, timer, { env: {} }).describeCapacity();
    expect(ios.hostPressure).toBeDefined();
    expect(ios.admissionsByReason).toEqual({ reset: 0, create: 0, restart: 0 });
    expect(validate(envelope({ ios })), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate(
        envelope({ ios: { ...ios, admissionsByReason: { reset: 1, create: 2, restart: 3 } } }),
      ),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(
      validate(envelope({ ios: { ...ios, admissionsByReason: { reset: 1, create: 2 } } })),
    ).toBe(false);
  });
});
