import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AppearanceSocketServer,
  type AppearanceDeviceSource,
  type AppearanceSocketServerDependencies,
} from "../../src/daemon/appearanceSocketServer";
import type { AppearanceSocketResponse } from "../../src/daemon/wire/appearanceSocketTypes";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionScopedStreamAuthenticator } from "../../src/daemon/streamSocketAuth";
import { executionTracker } from "../../src/daemon/executionTracker";
import {
  DeviceSettingDefaults,
  installDeviceSettingDefaults,
} from "../../src/features/utility/DeviceSettingDefaults";
import type { AppearanceConfig, BootedDevice } from "../../src/models";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import {
  FakeDeviceSettingDefaultsPersistence,
  FakeDeviceSettings,
} from "../fakes/FakeDeviceSettingDefaults";
import { FakeListeningNetServer, FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * `set_appearance` / `set_appearance_sync` on the appearance socket change the night mode of the
 * caller's held device, so they are control calls on that session (#11486):
 *
 *  1. The device default is recorded before the change, like `setDisplayConfig` and the host
 *     appearance sync (#11145), so the next session to acquire the device gets it back.
 *  2. A suspect or lapsed holder (owner heartbeat gone) is refused before anything is stored or
 *     applied, as an MCP control call and `input/*` are (#11417).
 *  3. The apply is tracked on the holder's session, so the session is not released under it.
 *
 * Real SessionManager, heartbeat handler, stream authenticator, DeviceSettingDefaults and socket
 * server; only the device settings and the config store are fakes.
 */

const SESSION = "appearance-holder";
const NEXT_SESSION = "appearance-next-owner";
const OWNER_TOKEN = "harness-a";
const DEVICE: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const LEASE_MS = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS;

class TestableAppearanceSocketServer extends AppearanceSocketServer {
  async request(line: Record<string, unknown>): Promise<AppearanceSocketResponse> {
    const socket = new FakeSocket();
    this.server = new FakeListeningNetServer();
    await this.processLine(socket, JSON.stringify(line));
    await this.pendingBySocket.get(socket);
    const written = socket.getWrittenData();
    return JSON.parse(written[written.length - 1]!) as AppearanceSocketResponse;
  }
}

describe("appearance socket set_appearance as a control call on the holder's session", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let settings: FakeDeviceSettings;
  let defaults: DeviceSettingDefaults;
  let server: TestableAppearanceSocketServer;
  let trackedDuringApply: boolean | undefined;

  function stateFor(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        releaseDevice: async () => {},
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
  }

  const setDark = () =>
    server.request({ id: "r1", command: "set_appearance", sessionUuid: SESSION, mode: "dark" });

  beforeEach(async () => {
    trackedDuringApply = undefined;
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SESSION, DEVICE.deviceId, "android", { timeoutMs: 60_000 });
    const claim = await handleDaemonRequest(
      {
        id: "claim",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId: SESSION,
          livenessOwnerToken: OWNER_TOKEN,
          claimLivenessOwnership: true,
        },
      },
      stateFor(),
    );
    expect(claim.success).toBe(true);

    settings = new FakeDeviceSettings({ nightMode: "light" });
    defaults = new DeviceSettingDefaults(
      new FakeDeviceSettingDefaultsPersistence(),
      settings,
      (id) => sessionManager.getSessionForDevice(id),
    );
    // As daemon.ts installs it for the tool paths.
    installDeviceSettingDefaults(defaults);

    let config: AppearanceConfig = {
      syncWithHost: false,
      defaultMode: "light",
      applyOnConnect: true,
    };
    const dependencies: AppearanceSocketServerDependencies = {
      getConfig: async () => config,
      updateConfig: async (update) => {
        config = { ...config, ...update } as AppearanceConfig;
        return config;
      },
      resolveMode: async () => "light",
      // The device write `applyAppearanceToDevice` performs (`cmd uimode night yes|no`).
      applyToDevice: async (_device, mode) => {
        trackedDuringApply = executionTracker.hasActiveSessionUuidExecutions(SESSION);
        settings.current.nightMode = mode;
      },
      triggerSync: async () => {},
      isSyncEnabled: () => true,
    };
    const deviceSource: AppearanceDeviceSource = {
      getPooledDevices: () => [DEVICE],
      getSessionDevice: () => undefined,
      getSessionForDevice: (deviceId) => sessionManager.getSessionForDevice(deviceId),
      // As the default device source resolves it from the daemon state.
      getSessionManager: () => sessionManager,
    };
    server = new TestableAppearanceSocketServer(
      "/fake/path/appearance.sock",
      timer,
      new SessionScopedStreamAuthenticator(() => sessionManager, "appearance", {}),
      { deviceSource, dependencies },
    );
  });

  afterEach(() => {
    installDeviceSettingDefaults(undefined);
    sessionManager.stopCleanupTimer();
  });

  test("control: a live holder's set_appearance reaches its device", async () => {
    const response = await setDark();

    expect(response).toMatchObject({ success: true, result: { appliedMode: "dark" } });
    expect(settings.current.nightMode).toBe("dark");
  });

  test("the night mode a holder set over the socket is reset for the next owner (#11145)", async () => {
    await setDark();
    expect(settings.current.nightMode).toBe("dark");

    await defaults.resetOnAcquisition(DEVICE.deviceId, NEXT_SESSION);

    // setDisplayConfig and the host appearance sync record the default first; this path does not.
    expect(settings.current.nightMode).toBe("light");
  });

  test("a suspect holder's set_appearance does not reach the device", async () => {
    timer.advanceTime(LEASE_MS + 1);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("suspect");

    const response = await setDark();

    expect(settings.current.nightMode).toBe("light");
    expect(response.success).toBe(false);
  });

  test("a lapsed holder's set_appearance does not reach the device", async () => {
    timer.advanceTime(LEASE_MS + SUSPECT_GRACE_MS + 1);
    expect(sessionManager.getSessionLeaseState(SESSION)?.phase).toBe("lapsed");

    const response = await setDark();

    expect(settings.current.nightMode).toBe("light");
    expect(response.success).toBe(false);
  });

  test("a refused set_appearance stores no config", async () => {
    timer.advanceTime(LEASE_MS + 1);

    const refused = await setDark();
    const stored = await server.request({
      id: "r2",
      command: "get_appearance_config",
      sessionUuid: SESSION,
    });

    expect(refused.success).toBe(false);
    expect(refused.error).toContain(SESSION);
    expect(stored.result?.config).toMatchObject({ defaultMode: "light", syncWithHost: false });
  });

  test("a suspect holder's set_appearance_sync does not reach the device", async () => {
    settings.current.nightMode = "dark";
    timer.advanceTime(LEASE_MS + 1);

    const response = await server.request({
      id: "r1",
      command: "set_appearance_sync",
      sessionUuid: SESSION,
      enabled: true,
    });

    expect(settings.current.nightMode).toBe("dark");
    expect(response.success).toBe(false);
  });

  test("the apply is tracked as a call in flight on the holder's session, then ended", async () => {
    await setDark();

    expect(trackedDuringApply).toBe(true);
    expect(executionTracker.hasActiveSessionUuidExecutions(SESSION)).toBe(false);
  });

  test("a refused command leaves no execution behind", async () => {
    timer.advanceTime(LEASE_MS + 1);

    await setDark();

    expect(trackedDuringApply).toBeUndefined();
    expect(executionTracker.hasActiveSessionUuidExecutions(SESSION)).toBe(false);
  });
});
