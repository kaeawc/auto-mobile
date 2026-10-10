import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

/** Records each platform kill and stops there, so an admitted call proves only that it got past the gate. */
class RecordingKillDeviceManager extends FakeDeviceUtils {
  readonly killed: string[] = [];

  override async killDevice(device: BootedDevice): Promise<void> {
    this.killed.push(device.deviceId);
    throw new Error("platform kill reached");
  }
}

/**
 * killDevice is registered without device routing, so ToolRegistry's device-aware ownership check
 * (#10783) never ran for it: a session, or a sessionless CLI call, could kill an emulator another
 * session holds (#10785). The real killDevice registration now refuses that with
 * `device_owned_by_other_session` unless the caller holds the device or the user passes force.
 */
describe("killDevice device ownership (#10785)", () => {
  const held: BootedDevice = { name: "iPhone A", deviceId: "IOS-HELD", platform: "ios" };
  const free: BootedDevice = { name: "iPhone B", deviceId: "IOS-FREE", platform: "ios" };
  const holder = "holder-session";
  const other = "other-session";

  let manager: RecordingKillDeviceManager;
  let sessionManager: SessionManager;

  const kill = (args: Record<string, unknown>, routingSessionUuid?: string) =>
    runWithToolSelectionContext({ routingSessionUuid }, () =>
      ToolRegistry.getTool("killDevice")!.handler(args),
    );

  async function outcome(args: Record<string, unknown>, routingSessionUuid?: string) {
    try {
      await kill(args, routingSessionUuid);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  beforeEach(async () => {
    ToolRegistry.clearTools();
    const timer = new FakeTimer();
    manager = new RecordingKillDeviceManager();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    manager.setBootedDevices("ios", [held, free]);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "lifecycle-ownership", {
        timer,
        deviceManager: manager,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession(holder, held.deviceId, "ios");
    await sessionManager.createSession(other, free.deviceId, "ios");
    registerDeviceTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("another session's killDevice on a held device is refused before any shutdown work", async () => {
    const error = await outcome({ device: held }, other);

    expect(error).toBeInstanceOf(InputDeviceOwnedError);
    expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect((error as Error).message).toBe(
      `killDevice refused: device '${held.deviceId}' is held by another session. ` +
        `Session ${other} does not hold it; call it with the holding session's sessionUuid, ` +
        "wait for the holder to release the device, or pass force: true to stop it anyway.",
    );
    expect(manager.killed).toEqual([]);
    expect(sessionManager.getSessionForDevice(held.deviceId)).toBe(holder);
  });

  test("a sessionless killDevice on a held device is refused", async () => {
    const error = await outcome({ device: held });

    expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect((error as Error).message).toContain("The request carried no sessionUuid;");
    expect(manager.killed).toEqual([]);
  });

  test("an explicit sessionUuid naming another session is refused", async () => {
    const error = await outcome({ device: held, sessionUuid: other });

    expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(manager.killed).toEqual([]);
  });

  test("the holder's own killDevice reaches the platform kill", async () => {
    await outcome({ device: held }, holder);

    expect(manager.killed).toEqual([held.deviceId]);
  });

  test("a sessionless killDevice on an unheld device still reaches the platform kill", async () => {
    await sessionManager.releaseSession(other, "explicit-release");

    await outcome({ device: free });

    expect(manager.killed).toEqual([free.deviceId]);
  });

  test("an autolocked device stops for its own MCP connection and is refused to another", async () => {
    await sessionManager.releaseSession(other, "explicit-release");
    const pool = DaemonState.getInstance().getDevicePool();
    const autolocked = await pool.autolockDevice(
      free.deviceId,
      "ios",
      "owner-connection",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { autolockEnabled: true },
    );
    expect(sessionManager.getSessionForDevice(free.deviceId)).toBe(autolocked!);

    const refused = await outcome({ device: free, __mcpSessionId: "other-connection" });
    expect((refused as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(manager.killed).toEqual([]);

    await outcome({ device: free, __mcpSessionId: "owner-connection" });
    expect(manager.killed).toEqual([free.deviceId]);
  });

  test("force: true stops a held device for a non-holder and logs the override", async () => {
    const warn = spyOn(logger, "warn");
    try {
      await outcome({ device: held, force: true }, other);

      expect(manager.killed).toEqual([held.deviceId]);
      expect(warn.mock.calls.map(([message]) => String(message))).toContain(
        `[DeviceTools] killDevice force-stopping device '${held.deviceId}' held by session ` +
          `${holder}; requester session ${other} does not hold it.`,
      );
    } finally {
      warn.mockRestore();
    }
  });

  // The entry check passes for an unheld device; a start that holds the lifecycle lease
  // then binds another session while the kill waits. The kill must re-check once granted.
  class BindDuringWaitCoordinator extends InMemoryVirtualDeviceLifecycleCoordinator {
    constructor(private readonly onWait: () => Promise<void>) {
      super(new FakeTimer());
    }

    override async reserve(
      identity: Parameters<InMemoryVirtualDeviceLifecycleCoordinator["reserve"]>[0],
      options: Parameters<InMemoryVirtualDeviceLifecycleCoordinator["reserve"]>[1],
    ) {
      await this.onWait();
      return await super.reserve(identity, options);
    }
  }

  test("a kill queued behind a start lease refuses a device another session bound meanwhile", async () => {
    await sessionManager.releaseSession(other, "explicit-release");
    setDeviceToolsDependencies({
      lifecycleCoordinator: new BindDuringWaitCoordinator(async () => {
        await sessionManager.createSession("starter-session", free.deviceId, "ios");
      }),
    });

    const error = await outcome({ device: free }, "killer-session");

    expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(manager.killed).toEqual([]);
    expect(sessionManager.getSessionForDevice(free.deviceId)).toBe("starter-session");
  });

  test("force still stops a device bound during the lease wait", async () => {
    await sessionManager.releaseSession(other, "explicit-release");
    setDeviceToolsDependencies({
      lifecycleCoordinator: new BindDuringWaitCoordinator(async () => {
        await sessionManager.createSession("starter-session", free.deviceId, "ios");
      }),
    });

    await outcome({ device: free, force: true }, "killer-session");

    expect(manager.killed).toEqual([free.deviceId]);
  });

  test("the refusal reaches the client with the typed code", async () => {
    const error = await outcome({ device: held });

    const shaped = shapeToolCallError(error, { toolName: "killDevice", source: "MCP" });
    expect(JSON.parse(shaped.content[0].text)).toEqual({
      success: false,
      error: (error as Error).message,
      code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      deviceId: held.deviceId,
      retryable: false,
    });
  });
});
