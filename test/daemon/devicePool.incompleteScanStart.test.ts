import { makePool } from "../helpers/makePool";
import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import type { SomePlatform } from "../../src/models";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { settleWithFakeTime } from "../helpers/fakeTimerStepping";

// #11103: an incomplete booted-device listing (adb timeout) is not "nothing is
// booted" — the pool must not cold-boot an image or adopt an unlaunched
// emulator on the strength of it.

const android = (deviceId: string) => ({ deviceId, name: deviceId, platform: "android" as const });
const startableAvd = { name: "spare-avd", platform: "android" as const, isRunning: false };

/** Report Android discovery as incomplete once `failAfter` returns true. */
function failAndroidDiscoveryWhen(manager: FakeDeviceManager, failAfter: () => boolean): void {
  const original = manager.getBootedDevicesDetailed.bind(manager);
  manager.getBootedDevicesDetailed = async (
    platform: SomePlatform,
  ): Promise<BootedDeviceDiscovery> => {
    const discovery = await original(platform);
    if (!failAfter() || platform === "ios") {
      return discovery;
    }
    const succeededPlatforms = new Set(discovery.succeededPlatforms);
    succeededPlatforms.delete("android");
    return {
      ...discovery,
      devices: discovery.devices.filter((device) => device.platform !== "android"),
      succeededPlatforms,
      discoveryErrors: {
        ...discovery.discoveryErrors,
        android: { code: "timeout", message: "adb devices timed out", retryable: true },
      },
    };
  };
}

describe("device pool start on an incomplete booted-device scan", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let manager: FakeDeviceManager;
  let pool: DevicePool;

  async function arrangeHarness(): Promise<void> {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager = new FakeDeviceManager();
    manager.bootedDevices = [android("d1")];
    manager.deviceImages = [startableAvd];
    pool = makePool(sessions, "incomplete-scan-test", { timer, deviceManager: manager });
    await pool.initializeWithDevices([android("d1")]);
    await pool.bindOrReuseDeviceSession({ sessionId: "base", deviceId: "d1", platform: "android" });
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }
  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const allocate = () =>
    settleWithFakeTime(
      timer,
      runWithAbortSignal(new AbortController().signal, () =>
        pool.assignMultipleDevicesByCriteria(
          ["base", "base:B"].map((sessionId) => ({
            sessionId,
            criteria: { platform: "android" as const },
          })),
          4_000,
        ),
      ).then(
        (value: unknown) => value,
        (error: unknown) => error,
      ),
      { stepMs: 1_000, maxSteps: 8, description: "allocation outcome" },
    );

  arranged("does not cold-boot an image when the Android listing is incomplete", async () => {
    failAndroidDiscoveryWhen(manager, () => true);

    const outcome = String(await allocate());

    expect(manager.startedDevices).toEqual([]);
    expect(outcome).toContain("Timed out allocating devices");
    expect(sessions.getSession("base:B")).toBeNull();
  });

  arranged(
    "does not adopt an unlaunched emulator when the adopt-check listing is incomplete",
    async () => {
      manager.startOutcome = "already-running";
      manager.startVisibleDeviceId = "emulator-5560";
      failAndroidDiscoveryWhen(manager, () => manager.startedDevices.length > 0);
      const readinessWaits: string[] = [];
      const waitForDeviceReady = manager.waitForDeviceReady.bind(manager);
      manager.waitForDeviceReady = async (device) => {
        readinessWaits.push(device.name);
        return await waitForDeviceReady(device);
      };

      const outcome = String(await allocate());

      expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-avd"]);
      // Refused before readiness: the incomplete listing cannot prove it is adoptable.
      expect(readinessWaits).toEqual([]);
      expect(outcome).toContain("Timed out allocating devices");
      expect(pool.getDevice("emulator-5560")?.sessionId ?? null).toBeNull();
      expect(sessions.getSession("base:B")).toBeNull();
    },
  );
});
