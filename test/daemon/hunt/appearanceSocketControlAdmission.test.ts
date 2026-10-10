import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AppearanceSocketServer,
  type AppearanceDeviceSource,
  type AppearanceSocketServerDependencies,
} from "../../../src/daemon/appearanceSocketServer";
import type { AppearanceSocketResponse } from "../../../src/daemon/appearanceSocketTypes";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { SUSPECT_GRACE_MS } from "../../../src/daemon/livenessOwnerLease";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { SessionScopedStreamAuthenticator } from "../../../src/daemon/streamSocketAuth";
import {
  DeviceSettingDefaults,
  installDeviceSettingDefaults,
} from "../../../src/features/utility/DeviceSettingDefaults";
import type { AppearanceConfig, BootedDevice } from "../../../src/models";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import {
  FakeDeviceSettingDefaultsPersistence,
  FakeDeviceSettings,
} from "../../fakes/FakeDeviceSettingDefaults";
import { FakeSocket } from "../../fakes/FakeNetServer";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Hunt: `set_appearance` / `set_appearance_sync` on the appearance socket change the night mode of
 * the caller's held device, so they are control calls on that session. The socket server only
 * checks that the session is in the map (`authenticator.authorize`), and applies the mode with the
 * bare `applyToDevice`:
 *
 *  1. No device default is recorded before the change, unlike `setDisplayConfig` and the host
 *     appearance sync (#11145), so the next session to acquire the device inherits the mode.
 *  2. A suspect or lapsed holder (owner heartbeat gone) still re-themes the device; an MCP control
 *     call and `input/*` are refused there (#11417).
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
    const internals = this as unknown as {
      server: unknown;
      processLine(socket: Socket, line: string): Promise<void>;
      pendingBySocket: Map<unknown, Promise<void>>;
    };
    internals.server = { listening: true };
    await internals.processLine(socket as unknown as Socket, JSON.stringify(line));
    await internals.pendingBySocket.get(socket);
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

  function stateFor(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
  }

  const setDark = () =>
    server.request({ id: "r1", command: "set_appearance", sessionUuid: SESSION, mode: "dark" });

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(SESSION, DEVICE.deviceId, "android", 60_000);
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
        settings.current.nightMode = mode;
      },
      triggerSync: async () => {},
      isSyncEnabled: () => true,
    };
    const deviceSource: AppearanceDeviceSource = {
      getPooledDevices: () => [DEVICE],
      getCurrentDevice: () => undefined,
      getSessionForDevice: (deviceId) => sessionManager.getSessionForDevice(deviceId),
    };
    server = new TestableAppearanceSocketServer(
      "/fake/path/appearance.sock",
      timer,
      new SessionScopedStreamAuthenticator(() => sessionManager, "appearance", {}),
      deviceSource,
      dependencies,
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
});
