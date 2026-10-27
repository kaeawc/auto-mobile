import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { adbOfflineHeldDevices } from "../../src/daemon/adbOfflineHeldDevices";
import type { DevicePool } from "../../src/daemon/devicePool";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { logger } from "../../src/utils/logger";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

function setup() {
  const devicePool: Pick<DevicePool, "getAssignedDevices"> = {
    getAssignedDevices: () => [
      {
        id: "emulator-5554",
        name: "Pixel",
        avdName: "Pixel_API_36",
        platform: "android",
        sessionId: "held-session",
        status: "busy",
        lastUsedAt: 0,
        assignmentCount: 1,
        errorCount: 0,
        incarnation: 1,
      },
    ],
  };
  const manager = new FakeDeviceUtils();
  const probe = mock<NonNullable<PlatformDeviceManager["getAndroidListedDeviceStates"]>>(
    async (ids) => new Map(Array.from(ids, (id) => [id, "offline"])),
  );
  manager.getAndroidListedDeviceStates = probe;
  return {
    probe,
    input: {
      platform: "android",
      discovered: [],
      devicePool,
      deviceManager: manager,
      signal: new AbortController().signal,
    },
  };
}

const probeFailure = { code: "failed", message: "Held-device state probe failed: adb unavailable" };
const warn = spyOn(logger, "warn");
afterEach(() => warn.mockClear());
afterAll(() => warn.mockRestore());

describe("adbOfflineHeldDevices signal forwarding", () => {
  test("forwards the explicit signal instead of a different ambient signal", async () => {
    const { input, probe } = setup();
    const signal = new AbortController().signal;
    const ambient = new AbortController().signal;

    const held = await runWithAbortSignal(ambient, () =>
      adbOfflineHeldDevices({ ...input, signal }),
    );

    expect(probe).toHaveBeenCalledTimes(1);
    expect([...probe.mock.calls[0]![0]]).toEqual(["emulator-5554"]);
    expect(probe.mock.calls[0]![1]?.signal).toBe(signal);
    expect(held).toEqual([
      {
        device: { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
        avdName: "Pixel_API_36",
        adbState: "offline",
      },
    ]);
  });

  test("ignores the ambient signal when the input already supplies a signal", async () => {
    const { input, probe } = setup();
    const ambient = new AbortController().signal;

    await runWithAbortSignal(ambient, () => adbOfflineHeldDevices(input));

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![1]?.signal).toBe(input.signal);
    expect(probe.mock.calls[0]![1]?.signal).not.toBe(ambient);
  });

  test("logs and ignores a failed probe by default", async () => {
    const { input, probe } = setup();
    const error = new Error("adb unavailable");
    probe.mockRejectedValue(error);

    expect(await adbOfflineHeldDevices(input)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[AdbOfflineHeldDevices] Offline held-device probe failed: adb unavailable",
      error,
    );
  });

  test("reports a failed probe through the callback and keeps the listing empty", async () => {
    const { input, probe } = setup();
    probe.mockRejectedValue(new Error("adb unavailable"));
    const onProbeFailure = mock(() => {});

    expect(await adbOfflineHeldDevices({ ...input, onProbeFailure })).toEqual([]);
    expect(onProbeFailure).toHaveBeenCalledWith(probeFailure);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("throws discovery_incomplete when the caller requires a known count", async () => {
    const { input, probe } = setup();
    probe.mockRejectedValue(new Error("adb unavailable"));

    const result = adbOfflineHeldDevices({ ...input, onProbeFailure: "throw" });
    await expect(result).rejects.toMatchObject({
      code: "discovery_incomplete",
      retryable: true,
      platform: "android",
      discoveryError: probeFailure,
    });
    await expect(result).rejects.toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
