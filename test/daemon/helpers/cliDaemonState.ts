import { DevicePool, type PooledDevice } from "../../../src/daemon/devicePool";
import type { DaemonStateLike } from "../../../src/daemon/daemonState";
import { SessionManager, type Session } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";

/** Throws when the code under test touches a collaborator the scenario did not script. */
export const unexpected = (..._args: readonly unknown[]): never => {
  throw new Error("Unexpected daemon operation");
};

/** A daemon state for the CLI's remote branch: not initialized, nothing reachable. */
export const remoteDaemonState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpected,
  getDevicePool: unexpected,
  getDeviceSessionRegistry: unexpected,
};

type SessionHooks = Partial<
  Pick<
    SessionManager,
    | "getSession"
    | "getReleasingSession"
    | "releaseSession"
    | "recordHeartbeat"
    | "getIdleReleaseExecutionVeto"
    | "getSessionLeaseState"
    | "sessionClockToReportedWall"
  >
>;

/** A real SessionManager whose scripted methods run the scenario's hooks; the rest refuse. */
export class ScriptedSessionManager extends SessionManager {
  constructor(private readonly hooks: SessionHooks) {
    super(new FakeTimer(), new FakeDeviceSessionPersistence());
  }

  override getSession(...args: Parameters<SessionManager["getSession"]>) {
    return (this.hooks.getSession ?? unexpected)(...args);
  }

  override getReleasingSession(...args: Parameters<SessionManager["getReleasingSession"]>) {
    return (this.hooks.getReleasingSession ?? unexpected)(...args);
  }

  override releaseSession(...args: Parameters<SessionManager["releaseSession"]>) {
    return (this.hooks.releaseSession ?? unexpected)(...args);
  }

  override recordHeartbeat(...args: Parameters<SessionManager["recordHeartbeat"]>) {
    return (this.hooks.recordHeartbeat ?? unexpected)(...args);
  }

  override getIdleReleaseExecutionVeto(
    ...args: Parameters<SessionManager["getIdleReleaseExecutionVeto"]>
  ) {
    return (this.hooks.getIdleReleaseExecutionVeto ?? unexpected)(...args);
  }

  override getSessionLeaseState(...args: Parameters<SessionManager["getSessionLeaseState"]>) {
    return (this.hooks.getSessionLeaseState ?? unexpected)(...args);
  }

  override sessionClockToReportedWall(
    ...args: Parameters<SessionManager["sessionClockToReportedWall"]>
  ) {
    return (this.hooks.sessionClockToReportedWall ?? unexpected)(...args);
  }
}

type PoolHooks = Partial<
  Pick<
    DevicePool,
    | "releaseDevice"
    | "getRefreshedInventory"
    | "getRecoveryPolicy"
    | "getAllDevices"
    | "getRecoveryEligibility"
  >
>;

/** A real DevicePool whose scripted methods run the scenario's hooks; the rest refuse. */
export class ScriptedDevicePool extends DevicePool {
  constructor(
    sessionManager: SessionManager,
    private readonly hooks: PoolHooks,
  ) {
    super(
      createDevicePoolDependencies(sessionManager, "scripted-cli-pool", {
        timer: new FakeTimer(),
        deviceManager: new FakeDeviceUtils(),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
  }

  override releaseDevice(...args: Parameters<DevicePool["releaseDevice"]>) {
    return (this.hooks.releaseDevice ?? unexpected)(...args);
  }

  override getRefreshedInventory(...args: Parameters<DevicePool["getRefreshedInventory"]>) {
    return (this.hooks.getRefreshedInventory ?? unexpected)(...args);
  }

  override getRecoveryPolicy(...args: Parameters<DevicePool["getRecoveryPolicy"]>) {
    return (this.hooks.getRecoveryPolicy ?? unexpected)(...args);
  }

  override getAllDevices(...args: Parameters<DevicePool["getAllDevices"]>) {
    return (this.hooks.getAllDevices ?? unexpected)(...args);
  }

  override getRecoveryEligibility(...args: Parameters<DevicePool["getRecoveryEligibility"]>) {
    return (this.hooks.getRecoveryEligibility ?? unexpected)(...args);
  }
}

/** A complete Session; `overrides` replace any field. */
export function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "fake-session",
    assignedDevice: "fake-device",
    platform: "android",
    createdAt: 0,
    lastUsedAt: 0,
    activityGeneration: 0,
    expiresAt: 0,
    cacheData: {},
    lastHeartbeat: 0,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: false,
    ownership: "owned",
    livenessPolicy: "heartbeat",
    ...overrides,
  };
}

/** A complete idle PooledDevice; `overrides` replace any field. */
export function buildPooledDevice(overrides: Partial<PooledDevice> = {}): PooledDevice {
  return {
    id: "fake-device",
    name: "Fake Device",
    platform: "android",
    sessionId: null,
    status: "idle",
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation: 1,
    ...overrides,
  };
}
