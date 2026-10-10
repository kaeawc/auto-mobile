import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DeviceOwnedByOtherDaemonError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
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

/** Another live daemon's claims, as this daemon's claim store sees them. */
class FakeForeignDeviceOwnership implements ForeignDeviceOwnership {
  /** Devices another live daemon holds, by owner PID, as the next refresh reports them. */
  readonly owners = new Map<string, number>();
  /** Devices whose claim another daemon wins at claim time. */
  readonly claimRefused = new Set<string>();
  readonly claims: string[] = [];
  readonly releases: string[] = [];
  private refreshed = new Map<string, number>();

  async refresh(deviceIds: readonly string[]): Promise<void> {
    for (const id of deviceIds) {
      const pid = this.owners.get(id);
      if (pid === undefined) {
        this.refreshed.delete(id);
      } else {
        this.refreshed.set(id, pid);
      }
    }
  }
  foreignOwnerPid(deviceId: string): number | undefined {
    return this.refreshed.get(deviceId);
  }
  async claim(deviceId: string): Promise<boolean> {
    this.claims.push(deviceId);
    return !this.claimRefused.has(deviceId) && !this.owners.has(deviceId);
  }
  release(deviceId: string): void {
    this.releases.push(deviceId);
  }
}

/**
 * A device a live peer daemon holds reads as unheld to this daemon's sessions, so the #10785 guard
 * alone let a sessionless killDevice stop it and the peer's session died as device-disconnected.
 * The kill now consults the peer's claim at entry, and publishes its own claim under the shutdown
 * reservation so a peer cannot bind the device while it is stopped (#11200).
 */
describe("killDevice on a device another daemon holds (#11200)", () => {
  const phone: BootedDevice = { name: "Pixel", deviceId: "R58M11200", platform: "android" };
  const PEER_PID = 4242;

  let manager: RecordingKillDeviceManager;
  let ownership: FakeForeignDeviceOwnership;
  let pool: DevicePool;
  let sessionManager: SessionManager;

  const outcome = async (args: Record<string, unknown>) => {
    try {
      await ToolRegistry.getTool("killDevice")!.handler(args);
    } catch (error) {
      return error;
    }
    return undefined;
  };

  beforeEach(async () => {
    ToolRegistry.clearTools();
    const timer = new FakeTimer();
    manager = new RecordingKillDeviceManager();
    ownership = new FakeForeignDeviceOwnership();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    manager.setBootedDevices("android", [phone]);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "lifecycle-foreign-daemon", {
        timer,
        deviceManager: manager,
        foreignDeviceOwnership: ownership,
      }),
    );
    await pool.initializeWithDevices([phone]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    registerDeviceTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("a sessionless kill of a device a live peer daemon holds is refused with the typed code", async () => {
    ownership.owners.set(phone.deviceId, PEER_PID);

    const error = await outcome({ device: phone });

    expect(error).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect((error as DeviceOwnedByOtherDaemonError).code).toBe(DEVICE_OWNED_BY_OTHER_DAEMON_CODE);
    expect((error as Error).message).toBe(
      `Device '${phone.deviceId}' is claimed by another AutoMobile daemon (PID ${PEER_PID}) ` +
        `(code ${DEVICE_OWNED_BY_OTHER_DAEMON_CODE}); two daemons must never drive the same device. ` +
        "Stop it through the daemon that holds it, wait for that daemon to release it, or pass " +
        "force: true to stop it anyway.",
    );
    expect(manager.killed).toEqual([]);
    expect(ownership.claims).toEqual([]);
  });

  test("force: true stops it anyway and logs the override", async () => {
    ownership.owners.set(phone.deviceId, PEER_PID);
    const warn = spyOn(logger, "warn");
    try {
      await outcome({ device: phone, force: true });

      expect(manager.killed).toEqual([phone.deviceId]);
      expect(warn.mock.calls.map(([message]) => String(message))).toContain(
        `[DeviceTools] killDevice force-stopping device '${phone.deviceId}' held by another ` +
          `AutoMobile daemon (PID ${PEER_PID}).`,
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("a peer that claims the device after the entry check wins it: the kill is refused", async () => {
    // The entry check sees no claim; the peer's claim is in place by the time the kill claims.
    ownership.claimRefused.add(phone.deviceId);

    const error = await outcome({ device: phone });

    expect((error as DeviceOwnedByOtherDaemonError).code).toBe(DEVICE_OWNED_BY_OTHER_DAEMON_CODE);
    expect(manager.killed).toEqual([]);
    expect(pool.isUnderShutdownReservation(phone.deviceId)).toBe(false);
    expect(ownership.releases).toEqual([]);
  });

  test("an unheld device is claimed for the stop and the claim is withdrawn after", async () => {
    await outcome({ device: phone });

    expect(manager.killed).toEqual([phone.deviceId]);
    expect(ownership.claims).toEqual([phone.deviceId]);
    expect(ownership.releases).toEqual([phone.deviceId]);
  });
});
