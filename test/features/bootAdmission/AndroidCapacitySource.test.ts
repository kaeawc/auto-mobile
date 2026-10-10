import { describe, expect, test } from "bun:test";
import {
  ANDROID_MAX_BOOTED_ENV,
  AndroidBootAdmissionGate,
} from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import {
  adbEmulatorSerialLister,
  CommandAndroidCapacitySource,
  type AdbDeviceStateSource,
} from "../../../src/features/bootAdmission/AndroidCapacitySource";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import type { HostCommandExecutor } from "../../../src/utils/HostCommandExecutor";
import type { AdbDeviceState } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const GIB = 1024 ** 3;
const HOST = { totalMemoryBytes: () => 64 * GIB, cpuCount: () => 16 };

type StateOptions = Parameters<AdbDeviceStateSource["getDeviceStates"]>[0];

/** A host with no `ps` (Windows, or a failed process sample). */
const noPsExecutor: HostCommandExecutor = {
  executeCommand: async () => {
    throw new Error("ps: command not found");
  },
};

class FakeAdbDeviceStateSource implements AdbDeviceStateSource {
  readonly calls: StateOptions[] = [];
  constructor(public states: AdbDeviceState[]) {}

  async getDeviceStates(options: StateOptions): Promise<AdbDeviceState[]> {
    this.calls.push(options);
    return this.states;
  }
}

function gateOver(adb: AdbDeviceStateSource, maxBooted: string) {
  const source = new CommandAndroidCapacitySource(
    adbEmulatorSerialLister(adb, 5_000),
    noPsExecutor,
    HOST,
  );
  return {
    source,
    gate: new AndroidBootAdmissionGate(source, new FakeTimer(), {
      env: { [ANDROID_MAX_BOOTED_ENV]: maxBooted },
    }),
  };
}

describe("adb emulator listing counts every adb state (#11369)", () => {
  test("lists emulators that are offline, unauthorized or online, once each, and no other device", async () => {
    const adb = new FakeAdbDeviceStateSource([
      { deviceId: "emulator-5554", state: "offline" },
      { deviceId: "emulator-5556", state: "unauthorized" },
      { deviceId: "emulator-5558", state: "device" },
      { deviceId: "emulator-5558", state: "device" },
      { deviceId: "R5CT12345", state: "device" },
      { deviceId: "192.168.1.20:5555", state: "offline" },
    ]);
    const signal = new AbortController().signal;

    await expect(adbEmulatorSerialLister(adb, 5_000)(signal)).resolves.toEqual([
      "emulator-5554",
      "emulator-5556",
      "emulator-5558",
    ]);
    expect(adb.calls).toEqual([{ timeoutMs: 5_000, signal, throwOnMissingAdb: true }]);
  });

  test("refuses at limit 1 while a peer's emulator is booting (offline) and ps is unavailable", async () => {
    const adb = new FakeAdbDeviceStateSource([{ deviceId: "emulator-5554", state: "offline" }]);
    const { gate } = gateOver(adb, "1");

    const error = await gate.admit({ timeoutMs: 60_000, avdName: "Pixel_9" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BootCapacityExhaustedError);
    expect((error as BootCapacityExhaustedError).details).toMatchObject({
      limit: 1,
      booted: 1,
      externalDevices: ["emulator-5554"],
    });
    await expect(gate.describeCapacity()).resolves.toMatchObject({ limit: 1, booted: 1 });
  });

  test("admits below the limit with the offline emulator counted", async () => {
    const adb = new FakeAdbDeviceStateSource([{ deviceId: "emulator-5554", state: "offline" }]);
    const { gate } = gateOver(adb, "2");

    const admission = await gate.admit({ timeoutMs: 60_000, avdName: "Pixel_9" });
    admission.release();

    await expect(gate.describeCapacity()).resolves.toMatchObject({ booted: 1, inFlight: 0 });
  });

  test("an adb listing failure stays a failed listing, not zero emulators", async () => {
    const adb: AdbDeviceStateSource = {
      getDeviceStates: async () => {
        throw new Error("adb server is out of date");
      },
    };
    const { source } = gateOver(adb, "1");

    const sample = await source.sample();

    expect(sample.serialListingFailed).toBe(true);
    expect(sample.emulatorProcessRssBytes).toBeUndefined();
  });
});
