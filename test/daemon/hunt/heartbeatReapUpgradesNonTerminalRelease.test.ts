import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { isTerminalReleaseReason } from "../../../src/daemon/releaseReasons";
import { SessionManager } from "../../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
} from "../../../src/daemon/sessionLivenessWindows";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

// Hunt 2026-10-10 (heartbeat lease, daemon side). A session stays in the session map for the whole
// awaited teardown of its release, and for that whole time its owner's heartbeats are answered
// "Session not found" (`isSessionReleasing`) and stamp nothing. The heartbeat monitor still judges
// it: `reapStaleSessions` skips only its own reaps, never a session another release is tearing
// down. Once the teardown outlasts lease + grace (a clock restore alone is awaited for up to
// CLOCK_RESTORE_TIMEOUT_MS = 15 s), the monitor "reaps" the releasing session as
// `heartbeat-timeout`, and `upgradeReleaseReason` lets that terminal reason replace the
// non-terminal one the release was started with.
//
// So a recoverable handoff (`device-restart:<id>`, which the owner is meant to resume by naming the
// UUID) or a re-issuable `plan-auto-release` of a session whose owner never stopped heartbeating is
// recorded and announced as a terminal heartbeat loss: the UUID is fenced and the owner's next
// call gets `session_ownership_lost` / `acquire_new_session`.

const SESSION = "hunt-releasing-session";
const DEVICE = "emulator-5554";
const OWNER = "hunt-owner-token";
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
/** A slow, but successful, clock restore: under its own 15 s budget, over lease + grace. */
const CLOCK_RESTORE_MS = 11_000;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

describe("a non-terminal release whose teardown outlasts lease + grace, owner still heartbeating", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaped: string[];
  let announced: string[];

  function heartbeat() {
    const state: DaemonStateAccess = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => DEVICE_POOL,
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    };
    return handleDaemonRequest(
      {
        id: "heartbeat",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: { sessionId: SESSION, livenessOwnerToken: OWNER },
      },
      state,
    );
  }

  /** The owner's proxy heartbeats on its cadence while the daemon's scans run on theirs. */
  async function ownerKeepsHeartbeatingFor(ms: number): Promise<boolean[]> {
    const acks: boolean[] = [];
    for (let elapsed = 0; elapsed < ms; elapsed += PROXY_HEARTBEAT_INTERVAL_MS) {
      acks.push((await heartbeat()).success);
      await timer.advanceTimeAsync(PROXY_HEARTBEAT_INTERVAL_MS, () => drainMicrotasks(50));
    }
    return acks;
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      undefined,
      undefined,
      {
        networkCondition: () => ({ restore: async () => undefined }),
        // `adb unroot` restarts adbd; the restore finishes only once the device reconnects.
        clock: () => ({ restore: () => timer.sleep(CLOCK_RESTORE_MS) }),
      },
    );
    manager.stopCleanupTimer();
    reaped = [];
    announced = [];
    manager.onSessionRelease((_sessionId, _deviceId, releaseReason) => {
      announced.push(releaseReason);
    });
    // Wired as the daemon wires it: the reap is a release with the monitor's reason.
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        reaped.push(reason);
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    const session = await manager.createSession(SESSION, DEVICE, "android");
    manager.setClock(session, {
      initialAutomaticTime: 1,
      clockChangedByUs: true,
      rootedByUs: true,
    });
    expect(await manager.claimLivenessOwnership(SESSION, OWNER)).toBe("claimed");
    monitor.start();
    // A healthy owner: every heartbeat is acknowledged and nothing is reaped.
    expect(await ownerKeepsHeartbeatingFor(3 * SCAN_MS)).toEqual([true, true, true]);
    expect(reaped).toEqual([]);
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  test.each(["device-restart:Pixel_A", "plan-auto-release"] as const)(
    "%s is not rewritten into a terminal heartbeat-timeout",
    async (releaseReason) => {
      expect(isTerminalReleaseReason(releaseReason)).toBe(false);

      const release = manager.releaseSession(SESSION, releaseReason);
      // The owner is alive the whole time; the daemon just does not accept its heartbeats.
      const acks = await ownerKeepsHeartbeatingFor(CLOCK_RESTORE_MS + SCAN_MS);
      expect(await release).toBe(DEVICE);
      expect(acks.every((acknowledged) => !acknowledged)).toBe(true);

      // The release keeps the reason it was started with, and nothing terminal is raised: the
      // UUID stays recoverable / re-issuable by name.
      expect({
        announced,
        recorded: await manager.getReleasedSessionReason(SESSION),
        terminalFence: manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason,
        // The monitor must not release, on the owner's "silence", a session whose heartbeats
        // the daemon itself was refusing.
        reaped,
      }).toEqual({
        announced: [releaseReason],
        recorded: releaseReason,
        terminalFence: undefined,
        reaped: [],
      });
    },
  );
});
