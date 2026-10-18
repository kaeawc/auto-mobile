import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
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
    const attach = spyOn(SessionManager.prototype, "attachDaemonSessionId");
    new Daemon(
      {},
      {
        timer: new FakeTimer(),
        deviceSessionRepository: new DeviceSessionRepository(),
        idGenerator,
      },
    );

    // First id minted during construction (daemonSessionId).
    try {
      expect(attach).toHaveBeenCalledWith("daemon-session-1");
    } finally {
      attach.mockRestore();
    }
  });

  test("retires a removed device epoch and mints a replacement through daemon wiring", async () => {
    const timer = new FakeTimer();
    const idGenerator = new CountingIdGenerator("device-session");
    const daemon = new Daemon(
      {},
      { installedAppsRepository: new FakeInstalledAppsRepository(), timer, idGenerator },
    );
    const pool = daemon.getDevicePool();
    const registry = DaemonState.getInstance().getDeviceSessionRegistry();
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
