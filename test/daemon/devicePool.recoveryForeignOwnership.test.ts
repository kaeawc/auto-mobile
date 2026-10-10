import { afterEach, describe, expect, test } from "bun:test";
import { DEVICE_OWNED_BY_OTHER_DAEMON_CODE } from "../../src/daemon/deviceAcquisitionRefusals";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import type { DeviceSession } from "../../src/db/types";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// #11076: daemon A crashed holding emulator-5554 for session S; daemon B took the lapsed claim.
// When A restarts and S resumes, A must not rehydrate S onto the device B now drives.

const DEVICE_ID = "emulator-5554";
const AVD = "Original_AVD";
const SESSION = "restarted-session";
const DAEMON_A_PID = 1111;
const DAEMON_B_PID = 2222;

/** One host's claim files: device id -> owning daemon PID. */
class SharedClaimStore {
  readonly claims = new Map<string, number>();

  forDaemon(pid: number): ForeignDeviceOwnership {
    const store = this.claims;
    return {
      async refresh(): Promise<void> {},
      foreignOwnerPid(deviceId: string): number | undefined {
        const owner = store.get(deviceId);
        return owner === undefined || owner === pid ? undefined : owner;
      },
      async claim(deviceId: string): Promise<boolean> {
        const owner = store.get(deviceId);
        if (owner !== undefined && owner !== pid) {
          return false;
        }
        store.set(deviceId, pid);
        return true;
      },
      release(deviceId: string): void {
        if (store.get(deviceId) === pid) {
          store.delete(deviceId);
        }
      },
    };
  }
}

function persistedRow(): DeviceSession {
  return {
    session_uuid: SESSION,
    device_id: DEVICE_ID,
    stable_device_id: AVD,
    platform: "android",
    status: "expired",
    source: "session-manager",
    autolock_enabled: 0,
    mcp_session_id: null,
    daemon_session_id: "daemon-a-before-restart",
    created_at_ms: 1,
    last_used_at_ms: 20,
    expires_at_ms: 30,
    released_at_ms: 25,
    release_reason: "daemon-restart",
    session_timeout_ms: 10,
    heartbeat_timeout_ms: 5,
    has_received_heartbeat: 1,
    created_at: "2026-10-09T00:00:00.000Z",
    updated_at: "2026-10-09T00:00:00.000Z",
  };
}

describe("restart recovery onto a device another daemon holds (#11076)", () => {
  const managers: SessionManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) {
      manager.stopCleanupTimer();
    }
  });

  const restartedDaemonA = async (ownership: ForeignDeviceOwnership) => {
    const timer = new FakeTimer();
    const persisted = persistedRow();
    const releaseReasons: string[] = [];
    const upserts: string[] = [];
    const persistence: DeviceSessionPersistence = {
      async getSession() {
        return persisted;
      },
      async upsertActiveSession(session) {
        upserts.push(session.session_uuid);
      },
      async recordActivity() {},
      async markReleased(_sessionUuid, status, releasedAtMs, releaseReason) {
        releaseReasons.push(releaseReason);
        persisted.status = status;
        persisted.released_at_ms = releasedAtMs;
        persisted.release_reason = releaseReason;
      },
    };
    const sessions = new SessionManager(timer, persistence);
    managers.push(sessions);
    const devices = new FakeDeviceManager();
    const device = { deviceId: DEVICE_ID, name: AVD, platform: "android" as const };
    devices.bootedDevices = [device];
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon-a-after-restart", {
        timer,
        deviceManager: devices,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        foreignDeviceOwnership: ownership,
      }),
    );
    await pool.initializeWithDevices([device]);
    return { sessions, pool, persisted, releaseReasons };
  };

  const resume = async (a: Awaited<ReturnType<typeof restartedDaemonA>>) =>
    await a.sessions.getOrCreateSession(SESSION, a.pool, "android", undefined, true).then(
      () => undefined,
      (error: unknown) => error,
    );

  test("a live foreign claim terminalizes the recovered session with device_owned_by_other_daemon", async () => {
    const store = new SharedClaimStore();
    store.claims.set(DEVICE_ID, DAEMON_B_PID);
    const a = await restartedDaemonA(store.forDaemon(DAEMON_A_PID));

    const refusal = await resume(a);

    expect(refusal).toMatchObject({
      name: "SessionRecoveryIdentityLossError",
      code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      deviceId: DEVICE_ID,
      ownerPid: DAEMON_B_PID,
      reason: "owned-by-other-daemon",
    });
    expect(a.pool.getDevice(DEVICE_ID)?.sessionId ?? null).toBeNull();
    expect(a.sessions.getSession(SESSION)).toBeNull();
    expect(a.persisted.release_reason).toBe("identity-recovery-owned-by-other-daemon");
    expect(store.claims.get(DEVICE_ID)).toBe(DAEMON_B_PID);

    const shaped = JSON.parse(
      shapeToolCallError(refusal, { toolName: "observe", source: "MCP" }).content[0].text,
    );
    expect(shaped).toMatchObject({
      code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      deviceId: DEVICE_ID,
      retryable: false,
    });

    // The resuming client's next call hits the terminal session: it must be told to acquire a new
    // session (not retry the UUID), naming the terminal reason and the owning daemon (#11098).
    const terminal = await resume(a);
    expect(terminal).toBeInstanceOf(TerminalSessionError);
    const { release } = terminal as TerminalSessionError;
    expect(
      sessionOwnershipLostPayload({
        message: (terminal as Error).message,
        sessionUuid: SESSION,
        reason: release.releaseReason,
        release,
      }).error,
    ).toMatchObject({
      code: "session_ownership_lost",
      reason: "identity-recovery-owned-by-other-daemon",
      retryable: false,
      nextAction: "acquire_new_session",
      ownerPid: DAEMON_B_PID,
    });
  });

  test("a claim lost after assignment rolls the recovery back and terminalizes the session", async () => {
    const store = new SharedClaimStore();
    const own = store.forDaemon(DAEMON_A_PID);
    // Daemon B claims the device between the ownership refresh and daemon A's claim.
    const racing: ForeignDeviceOwnership = {
      refresh: (ids) => own.refresh(ids),
      foreignOwnerPid: (id) => own.foreignOwnerPid(id),
      claim: async (id) => {
        store.claims.set(id, DAEMON_B_PID);
        return await own.claim(id);
      },
      release: (id) => own.release(id),
    };
    const a = await restartedDaemonA(racing);

    const refusal = await resume(a);

    expect(refusal).toMatchObject({
      code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      reason: "owned-by-other-daemon",
    });
    expect(a.pool.getDevice(DEVICE_ID)?.sessionId ?? null).toBeNull();
    expect(a.sessions.getSession(SESSION)).toBeNull();
    expect(a.releaseReasons.at(-1)).toBe("identity-recovery-owned-by-other-daemon");
    expect(store.claims.get(DEVICE_ID)).toBe(DAEMON_B_PID);
  });

  test("an unclaimed recovery target is rebound and claimed", async () => {
    const store = new SharedClaimStore();
    const a = await restartedDaemonA(store.forDaemon(DAEMON_A_PID));

    expect(await resume(a)).toBeUndefined();

    expect(a.pool.getDevice(DEVICE_ID)?.sessionId).toBe(SESSION);
    expect(store.claims.get(DEVICE_ID)).toBe(DAEMON_A_PID);
    a.pool.releaseDeviceClaimsForShutdown();
  });
});
