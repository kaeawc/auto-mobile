import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Session, SessionManager } from "../../src/daemon/sessionManager";
import { slotAgreementRig } from "../helpers/sessionSlotAgreementHarness";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

let rig: ReturnType<typeof slotAgreementRig>;
let session: Session;
let slots: SessionManager["sessionSlots"];
let releaseSpy: ReturnType<typeof spyOn<typeof rig.manager, "releaseSession">>;
let hold: ReturnType<typeof Promise.withResolvers<"teardown">>;
let cancellations: number;

beforeEach(async () => {
  rig = slotAgreementRig();
  slots = Reflect.get(rig.manager, "sessionSlots") as SessionManager["sessionSlots"];
  session = await rig.manager.createSession("find-id", "fake-device", "android", 1000);
  hold = Promise.withResolvers<"teardown">();
  rig.manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: 1000 }));
  cancellations = 0;
  rig.manager.setExpiryReleaseExecutionCanceller(() => {
    cancellations++;
  });
  releaseSpy = spyOn(rig.manager, "releaseSession");
});

afterEach(async () => {
  hold.resolve("teardown");
  await rig.manager.waitForSessionRelease(session.sessionId);
  releaseSpy.mockRestore();
  rig.timer.reset();
});

function expectNoRelease(): void {
  expect(releaseSpy).not.toHaveBeenCalled();
  expect(slots.releaseOps.size).toBe(0);
  expect(slots.activeReleases.size).toBe(0);
  expect(rig.manager.getIdleReleasesInProgress()).toEqual([]);
  expect(rig.manager.isReleaseInProgress(session.sessionId, rig.timer.now())).toBe(false);
  expect(cancellations).toBe(0);
  expect(rig.timer.getSleepHistory()).toEqual([]);
}

test("find returns the live identity, including at its deadline, and null for a missing id", () => {
  expect(rig.manager.findSession(session.sessionId)).toBe(session);
  expect(rig.manager.findSession("missing")).toBeNull();
  rig.timer.advanceTime(1000);
  expect(rig.manager.findSession(session.sessionId)).toBe(session);
  expectNoRelease();
});

test("find hides an expired session without scheduling release or changing its state", async () => {
  rig.timer.advanceTime(1001);
  const before = { ...session, cacheData: { ...session.cacheData } };
  const timeouts = rig.timer.getPendingTimeouts();
  expect(rig.manager.findSession(session.sessionId)).toBeNull();
  await drainMicrotasks(20);
  expect(rig.manager.findSession(session.sessionId)).toBeNull();
  expect(rig.manager.getLegacyLifecycleView().sessions.get(session.sessionId)).toBe(session);
  expect(session).toEqual(before);
  expect(rig.timer.getPendingTimeouts()).toEqual(timeouts);
  expectNoRelease();
});

test("getSession expires the same session synchronously and starts exactly one lazy release", () => {
  rig.timer.advanceTime(1001);
  expect(rig.manager.findSession(session.sessionId)).toBeNull();
  expectNoRelease();
  expect(rig.manager.getSession(session.sessionId)).toBeNull();
  expect(releaseSpy).toHaveBeenCalledWith(session.sessionId, "cleanup-expired", {
    allowExpired: true,
    expiryOrigin: "lazy-expiry",
  });
  expect(slots.releaseOps.get(session.sessionId)?.session).toBe(session);
  expect(slots.activeReleases.size).toBe(1);
  expect(rig.manager.isReleaseInProgress(session.sessionId, rig.timer.now())).toBe(true);
  expect(rig.manager.getSession(session.sessionId)).toBeNull();
  expect(releaseSpy).toHaveBeenCalledTimes(1);
});

function fenceSession(): void {
  slots.setTerminalSnapshot(session.sessionId, {
    sessionId: session.sessionId,
    deviceId: session.assignedDevice,
    releaseReason: "explicit-release",
    releasedAtMs: rig.timer.now(),
    terminal: true,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 1000, ageMs: 0 },
  });
}

test("find hides a terminal-fenced live identity without releasing it", () => {
  fenceSession();
  expect(rig.manager.findSession(session.sessionId)).toBeNull();
  expectNoRelease();
});

test("cache reads hide expired data without releasing, while ownership admission still expires", () => {
  rig.manager.setDeviceReadiness(session.sessionId, "automationReady");
  expect(rig.manager.getDeviceReadiness(session.sessionId)).toBe("automationReady");
  rig.timer.advanceTime(1001);
  const timeouts = rig.timer.getPendingTimeouts();
  expect(rig.manager.getClock(session.sessionId)).toBeUndefined();
  expect(rig.manager.getRotation(session.sessionId)).toBeUndefined();
  expect(rig.manager.getDeviceReadiness(session.sessionId)).toBeUndefined();
  expect(rig.manager.getSessionCache(session.sessionId)).toBeNull();
  expect(rig.timer.getPendingTimeouts()).toEqual(timeouts);
  expectNoRelease();
  expect(rig.manager.hasLivenessOwnership(session.sessionId, "owner")).toBe(false);
  expect(releaseSpy).toHaveBeenCalledTimes(1);
  expect(rig.manager.isReleaseInProgress(session.sessionId, rig.timer.now())).toBe(true);
});

test("find keeps the default active-control execution veto", () => {
  rig.manager.setActiveSessionExecutionChecker((_id, query) => query?.excludeReads === true);
  rig.timer.advanceTime(1001);
  expect(rig.manager.findSession(session.sessionId)).toBe(session);
  expect(rig.manager.getSession(session.sessionId)).toBe(session);
  expectNoRelease();
});

test.each(["live", "expired", "missing", "fenced"])(
  "find invokes the stall probe once before judging a %s session",
  (state) => {
    let probes = 0;
    rig.manager.setStallProbe(() => {
      probes++;
    });
    if (state === "expired") {
      rig.timer.advanceTime(1001);
    }
    if (state === "fenced") {
      fenceSession();
    }
    rig.manager.findSession(state === "missing" ? "missing" : session.sessionId);
    expect(probes).toBe(1);
    expectNoRelease();
  },
);

test("retained ownership lookup still dispatches an instance getSession patch", () => {
  const getSession = spyOn(rig.manager, "getSession").mockReturnValue(null);
  try {
    expect(rig.manager.hasLivenessOwnership(session.sessionId, "owner")).toBe(false);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(session.sessionId);
  } finally {
    getSession.mockRestore();
  }
});
