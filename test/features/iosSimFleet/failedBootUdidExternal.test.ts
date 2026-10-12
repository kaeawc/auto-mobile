import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimCapacityGate } from "../../../src/features/iosSimFleet/CapacityGate";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import { FleetBootInstrumentation } from "../../../src/features/iosSimFleet/IosBootInstrumentation";
import { IOS_SIM_MAX_BOOTED_ENV } from "../../../src/features/iosSimFleet/capacityPolicy";
import { parsePsSnapshot } from "../../../src/features/iosSimFleet/psSnapshot";
import { parseSimctlInventory } from "../../../src/features/iosSimFleet/simctlInventory";
import { FakeFleetHostSource } from "../../fakes/FakeFleetHostSource";
import { FakeTimer } from "../../fakes/FakeTimer";

// Android parity (#11564, AndroidBootAdmissionGate.admit release): "a boot that ended before adb
// ever listed it never held its serial: an emulator started elsewhere that takes the serial later
// is not ours." The iOS gate adds the UDID to startedUdids at admission and only forgets it after
// a sample showed it occupying a slot, so a boot that FAILED before the simulator was ever listed
// Booting/Booted keeps the UDID "ours" for the life of the daemon. When someone later boots that
// simulator outside AutoMobile, the capacity_exhausted refusal does not name it as external and
// omits the "not started by AutoMobile" note and the opt-out hint.

const FIXTURES = join(import.meta.dir, "../../fixtures");
const PS = readFileSync(
  join(FIXTURES, "ios-sim-fleet/ps-snapshot-two-booted-simulators.txt"),
  "utf8",
);
const SIMCTL = readFileSync(join(FIXTURES, "ios-simctl/list-devices.json"), "utf8");
const IOS27 = "2300914A-231E-4874-8F8A-40C3D2F1E24B";
const GIB = 1024 ** 3;

function withState(udid: string, state: string) {
  return parseSimctlInventory(SIMCTL).map((entry) =>
    entry.udid === udid ? { ...entry, state } : { ...entry, state: "Shutdown" },
  );
}

test("a simulator whose AutoMobile boot failed unlisted is external when booted elsewhere later", async () => {
  const source = new FakeFleetHostSource();
  source.inventory = withState(IOS27, "Shutdown");
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
  const history = new InMemoryBootDurationHistory();
  const gate = new IosSimCapacityGate(new IosSimFleetCostCollector(source, history, timer), timer, {
    env: { [IOS_SIM_MAX_BOOTED_ENV]: "1" },
  });
  const instrumentation = new FleetBootInstrumentation({ history, timer, gate });

  // The real boot path: admitted, then `simctl boot` fails before the simulator is ever listed.
  const bootFailure = new Error("simctl boot failed: Unable to boot device in current state");
  const failed = await instrumentation
    .run({ udid: IOS27, timeoutMs: 60_000 }, async () => {
      throw bootFailure;
    })
    .catch((error: unknown) => error);
  expect(failed).toBe(bootFailure);
  // Samples while it is still shut down: nothing occupies a slot.
  await gate.assertCapacityAvailable();

  // Later a person boots the same simulator from Xcode.
  source.inventory = withState(IOS27, "Booted");
  const error = await gate.assertCapacityAvailable().catch((e: unknown) => e);

  expect(error).toBeInstanceOf(BootCapacityExhaustedError);
  // Fails today: externalDevices is undefined and the message blames no external simulator.
  expect((error as BootCapacityExhaustedError).details.externalDevices).toEqual([IOS27]);
  expect((error as Error).message).toContain("not started by AutoMobile");
});

function setup() {
  const source = new FakeFleetHostSource();
  source.inventory = withState(IOS27, "Shutdown");
  source.snapshot = {
    takenAtMs: 0,
    resources: {
      totalMemoryBytes: 128 * GIB,
      cpuCount: 16,
      loadAverage1m: 2,
      memoryPressure: "normal",
    },
    processes: [],
  };
  const timer = new FakeTimer();
  const gate = new IosSimCapacityGate(
    new IosSimFleetCostCollector(source, new InMemoryBootDurationHistory(), timer),
    timer,
    { env: { [IOS_SIM_MAX_BOOTED_ENV]: "1" } },
  );
  return { source, gate };
}

async function externalDevices(gate: IosSimCapacityGate): Promise<string[] | undefined> {
  const error = await gate.assertCapacityAvailable().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(BootCapacityExhaustedError);
  return (error as BootCapacityExhaustedError).details.externalDevices;
}

test("a failed boot seen occupying by a check stays ours until seen gone", async () => {
  const { source, gate } = setup();
  const admission = await gate.admitBoot(undefined, { bootUdid: IOS27 });
  source.inventory = withState(IOS27, "Booting");
  expect(await externalDevices(gate)).toBeUndefined();
  admission.releaseAdmission?.({ bootFailed: true });
  expect(await externalDevices(gate)).toBeUndefined();
  source.inventory = withState(IOS27, "Shutdown");
  await gate.assertCapacityAvailable();
  source.inventory = withState(IOS27, "Booted");
  expect(await externalDevices(gate)).toEqual([IOS27]);
});

test("a capacity report does not record ownership of a failed unseen boot", async () => {
  const { source, gate } = setup();
  const admission = await gate.admitBoot(undefined, { bootUdid: IOS27 });
  source.inventory = withState(IOS27, "Booting");
  expect((await gate.describeCapacity()).booted).toBe(1);
  admission.releaseAdmission?.({ bootFailed: true });
  source.inventory = withState(IOS27, "Booted");
  expect(await externalDevices(gate)).toEqual([IOS27]);
});

test("a successful boot without a sample before release stays ours", async () => {
  const { source, gate } = setup();
  const admission = await gate.admitBoot(undefined, { bootUdid: IOS27 });
  admission.releaseAdmission?.();
  source.inventory = withState(IOS27, "Booted");
  expect(await externalDevices(gate)).toBeUndefined();
});

test("forgetting a seen-then-gone UDID clears its earlier successful admission", async () => {
  const { source, gate } = setup();
  const successful = await gate.admitBoot(undefined, { bootUdid: IOS27 });
  successful.releaseAdmission?.();
  source.inventory = withState(IOS27, "Booted");
  expect(await externalDevices(gate)).toBeUndefined();
  source.inventory = withState(IOS27, "Shutdown");
  await gate.assertCapacityAvailable();

  const failed = await gate.admitBoot(undefined, { bootUdid: IOS27 });
  failed.releaseAdmission?.({ bootFailed: true });
  source.inventory = withState(IOS27, "Booted");
  expect(await externalDevices(gate)).toEqual([IOS27]);
});

test.each(["overlapping", "later"] as const)(
  "a successful unseen boot stays ours after a %s admission for the same UDID fails",
  async (order) => {
    const { source, gate } = setup();
    const first = await gate.admitBoot(undefined, { bootUdid: IOS27 });
    if (order === "later") {
      first.releaseAdmission?.();
    }
    const second = await gate.admitBoot(undefined, { bootUdid: IOS27 });
    if (order === "overlapping") {
      first.releaseAdmission?.();
    }
    second.releaseAdmission?.({ bootFailed: true });
    source.inventory = withState(IOS27, "Booted");
    expect(await externalDevices(gate)).toBeUndefined();
  },
);

test.each([false, true])(
  "a failed duplicate admission keeps the UDID until the other boot ends (failed: %s)",
  async (secondFails) => {
    const { source, gate } = setup();
    const first = await gate.admitBoot(undefined, { bootUdid: IOS27 });
    const second = await gate.admitBoot(undefined, { bootUdid: IOS27 });
    first.releaseAdmission?.({ bootFailed: true });
    expect((await gate.describeCapacity()).inFlight).toBe(1);
    second.releaseAdmission?.(secondFails ? { bootFailed: true } : undefined);
    source.inventory = withState(IOS27, "Booted");
    expect(await externalDevices(gate)).toEqual(secondFails ? [IOS27] : undefined);
  },
);

test("double release cannot forget a subsequent successful admission for the same UDID", async () => {
  const { source, gate } = setup();
  const failed = await gate.admitBoot(undefined, { bootUdid: IOS27 });
  failed.releaseAdmission?.({ bootFailed: true });
  const successful = await gate.admitBoot(undefined, { bootUdid: IOS27 });
  failed.releaseAdmission?.({ bootFailed: true });
  expect((await gate.describeCapacity()).inFlight).toBe(1);
  successful.releaseAdmission?.();
  source.inventory = withState(IOS27, "Booted");
  expect(await externalDevices(gate)).toBeUndefined();
});

test("a success release followed by a failure release is an idempotent success", async () => {
  const { source, gate } = setup();
  const admission = await gate.admitBoot(undefined, { bootUdid: IOS27 });
  admission.releaseAdmission?.();
  admission.releaseAdmission?.({ bootFailed: true });
  source.inventory = withState(IOS27, "Booted");
  expect(await externalDevices(gate)).toBeUndefined();
});
