import { describe, expect, test, spyOn } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import {
  installSessionManagerFixture,
  makeHierarchy,
  makeSessionManager,
  quietPersistence,
} from "../helpers/sessionManagerSuite";

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;

  installSessionManagerFixture((fixture) => {
    sessionManager = fixture.manager;
    fakeTimer = fixture.timer;
  });

  describe("cache management", () => {
    test("should update session cache data", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      const hierarchy = makeHierarchy("root");
      sessionManager.updateSessionCache("session-1", {
        lastHierarchy: hierarchy,
        lastObserveTime: 987654,
      });
      const cache = sessionManager.getSessionCache("session-1");
      expect(cache?.lastHierarchy).toEqual(hierarchy);
      expect(cache?.lastObserveTime).toBe(987654);
    });

    test("setLastHierarchy stores a ViewHierarchyResult in the typed top-level slot and stamps lastObserveTime (#2917)", async () => {
      fakeTimer.setCurrentTime(123456);
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      const hierarchy = makeHierarchy("root");

      sessionManager.setLastHierarchy("session-1", hierarchy);

      const session = sessionManager.getSession("session-1")!;
      // Canonical slot is the typed top-level field, NOT customData.
      expect(session.cacheData.lastHierarchy).toEqual(hierarchy);
      expect(session.cacheData.lastHierarchy?.hierarchy.node?.["view-id"]).toBe(
        "com.example:id/root",
      );
      expect(session.cacheData.lastObserveTime).toBe(123456);
      // The dormant-decoy key never leaks into an untyped bag — the `customData`
      // escape hatch no longer exists at all (#2917/#2973).
      expect((session.cacheData as Record<string, unknown>).customData).toBeUndefined();
    });

    test("setLastHierarchy on a missing session is a no-op (no throw)", () => {
      expect(() => sessionManager.setLastHierarchy("nope", makeHierarchy("x"))).not.toThrow();
      expect(sessionManager.getSession("nope")).toBeNull();
    });

    test("reading the session cache records no activity (#10703)", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.updateSessionCache("session-1", {
        deviceLabels: { A: "session-1" },
      });
      const session1 = sessionManager.getSession("session-1");
      const initialLastUsed = session1?.lastUsedAt ?? 0;
      fakeTimer.advanceTime(10);
      const cache = sessionManager.getSessionCache("session-1");
      const session2 = sessionManager.getSession("session-1");
      expect(cache?.deviceLabels).toEqual({ A: "session-1" });
      expect(session2?.lastUsedAt ?? 0).toBe(initialLastUsed);
    });

    test("cache writes from non-tool paths never move the owner's activity or liveness clocks (#10703)", async () => {
      const persistence = new FakeDeviceSessionPersistence();
      sessionManager.stopCleanupTimer();
      sessionManager = makeSessionManager({ timer: fakeTimer, persistence });
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      const session = sessionManager.getSession("session-1")!;
      const activityWrite = spyOn(persistence, "recordActivity");
      const clocks = () => ({
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
        lastHeartbeat: session.lastHeartbeat,
      });
      const before = clocks();
      fakeTimer.advanceTime(30_000);

      // A device incarnation change, an observe by device id from another client losing
      // accessibility, and the observe cache write itself: none is the owner using the device.
      sessionManager.resetDeviceReadinessForDevice("emulator-5554");
      sessionManager.invalidateAutomationReadinessForDevice("emulator-5554", "a11y lost");
      sessionManager.setLastHierarchy("session-1", makeHierarchy("root"));
      sessionManager.updateSessionCache("session-1", { lastObserveTime: fakeTimer.now() });

      expect(session.cacheData.deviceReadiness).toBe("booted");
      expect(session.cacheData.lastObserveTime).toBe(fakeTimer.now());
      expect(clocks()).toEqual(before);
      expect(activityWrite).not.toHaveBeenCalled();
    });

    test("should clear specific cache key", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.updateSessionCache("session-1", {
        lastHierarchy: makeHierarchy("root"),
        lastObserveTime: 987654,
      });
      sessionManager.clearSessionCache("session-1", "lastHierarchy");
      const cache = sessionManager.getSessionCache("session-1");
      expect(cache?.lastHierarchy).toBeUndefined();
      expect(cache?.lastObserveTime).toBe(987654);
    });

    test("should clear all cache when no key specified", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.updateSessionCache("session-1", {
        lastHierarchy: makeHierarchy("root"),
        lastObserveTime: 987654,
        deviceLabels: { A: "session-1" },
      });
      sessionManager.clearSessionCache("session-1");
      const cache = sessionManager.getSessionCache("session-1");
      expect(cache).toEqual({});
    });
  });

  describe("getSessionForDevice", () => {
    test("should return session id for assigned device", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBe("session-1");
    });

    test("should return null for unknown device", () => {
      expect(sessionManager.getSessionForDevice("emulator-9999")).toBeNull();
    });

    test("should return null after session is released", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      await sessionManager.releaseSession("session-1");
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBeNull();
    });
  });

  describe("statistics", () => {
    test("should return correct session statistics", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      await sessionManager.createSession("session-2", "emulator-5556", "android");
      const stats = sessionManager.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toBe(2);
      expect(stats.expiredSessions).toBe(0);
      expect(stats.assignedDevices).toBe(2);
    });
  });

  // Side-effect-free diff-baseline reader (issue #3053 part 3). The
  // `--actions-diff-observe` baseline store did get (getSessionCache →
  // recordSessionActivity) + set (updateSessionCache → recordSessionActivity)
  // = two fire-and-forget activity UPDATEs per diffed action. A dedicated
  // read-only reader halves that: the read must NOT record activity.
  describe("compact action metadata session cache", () => {
    test("cache is session/device scoped and clears on session release", async () => {
      await sessionManager.createSession("compact-s1", "phone-a", "android");
      await sessionManager.createSession("compact-s2", "phone-b", "android");
      const blocks = { systemInsets: { top: 24, bottom: 0, left: 0, right: 0 } };
      sessionManager.setLastActionMetadata("compact-s1", "phone-a", blocks);
      expect(sessionManager.getLastActionMetadata("compact-s1", "phone-a")).toEqual(blocks);
      expect(sessionManager.getLastActionMetadata("compact-s2", "phone-a")).toBeUndefined();
      expect(sessionManager.getLastActionMetadata("compact-s1", "phone-b")).toBeUndefined();
      sessionManager.setLastActionMetadata("compact-s1", "phone-b", {});
      expect(sessionManager.getLastActionMetadata("compact-s1", "phone-a")).toBeUndefined();
      await sessionManager.releaseSession("compact-s1");
      expect(sessionManager.getLastActionMetadata("compact-s1", "phone-b")).toBeUndefined();
    });
    test("metadata reader records no activity", async () => {
      const repo = new FakeDeviceSessionPersistence();
      const manager = makeSessionManager({ timer: fakeTimer, persistence: repo });

      await manager.createSession("compact-s1", "phone-a", "android");
      manager.setLastActionMetadata("compact-s1", "phone-a", { freshness: { verified: true } });
      const activity = spyOn(repo, "recordActivity");
      manager.getLastActionMetadata("compact-s1", "phone-a");
      expect(activity).not.toHaveBeenCalled();
      activity.mockRestore();
    });
  });

  describe("getLastRenderedObservation (issue #3053)", () => {
    function makeObservation(id: string): any {
      return {
        updatedAt: 1,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { packageName: "com.example", hierarchy: { node: { "resource-id": id } } },
      };
    }

    // Minimal repo double capturing the fire-and-forget activity writes.
    function makeRepo(): { repo: any; activity: string[] } {
      const activity: string[] = [];
      const repo = quietPersistence({
        async recordActivity(sessionId: string): Promise<void> {
          activity.push(sessionId);
        },
      });
      return { repo, activity };
    }

    test("EC3.1: returns the observation stored via setLastRenderedObservation", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android");
      const obs = makeObservation("root");
      sessionManager.setLastRenderedObservation("s1", obs, 3);

      expect(sessionManager.getLastRenderedObservation("s1")).toEqual(obs);
      expect(sessionManager.getLastRenderedDisplayRevision("s1")).toBe(3);
      sessionManager.clearSessionCache("s1", "lastRenderedObservation");
      expect(sessionManager.getLastRenderedDisplayRevision("s1")).toBe(3);
    });

    test("EC3.2: the read records NO session activity", async () => {
      const { repo, activity } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = makeSessionManager({
        timer: fakeTimer,
        persistence: repo,
        barrier: () => barrier,
      });

      await mgr.createSession("s1", "emulator-5554", "android");
      mgr.setLastRenderedObservation("s1", makeObservation("root"));
      await Promise.resolve();
      const activityAfterSet = activity.length;

      // The side-effect-free reader must not append any activity write.
      mgr.getLastRenderedObservation("s1");
      await Promise.resolve();
      expect(activity.length).toBe(activityAfterSet);

      // getSessionCache is a plain read too (#10703).
      mgr.getSessionCache("s1");
      await Promise.resolve();
      expect(activity.length).toBe(activityAfterSet);
    });

    test("EC3.2: a full baseline-store cycle (read + write) records no activity", async () => {
      // The #3053 defect: the diff baseline did get (→recordActivity) +
      // set (→recordActivity) = TWO activity UPDATEs per diffed action. Both are now
      // cache-only (#10703): the action's own tool call records its activity once, where it
      // is admitted and where it ends, so the baseline store adds no write at all.
      const { repo, activity } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = makeSessionManager({
        timer: fakeTimer,
        persistence: repo,
        barrier: () => barrier,
      });

      await mgr.createSession("s1", "emulator-5554", "android");
      await Promise.resolve();
      const before = activity.length;

      // Model one diffed action: read the baseline, then update it.
      mgr.getLastRenderedObservation("s1");
      mgr.setLastRenderedObservation("s1", makeObservation("root"));
      await Promise.resolve();

      expect(activity.length).toBe(before);
    });

    test("EC3.3: returns undefined for an unknown session without throwing", () => {
      expect(sessionManager.getLastRenderedObservation("missing")).toBeUndefined();
    });

    test("EC3.3: returns undefined when no observation was ever stored", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android");
      expect(sessionManager.getLastRenderedObservation("s1")).toBeUndefined();
    });
  });

  describe("setDeviceReadiness (#6227 round 7)", () => {
    test("records a level when none is recorded yet", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.setDeviceReadiness("session-1", "booted");
      expect(sessionManager.getDeviceReadiness("session-1")).toBe("booted");
    });

    test("raises the recorded level from booted to automationReady", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.setDeviceReadiness("session-1", "booted");
      sessionManager.setDeviceReadiness("session-1", "automationReady");
      expect(sessionManager.getDeviceReadiness("session-1")).toBe("automationReady");
    });

    test("does NOT downgrade automationReady to booted (monotonic)", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.setDeviceReadiness("session-1", "automationReady");
      sessionManager.setDeviceReadiness("session-1", "booted");
      expect(sessionManager.getDeviceReadiness("session-1")).toBe("automationReady");
    });

    test("re-recording the same level is a no-op", async () => {
      await sessionManager.createSession("session-1", "emulator-5554", "android");
      sessionManager.setDeviceReadiness("session-1", "automationReady");
      sessionManager.setDeviceReadiness("session-1", "automationReady");
      expect(sessionManager.getDeviceReadiness("session-1")).toBe("automationReady");
    });
  });
});
