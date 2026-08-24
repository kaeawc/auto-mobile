import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  SessionManager,
  type DeviceLabelMap,
  type KeepScreenAwakeRestorer,
} from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import type { KeepScreenAwakeState } from "../../src/utils/KeepScreenAwakeManager";

/**
 * Capturing fake restorer: records every state handed to `restore`, so a test can
 * assert the reader (`restoreKeepScreenAwake`) read the typed slot's FULL payload —
 * not just its `.applied` flag — and passed it through on session release.
 */
class SpyKeepScreenAwakeRestorer implements KeepScreenAwakeRestorer {
  readonly restored: KeepScreenAwakeState[] = [];
  async restore(state: KeepScreenAwakeState): Promise<void> {
    this.restored.push(state);
  }
}

/**
 * Typed `SessionCacheData` slots for the well-known keys that used to live in the
 * untyped `customData?: Record<string, any>` bag (issue #2973, follow-up to #2917).
 *
 * `keepScreenAwake` (KeepScreenAwakeState) and `deviceLabels` (a label→session map)
 * are fixed-type keyed state; promoting them to typed top-level slots with
 * dedicated set/get helpers removes the unchecked `as` casts that let a
 * writer/reader type drift slip past the compiler — the exact #2917 bug class.
 */
describe("SessionCacheData typed slots (issue #2973)", () => {
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;

  // Minimal repo double capturing the fire-and-forget activity writes so the
  // default file-backed DeviceSessionRepository is never resolved (unit guard).
  function makeRepo(): { repo: any; activity: string[] } {
    const activity: string[] = [];
    const repo = {
      async upsertActiveSession(): Promise<void> {},
      async recordActivity(sessionId: string): Promise<void> {
        activity.push(sessionId);
      },
      async markReleased(): Promise<void> {},
      async markStaleActiveSessionsExpired(): Promise<void> {},
    };
    return { repo, activity };
  }

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  describe("keepScreenAwake slot", () => {
    const state: KeepScreenAwakeState = {
      applied: true,
      method: "settings",
      appliedSettings: { stayOnWhilePluggedIn: true, screenOffTimeout: true },
    };

    test("EC3: set/getKeepScreenAwake round-trips the typed state", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android");
      sessionManager.setKeepScreenAwake("s1", state);

      expect(sessionManager.getKeepScreenAwake("s1")).toEqual(state);
    });

    test("EC1: the state is stored in the typed top-level slot, not customData", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android");
      sessionManager.setKeepScreenAwake("s1", state);

      const cache = sessionManager.getSessionCache("s1")!;
      expect(cache.keepScreenAwake).toEqual(state);
      expect((cache as Record<string, unknown>).customData).toBeUndefined();
    });

    test("getKeepScreenAwake returns undefined for an unknown session", () => {
      expect(sessionManager.getKeepScreenAwake("missing")).toBeUndefined();
    });

    test("getKeepScreenAwake returns undefined before any state is set", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android");
      expect(sessionManager.getKeepScreenAwake("s1")).toBeUndefined();
    });

    test("EC4: getKeepScreenAwake records NO session activity, unlike getSessionCache", async () => {
      const { repo, activity } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = new SessionManager(fakeTimer, repo, () => barrier);
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        mgr.setKeepScreenAwake("s1", state);
        await Promise.resolve();
        const activityAfterSet = activity.length;

        mgr.getKeepScreenAwake("s1");
        await Promise.resolve();
        expect(activity.length).toBe(activityAfterSet);

        // Contrast: getSessionCache DOES record activity (the behavior we avoid).
        mgr.getSessionCache("s1");
        await Promise.resolve();
        expect(activity.length).toBe(activityAfterSet + 1);
      } finally {
        mgr.stopCleanupTimer();
      }
    });

    test("EC5: releaseSession passes the FULL typed-slot payload to restore (writer/reader round trip)", async () => {
      // The #2917 bug class is writer/reader drift. This proves the reader
      // (restoreKeepScreenAwake) reads the whole typed payload from the slot the
      // setter wrote — not just `.applied` — and hands it to the restorer, with no
      // real device. Injected restorer stands in for KeepScreenAwakeManager.
      const { repo } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const spy = new SpyKeepScreenAwakeRestorer();
      const mgr = new SessionManager(
        fakeTimer,
        repo,
        () => barrier,
        () => spy,
      );
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        const applied: KeepScreenAwakeState = {
          applied: true,
          method: "settings",
          originalScreenOffTimeout: "60000",
          appliedSettings: { stayOnWhilePluggedIn: true, screenOffTimeout: true },
        };
        mgr.setKeepScreenAwake("s1", applied);

        const deviceId = await mgr.releaseSession("s1");
        expect(deviceId).toBe("emulator-5554");
        // Exact object read back from the slot and forwarded to restore.
        expect(spy.restored).toEqual([applied]);
      } finally {
        mgr.stopCleanupTimer();
      }
    });

    test("EC5: releaseSession does NOT restore when the slot's state is applied:false", async () => {
      const { repo } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const spy = new SpyKeepScreenAwakeRestorer();
      const mgr = new SessionManager(
        fakeTimer,
        repo,
        () => barrier,
        () => spy,
      );
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        mgr.setKeepScreenAwake("s1", { applied: false, skipReason: "disabled" });

        await mgr.releaseSession("s1");
        expect(spy.restored).toEqual([]);
      } finally {
        mgr.stopCleanupTimer();
      }
    });

    test("EC5: releaseSession does NOT restore when no keep-awake state was set", async () => {
      const { repo } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const spy = new SpyKeepScreenAwakeRestorer();
      const mgr = new SessionManager(
        fakeTimer,
        repo,
        () => barrier,
        () => spy,
      );
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        await mgr.releaseSession("s1");
        expect(spy.restored).toEqual([]);
      } finally {
        mgr.stopCleanupTimer();
      }
    });
  });

  describe("deviceLabels slot", () => {
    const labels: DeviceLabelMap = { A: "s1", B: "s1:B" };

    test("EC3: set/getDeviceLabels round-trips the typed map", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android");
      sessionManager.setDeviceLabels("s1", labels);

      expect(sessionManager.getDeviceLabels("s1")).toEqual(labels);
    });

    test("EC1: the map is stored in the typed top-level slot, not customData", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android");
      sessionManager.setDeviceLabels("s1", labels);

      const cache = sessionManager.getSessionCache("s1")!;
      expect(cache.deviceLabels).toEqual(labels);
      expect((cache as Record<string, unknown>).customData).toBeUndefined();
    });

    test("getDeviceLabels returns undefined for an unknown session", () => {
      expect(sessionManager.getDeviceLabels("missing")).toBeUndefined();
    });

    test("EC4: getDeviceLabels records NO session activity, unlike getSessionCache", async () => {
      const { repo, activity } = makeRepo();
      const barrier = new FakeDbWriteBarrier();
      const mgr = new SessionManager(fakeTimer, repo, () => barrier);
      try {
        await mgr.createSession("s1", "emulator-5554", "android");
        mgr.setDeviceLabels("s1", labels);
        await Promise.resolve();
        const activityAfterSet = activity.length;

        mgr.getDeviceLabels("s1");
        await Promise.resolve();
        expect(activity.length).toBe(activityAfterSet);
      } finally {
        mgr.stopCleanupTimer();
      }
    });
  });

  test("the two typed slots are independent (no shared bag to clobber)", async () => {
    await sessionManager.createSession("s1", "emulator-5554", "android");
    sessionManager.setKeepScreenAwake("s1", { applied: false, skipReason: "disabled" });
    sessionManager.setDeviceLabels("s1", { A: "s1" });

    expect(sessionManager.getKeepScreenAwake("s1")).toEqual({
      applied: false,
      skipReason: "disabled",
    });
    expect(sessionManager.getDeviceLabels("s1")).toEqual({ A: "s1" });
  });
});
