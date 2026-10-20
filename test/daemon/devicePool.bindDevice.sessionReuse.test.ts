import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  ANONYMOUS_ACQUISITION_SESSION_SOURCE,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";

import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  createBootedDevice,
  createDevicePoolSuite,
  devicePoolSuiteActions,
} from "../helpers/devicePoolSuite";

useSessionIdleWindowForSuite();

describe("DevicePool", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeDeviceManager: FakeDeviceManager;
  const { initializeLiveDevices } = devicePoolSuiteActions(() => ({
    devicePool,
    sessionManager,
    fakeTimer,
    fakeAppsRepo,
    fakeDeviceManager,
  }));

  beforeEach(() => {
    ({ devicePool, sessionManager, fakeTimer, fakeAppsRepo, fakeDeviceManager } =
      createDevicePoolSuite());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  describe("assignDeviceToSession", () => {
    test("should reuse a live session when the device is already bound", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-1",
        deviceId: "sim-1",
        platform: "ios",
      });

      const sessionId = await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-2",
        deviceId: "sim-1",
        platform: "ios",
      });

      expect(sessionId).toBe("session-1");
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
      // The creator kind is recorded on the session and persisted with it (#11071).
      expect(sessionManager.getSession("session-1")?.persistenceMetadata?.source).toBe(
        ANONYMOUS_ACQUISITION_SESSION_SOURCE,
      );
    });

    const bindAs = (
      sessionId: string,
      mcpSessionId?: string,
      allowSessionRebind = false,
      oneShotCli = false,
    ) =>
      devicePool.bindOrReuseDeviceSession({
        sessionId,
        deviceId: "sim-1",
        platform: "ios",
        allowSessionRebind,
        mcpSessionId,
        oneShotCli,
      });
    const refusalOf = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => error,
      );

    test("should reuse a live session when its acquiring connection binds the device again", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "connection-1");

      const sessionId = await bindAs("session-2", "connection-1");

      expect(sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    // #11071: without an MCP identity the pool handed an anonymous caller the holder's UUID.
    test("refuses an anonymous bind of a device a connection acquired, typed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "connection-1");

      const refusal = await refusalOf(bindAs("session-2"));

      expect(refusal).toMatchObject({
        code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
        message: "Device 'sim-1' is already assigned to session session-1",
      });
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    test("refuses an anonymous bind of a device a caller-chosen session holds, typed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      // setActiveDevice binds the caller's own session (desktop, explicit UUID): not anonymous.
      await bindAs("desktop-session", undefined, true);

      const refusal = await refusalOf(bindAs("session-2"));

      expect(refusal).toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("desktop-session");
    });

    // #11071: a connection that never acquired the device got an untyped refusal.
    test("refuses another connection's bind of a held device, typed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "connection-1");

      const refusal = await refusalOf(bindAs("session-2", "connection-2"));

      expect(refusal).toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
      expect((refusal as Error).message).toContain("already assigned to another session");
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
    });

    // #11096: every socket call carries a per-connection MCP id, so one-shot `--cli` connections
    // are anonymous by their explicit marker, not by a missing id.
    test("reuses a one-shot CLI connection's session for the next one-shot CLI connection", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "cli-connection-1", false, true);

      const sessionId = await bindAs("session-2", "cli-connection-2", false, true);

      expect(sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
      expect(sessionManager.getSession("session-1")?.persistenceMetadata?.source).toBe(
        ANONYMOUS_ACQUISITION_SESSION_SOURCE,
      );
    });

    // #11138: an acquisition that resolved a source image fell into the freshly-started guard.
    test("reuses an anonymous session for a one-shot CLI bind that resolved a source image", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "cli-connection-1", false, true);

      const sessionId = await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-2",
        deviceId: "sim-1",
        platform: "ios",
        sourceImage: {
          name: "iPhone 15",
          platform: "ios",
          deviceId: "sim-1",
          isRunning: true,
          source: "local",
        },
        allowSessionRebind: false,
        mcpSessionId: "cli-connection-2",
        oneShotCli: true,
      });

      expect(sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    // #11153: one-shot A cold-boots the emulator while one-shot B's anonymous bind of the same
    // serial lands first; A must be refused rather than silently sharing B's session.
    test("refuses a one-shot CLI bind that cold-booted the device when another anonymous session took it", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "cli-connection-1", false, true);

      const refusal = await refusalOf(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-2",
          deviceId: "sim-1",
          platform: "ios",
          sourceImage: {
            name: "iPhone 15",
            platform: "ios",
            deviceId: "sim-1",
            isRunning: true,
            source: "local",
          },
          childProcess: new FakeChildProcess(),
          allowSessionRebind: false,
          mcpSessionId: "cli-connection-2",
          oneShotCli: true,
        }),
      );

      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain("Freshly started device 'sim-1'");
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
    });

    test("refuses a one-shot CLI bind of a device an MCP connection acquired, typed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "connection-1");

      const refusal = await refusalOf(bindAs("session-2", "cli-connection-2", false, true));

      expect(refusal).toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-1")?.persistenceMetadata?.source).toBeUndefined();
    });

    test("refuses an MCP connection's bind of a device a one-shot CLI connection acquired", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await bindAs("session-1", "cli-connection-1", false, true);

      const refusal = await refusalOf(bindAs("session-2", "connection-2"));

      expect(refusal).toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
    });

    test("rejects binding a stale idle iOS simulator that is no longer booted", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-stale", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];

      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-stale",
          deviceId: "sim-stale",
          platform: "ios",
        }),
      ).rejects.toThrow(/not available/);
      expect(devicePool.getDevice("sim-stale")?.status).toBe("idle");
      expect(sessionManager.getSession("session-stale")).toBeNull();
    });

    test("retains a stale pooled Android emulator when direct binding rejects", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
      ]);
      fakeDeviceManager.bootedDevices = [];

      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-1",
          deviceId: "emulator-5554",
          platform: "android",
        }),
      ).rejects.toThrow(/not available|shut down|disconnected/);

      expect(devicePool.getDevice("emulator-5554")?.status).toBe("idle");
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("preserves an active session when a pre-lock absent snapshot rejects reuse", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554", "android", "Pixel 8")]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-1",
        deviceId: "emulator-5554",
        platform: "android",
      });
      fakeDeviceManager.bootedDevices = [];

      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-2",
          deviceId: "emulator-5554",
          platform: "android",
        }),
      ).rejects.toThrow(/not available|shut down|disconnected/);

      expect(devicePool.getDevice("emulator-5554")?.status).toBe("busy");
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-5554");
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    test("retains a stale pooled Android emulator when autolock rejects", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      try {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await devicePool.initializeWithDevices([
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
        ]);
        fakeDeviceManager.bootedDevices = [];

        await expect(
          devicePool.autolockDevice("emulator-5554", "android", "mcp-session-1"),
        ).rejects.toThrow(/not available|shut down|disconnected/);

        expect(devicePool.getDevice("emulator-5554")?.status).toBe("idle");
        expect(
          devicePool.resolveAutolockSessionForMcpSession("mcp-session-1", "android"),
        ).toBeUndefined();
      } finally {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });
  });
});
