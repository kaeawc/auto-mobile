import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import {
  handleDaemonRequest,
  type DaemonMethodResult,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DAEMON_SESSION_NOT_FOUND_CODE as NOT_FOUND } from "../../src/daemon/types";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

// After an idle or heartbeat release every wire answers with the same terminal reason; none
// answers as if the UUID had never been issued (#10730, #10832, #11646). The real SessionManager,
// SessionHeartbeatMonitor and daemon request handlers run over an in-memory persistence fake and a
// FakeTimer: nothing here starts a process, opens a socket or touches a device.

const SESSION = "terminal-release-reason-session";
const DEVICE = "emulator-5554";
const OWNER = "terminal-release-reason-owner";
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;

const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
};

interface Rig {
  timer: FakeTimer;
  persistence: FakeDeviceSessionPersistence;
  manager: SessionManager;
  monitor: SessionHeartbeatMonitor;
  /** The reasons the monitor reaped with, in order. */
  reaped: string[];
  request(method: string, params: Record<string, unknown>): Promise<DaemonMethodResult>;
  /** Move the clock forward by `ms` without running a scan. */
  advance(ms: number): void;
  /** One on-time monitor scan `SCAN_MS` later; does not wait for the releases it starts. */
  scanOnTime(): Promise<void>;
  dispose(): Promise<void>;
}

/** Let every already-resolvable continuation run; no timer is involved. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) {
    await Promise.resolve();
  }
}

/** A gate a fake write waits on, so a test decides when the write lands. */
function writeGate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

export async function setUpRig(idleTimeoutMs: number): Promise<Rig> {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence);
  const reaped: string[] = [];
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (sessionId, reason) => {
      reaped.push(reason);
      await manager.releaseSession(sessionId, reason);
    },
    timer,
  );
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDevicePool: () => DEVICE_POOL,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
  await manager.createSession(SESSION, DEVICE, "android", idleTimeoutMs);
  monitor.start();
  const advance = (ms: number) => timer.setCurrentTime(timer.getCurrentTime() + ms);
  return {
    timer,
    persistence,
    manager,
    monitor,
    reaped,
    request: (method, params) =>
      handleDaemonRequest({ id: method, type: "daemon_request", method, params }, state),
    advance,
    scanOnTime: async () => {
      advance(SCAN_MS);
      // A release whose row write is gated never settles inside this turn: do not wait on it.
      void monitor.tick().catch(() => undefined);
      await settle();
    },
    dispose: async () => {
      await monitor.stop();
      manager.stopCleanupTimer();
    },
  };
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.dispose();
  rig = undefined;
});

const heartbeat = (r: Rig, claimLivenessOwnership = false) =>
  r.request("daemon/heartbeat", {
    sessionId: SESSION,
    livenessOwnerToken: OWNER,
    ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
  });

/** Hold the release's terminal row write until the returned gate opens. */
function gateReleaseWrite(r: Rig): { open(): void } {
  const gate = writeGate();
  const write = r.persistence.markReleased.bind(r.persistence);
  r.persistence.markReleased = async (...args) => {
    await gate.wait;
    return await write(...args);
  };
  return gate;
}

async function toolCallRefusal(r: Rig): Promise<unknown> {
  return await r.manager.getOrCreateSession(SESSION).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("not-found answers for a session whose terminal release is still writing its row", () => {
  test("a published plan label without its own timer fence names its ended base's reason", async () => {
    rig = await setUpRig(120_000);
    const r = rig;
    const labelId = `${SESSION}:B`;
    await asPlanAllocation(r.manager, SESSION, [labelId], () =>
      r.manager.createSession(labelId, "emulator-5556", "android", 120_000),
    );
    r.manager.setDeviceLabels(SESSION, buildDeviceLabelMap(["A", "B"], SESSION));
    await r.manager.releaseSession(SESSION, "explicit-release");

    expect(r.manager.hasSession(SESSION)).toBe(false);
    expect(r.manager.hasSession(labelId)).toBe(true);
    expect(r.manager.getTerminalReleaseSnapshot(labelId)).toBeUndefined();
    expect(await r.manager.getReleasedSessionReason(labelId)).toBe("explicit-release");
  });

  test("a heartbeat-timeout release: heartbeat reply and session-info name the reason the tool call is refused with", async () => {
    rig = await setUpRig(120_000);
    const r = rig;
    expect((await heartbeat(r)).success).toBe(true);
    const gate = gateReleaseWrite(r);

    // The owner goes quiet: lease 4 s + grace 4 s, released by the scan at 10 s.
    for (let scan = 0; scan < 5; scan++) {
      await r.scanOnTime();
    }
    expect(r.reaped).toEqual(["heartbeat-timeout"]);

    // Premise: the tool-call wire already answers with the terminal reason.
    const refusal = await toolCallRefusal(r);
    expect(refusal).toBeInstanceOf(TerminalSessionError);
    expect((refusal as TerminalSessionError).release.releaseReason).toBe("heartbeat-timeout");

    const heartbeatReply = await heartbeat(r);
    const sessionInfo = await r.request("daemon/sessionInfo", { sessionId: SESSION });
    gate.open();
    await settle();

    expect(heartbeatReply).toMatchObject({ success: false, releaseReason: "heartbeat-timeout" });
    expect(sessionInfo).toMatchObject({ success: false, releaseReason: "heartbeat-timeout" });
  });

  test("an idle release: the heartbeat reply says the session idled out", async () => {
    rig = await setUpRig(6_000);
    const r = rig;
    expect((await heartbeat(r)).success).toBe(true);
    const gate = gateReleaseWrite(r);

    // The owner keeps heartbeating and makes no tool call: idle-released by the scan at 8 s.
    for (let scan = 0; scan < 4; scan++) {
      await r.scanOnTime();
      await heartbeat(r);
    }
    const refusal = await toolCallRefusal(r);
    expect(refusal).toBeInstanceOf(TerminalSessionError);
    expect((refusal as TerminalSessionError).release.releaseReason).toBe("cleanup-expired");

    const heartbeatReply = await heartbeat(r);
    gate.open();
    await settle();

    expect(heartbeatReply).toMatchObject({
      success: false,
      releaseReason: "cleanup-expired",
      idle: true,
    });
  });
});

describe("a release that is not a timer release, while it is still writing its row", () => {
  // An explicit release stays as test/daemon/releasingSessionPaths.test.ts pins it, and a device
  // loss may still be overruled by a newer observation: neither is named before it has finished.
  for (const reason of ["explicit-release", "device-killed"] as const) {
    test(`${reason}: heartbeat reply and session-info stay a plain not-found until it finishes`, async () => {
      rig = await setUpRig(120_000);
      const r = rig;
      expect((await heartbeat(r)).success).toBe(true);
      const gate = gateReleaseWrite(r);
      const release = r.manager.releaseSession(SESSION, reason);
      await settle();
      expect(r.manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason).toBe(reason);

      const bare = { success: false, error: `Session not found: ${SESSION}`, code: NOT_FOUND };
      expect(await heartbeat(r)).toEqual(bare);
      expect(await r.request("daemon/sessionInfo", { sessionId: SESSION })).toEqual(bare);

      gate.open();
      await release;
      expect(await heartbeat(r)).toEqual({ ...bare, releaseReason: reason });
    });
  }
});

describe("a claiming heartbeat whose ownership write yields across an idle release", () => {
  test("is answered with the release reason once the release has finished", async () => {
    rig = await setUpRig(3_000);
    const r = rig;
    const gate = writeGate();
    const write = r.persistence.recordLivenessOwnership.bind(r.persistence);
    r.persistence.recordLivenessOwnership = async (sessionUuid, ownerToken) => {
      await gate.wait;
      await write(sessionUuid, ownerToken);
    };

    // The claim arrives inside the 3 s idle window; its row write is still pending when the scan
    // 4 s after creation idle-releases the session.
    r.advance(2_000);
    const claim = heartbeat(r, true);
    await settle();
    await r.scanOnTime();
    // Premise: the release finished and is known by its reason.
    expect(await r.manager.getReleasedSessionReason(SESSION)).toBe("cleanup-expired");

    gate.open();

    expect(await claim).toMatchObject({
      success: false,
      releaseReason: "cleanup-expired",
      idle: true,
    });
  });
});
