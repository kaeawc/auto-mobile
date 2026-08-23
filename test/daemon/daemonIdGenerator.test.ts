import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

describe("Daemon UUID source", function () {
  afterEach(() => {
    // Constructing a Daemon initializes the global DaemonState singleton.
    // Reset it so this test does not leak initialized state into other test
    // files (bun shares singleton state across files; execution order varies).
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("routes the daemon session id through the injected IdGenerator", function () {
    const idGenerator = new CountingIdGenerator("daemon-session");
    const daemon = new Daemon(
      {},
      undefined,
      new FakeTimer(),
      new DeviceSessionRepository(),
      idGenerator,
    );

    // First id minted during construction (daemonSessionId).
    expect((daemon as unknown as { daemonSessionId: string }).daemonSessionId).toBe(
      "daemon-session-1",
    );
  });

  test("retires a removed device epoch and mints a replacement through daemon wiring", async () => {
    const timer = new FakeTimer();
    const idGenerator = new CountingIdGenerator("device-session");
    const daemon = new Daemon({}, new FakeInstalledAppsRepository(), timer, undefined, idGenerator);
    const pool = daemon.getDevicePool();
    const registry = (
      daemon as unknown as {
        deviceSessionRegistry: {
          getByDeviceId(deviceId: string): { deviceSessionUuid: string } | undefined;
          getByUuid(deviceSessionUuid: string): unknown;
        };
      }
    ).deviceSessionRegistry;
    const bootedDevice = {
      name: "emulator-5554",
      deviceId: "emulator-5554",
      platform: "android" as const,
    };

    await pool.initializeWithDevices([bootedDevice]);
    pool.notifyDeviceReady(bootedDevice.deviceId);
    const first = registry.getByDeviceId(bootedDevice.deviceId);
    if (!first) {
      throw new Error("expected device session epoch");
    }

    await pool.removeDevice(bootedDevice.deviceId);

    expect(registry.getByDeviceId(bootedDevice.deviceId)).toBeUndefined();
    expect(registry.getByUuid(first.deviceSessionUuid)).toBeUndefined();

    await pool.addDevice(bootedDevice);

    expect(registry.getByDeviceId(bootedDevice.deviceId)?.deviceSessionUuid).not.toBe(
      first.deviceSessionUuid,
    );
  });
});
