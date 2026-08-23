import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { DeviceInfo, ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const createExecResult = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

const noopExec = async (): Promise<ExecResult> => createExecResult("", "");

function clientWithAvd(avdName: string): AndroidEmulatorClient {
  const client = new AndroidEmulatorClient(noopExec, null, new FakeTimer());
  (client as unknown as { ensureEmulatorPath: () => Promise<string> }).ensureEmulatorPath =
    async () => "emulator";
  (client as unknown as { listAvds: () => Promise<DeviceInfo[]> }).listAvds = async () => [
    { name: avdName, platform: "android", isRunning: false } as DeviceInfo,
  ];
  return client;
}

describe("AndroidEmulatorClient startEmulator handle", () => {
  test("returns null (not a fabricated {} as ChildProcess) when the AVD is already running", async () => {
    const client = clientWithAvd("Pixel_9");
    (client as unknown as { isAvdRunning: () => Promise<boolean> }).isAvdRunning = async () => true;

    const result = await client.startEmulator("Pixel_9");

    // AC2: no fabricated handle — a device we did not spawn has no process handle.
    expect(result).toBeNull();
  });

  test("returns null when the AVD is already starting", async () => {
    const client = clientWithAvd("Pixel_9");
    (client as unknown as { isAvdRunning: () => Promise<boolean> }).isAvdRunning = async () =>
      false;
    (client as unknown as { isAvdStarting: () => Promise<boolean> }).isAvdStarting = async () =>
      true;

    const result = await client.startEmulator("Pixel_9");

    expect(result).toBeNull();
  });
});
