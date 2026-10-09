import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
  ownerDisconnectReleaseBlocker,
} from "../../src/daemon/ownerDisconnectRelease";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, drainUntil, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";

const DEVICE: BootedDevice = { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" };
const OWNER_SESSION = "owner-session";
const OWNER_CONNECTION = "owner-connection";
const NEW_CONNECTION = "new-client-connection";
const REFUSAL = "already assigned to another session";

describe("DevicePool owner-disconnect release (#10503)", () => {
  let fakeTimer: FakeTimer;
  let sessionManager: SessionManager;
  let devicePool: DevicePool;
  let releaseReasons: string[];

  const bind = (sessionId: string, mcpSessionId: string) =>
    devicePool.bindOrReuseDeviceSession(
      sessionId,
      DEVICE.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      mcpSessionId,
    );

  const ownerSession = (): Session => {
    const session = sessionManager.getSession(OWNER_SESSION);
    if (!session) {
      throw new Error("owner session missing");
    }
    return session;
  };

  const awaitOwnerRelease = () =>
    drainUntil(() => devicePool.getDevice(DEVICE.deviceId)?.sessionId === null, {
      description: "the disconnected owner's device to return to the pool",
    });

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    releaseReasons = [];
    sessionManager.onSessionRelease((_sessionId, _deviceId, reason) => {
      releaseReasons.push(reason);
    });
    const fakeDeviceManager = new FakeDeviceManager();
    fakeDeviceManager.bootedDevices = [DEVICE];
    devicePool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
        timer: fakeTimer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager: fakeDeviceManager,
        retryExecutor: new DefaultRetryExecutor(fakeTimer),
      }),
    );
    await devicePool.initializeWithDevices([DEVICE]);
    await bind(OWNER_SESSION, OWNER_CONNECTION);
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  test("a new client acquires the device once the owner's connection has been closed for the grace", async () => {
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);

    await expect(bind("new-session", NEW_CONNECTION)).rejects.toThrow(REFUSAL);

    fakeTimer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await awaitOwnerRelease();

    expect(sessionManager.getSession(OWNER_SESSION)).toBeNull();
    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    await expect(bind("new-session", NEW_CONNECTION)).resolves.toBe("new-session");
  });

  test("a live owner's session is still refused after the grace", async () => {
    fakeTimer.advanceTime(OWNER_DISCONNECT_GRACE_MS * 2);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    await expect(bind("new-session", NEW_CONNECTION)).rejects.toThrow(REFUSAL);
    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();
    expect(releaseReasons).toEqual([]);
  });

  test("an owner that restores ownership on a new connection within the grace keeps its session", async () => {
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    await devicePool.restoreOwnedDeviceSessionsForMcpSession([OWNER_SESSION], "reconnected-owner");

    fakeTimer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    await expect(bind("new-session", NEW_CONNECTION)).rejects.toThrow(REFUSAL);
  });

  test("another connection cannot restore a live session its owner's connection still holds (#11107)", async () => {
    const refusal = [
      {
        sessionId: OWNER_SESSION,
        deviceId: expect.any(String),
        reason: "owned-by-other-connection",
      },
    ];
    expect(
      await devicePool.restoreOwnedDeviceSessionsForMcpSession([OWNER_SESSION], NEW_CONNECTION),
    ).toEqual(refusal);
    expect(
      await devicePool.restoreOwnedDeviceSessionsForMcpSession(
        [OWNER_SESSION],
        NEW_CONNECTION,
        "someone-elses-token",
      ),
    ).toEqual(refusal);

    // The real owner's disconnect is not suppressed by a claimed duplicate owner.
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    fakeTimer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await awaitOwnerRelease();
    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
  });

  test("a restore proving the owner token moves ownership rather than duplicating it (#11107)", async () => {
    expect(await sessionManager.claimLivenessOwnership(OWNER_SESSION, "owner-token")).toBe(
      "claimed",
    );
    await devicePool.restoreOwnedDeviceSessionsForMcpSession(
      [OWNER_SESSION],
      "reconnected-owner",
      "owner-token",
    );

    // The new connection is the sole owner: its close starts the release even though the stale
    // connection has not closed yet, which no longer holds a duplicate claim to suppress it.
    devicePool.releaseMcpSessionBindings("reconnected-owner");
    fakeTimer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await awaitOwnerRelease();
    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
  });

  test("an owner that heartbeats after its connection closed keeps its session", async () => {
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    fakeTimer.advanceTime(1_000);
    sessionManager.recordHeartbeat(OWNER_SESSION);

    fakeTimer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();
    expect(releaseReasons).toEqual([]);
  });

  test("a backward wall-clock step between the owner's heartbeat and its disconnect does not block the release (#11080)", async () => {
    fakeTimer.advanceTime(1_000);
    sessionManager.recordHeartbeat(OWNER_SESSION);
    // An NTP correction an hour back: a wall-stamped close time would now predate the heartbeat
    // and read as "owner heartbeated after the connection closed".
    fakeTimer.stepWallClock(-3_600_000);
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);

    fakeTimer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await awaitOwnerRelease();

    expect(sessionManager.getSession(OWNER_SESSION)).toBeNull();
    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
  });

  test("a CLI-idle session survives its one-shot client's exit", async () => {
    sessionManager.adoptCliLivenessPolicy(OWNER_SESSION);
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);

    fakeTimer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();
    expect(releaseReasons).toEqual([]);
  });

  test("a session mid liveness-ownership handoff is left to its lease (#10337)", async () => {
    await sessionManager.claimLivenessOwnership(OWNER_SESSION, "old-proxy-token");
    await sessionManager.releaseLivenessOwnership(OWNER_SESSION, "old-proxy-token");
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);

    fakeTimer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();
    expect(releaseReasons).toEqual([]);
  });

  test("an explicit release during the grace cancels the pending release", async () => {
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    await sessionManager.releaseSession(OWNER_SESSION, "explicit-release");

    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    expect(releaseReasons).toEqual(["explicit-release"]);
    expect(sessionManager.getSession(OWNER_SESSION)).toBeNull();
  });

  test("the release blocker reads the owner's heartbeat, not tool activity", () => {
    const session = ownerSession();
    const closedAt = fakeTimer.now();
    expect(ownerDisconnectReleaseBlocker(session, closedAt)).toBeUndefined();
    expect(
      ownerDisconnectReleaseBlocker(
        { ...session, lastHeartbeat: closedAt + 1, lastOwnerHeartbeat: closedAt },
        closedAt,
      ),
    ).toBeUndefined();
    expect(
      ownerDisconnectReleaseBlocker({ ...session, lastOwnerHeartbeat: closedAt + 1 }, closedAt),
    ).toBe("owner heartbeated after the connection closed");
    expect(
      ownerDisconnectReleaseBlocker({ ...session, ownership: "awaiting-owner" }, closedAt),
    ).toBe("awaiting its rehydrated owner");
  });
});
