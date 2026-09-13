import { afterEach, describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice, DeviceInfo, ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeRunningAvdAdvertisementReader } from "../../fakes/FakeRunningAvdAdvertisementReader";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

const createExecResult = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

const noopExec = async (): Promise<ExecResult> => createExecResult("", "");

/**
 * `spawn` must never be reachable in this file: every test here asserts that
 * `startEmulator` takes an adopt path INSTEAD of spawning, so a regression must
 * fail loudly rather than launch a real emulator.
 */
const forbiddenSpawn = (() => {
  throw new Error("startEmulator spawned an emulator when it should have adopted one");
}) as never;

function clientWithAvd(
  avdName: string,
  bootedDevices: BootedDevice[] = [],
): { client: AndroidEmulatorClient; advertisements: FakeRunningAvdAdvertisementReader } {
  const adb = new FakeAdbExecutor();
  adb.setDevices(bootedDevices);
  adb.setCommandResponse("emu avd name", createExecResult(`${avdName}\n`));
  const adbFactory: AdbClientFactory = { create: (): AdbExecutor => adb };
  const advertisements = new FakeRunningAvdAdvertisementReader();
  const client = new AndroidEmulatorClient(
    noopExec,
    forbiddenSpawn,
    new FakeTimer(),
    adbFactory,
    undefined,
    undefined,
    undefined,
    { isAvailable: async () => true },
    advertisements,
  );
  (client as unknown as { ensureEmulatorPath: () => Promise<string> }).ensureEmulatorPath =
    async () => "emulator";
  (client as unknown as { listAvds: () => Promise<DeviceInfo[]> }).listAvds = async () => [
    { name: avdName, platform: "android", isRunning: false } as DeviceInfo,
  ];
  return { client, advertisements };
}

afterEach(() => {
  AndroidEmulatorClient.resetLaunchReservationsForTesting();
});

describe("AndroidEmulatorClient startEmulator handle", () => {
  test("returns null (not a fabricated {} as ChildProcess) when the AVD is already running", async () => {
    const { client } = clientWithAvd("Pixel_9", [
      { name: "Pixel_9", platform: "android", deviceId: "emulator-5554", source: "local" },
    ]);

    const result = await client.startEmulator("Pixel_9");

    // AC2: no fabricated handle — a device we did not spawn has no process handle.
    expect(result).toBeNull();
  });

  test("returns null when the AVD is already starting", async () => {
    const { client, advertisements } = clientWithAvd("Pixel_9");
    advertisements.advertised.add("Pixel_9");

    const result = await client.startEmulator("Pixel_9");

    expect(result).toBeNull();
  });
});
