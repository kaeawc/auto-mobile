import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  SessionManager,
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
} from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  DeferredDeviceSessionPersistence,
  DeferredReleaseDeviceSessionPersistence,
  makeSessionManager,
} from "../helpers/sessionManagerSuite";

describe("SessionManager.waitForSessionReleaseWithin", () => {
  let timer: FakeTimer;
  let persistence: DeferredReleaseDeviceSessionPersistence;
  let manager: SessionManager;

  beforeEach(() => {
    timer = new FakeTimer();
    persistence = new DeferredReleaseDeviceSessionPersistence();
    manager = makeSessionManager({ timer, persistence, fakeBarrier: true });
  });

  afterEach(() => {
    persistence.finishRelease.resolve();
    manager.stopCleanupTimer();
  });

  test("returns true without a deadline when this UUID has no release", async () => {
    await expect(manager.waitForSessionReleaseWithin("unknown", 5000)).resolves.toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("waits for only this UUID's in-flight release and clears its deadline after settling", async () => {
    await manager.createSession("releasing", "device-a", "android");
    const release = manager.releaseSession("releasing", "explicit-release");
    await persistence.releaseStarted.promise;
    let settled = false;
    try {
      const wait = manager.waitForSessionReleaseWithin("releasing", 5000).then((result) => {
        settled = true;
        return result;
      });
      await expect(manager.waitForSessionReleaseWithin("unrelated", 5000)).resolves.toBe(true);
      expect(settled).toBe(false);
      // The release's own write deadline (#10836) is pending alongside the wait's.
      expect(timer.getPendingTimeouts()).toEqual([SESSION_RELEASE_PERSIST_TIMEOUT_MS, 5000]);
      persistence.finishRelease.resolve();
      await release;
      await expect(wait).resolves.toBe(true);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      persistence.finishRelease.resolve();
      await release;
    }
  });

  test("returns false at the bound and clears the deadline without cancelling release", async () => {
    await manager.createSession("releasing", "device-a", "android");
    const release = manager.releaseSession("releasing", "explicit-release");
    await persistence.releaseStarted.promise;
    try {
      let settled = false;
      const wait = manager.waitForSessionReleaseWithin("releasing", 5000).then((result) => {
        settled = true;
        return result;
      });
      timer.advanceTime(4999);
      await Promise.resolve();
      expect(settled).toBe(false);
      timer.advanceTime(1);
      await expect(wait).resolves.toBe(false);
      // Only the still-running release's own write deadline (#10836) remains.
      expect(timer.getPendingTimeouts()).toEqual([SESSION_RELEASE_PERSIST_TIMEOUT_MS]);
    } finally {
      persistence.finishRelease.resolve();
      await expect(release).resolves.toBe("device-a");
    }
  });

  test("returns true when the release rejects", async () => {
    await manager.createSession("releasing", "device-a", "android");
    const release = manager.releaseSession("releasing", "device-restart:device-a");
    const releaseError = release.then(
      () => null,
      (error: unknown) => error,
    );
    await persistence.releaseStarted.promise;
    try {
      const wait = manager.waitForSessionReleaseWithin("releasing", 5000);
      persistence.finishRelease.reject(new Error("release write failed"));
      expect(await releaseError).toBeInstanceOf(Error);
      await expect(wait).resolves.toBe(true);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      persistence.finishRelease.reject(new Error("release write failed"));
      await releaseError;
    }
  });

  test("waits for a release admitted while session creation is pending", async () => {
    const deferredCreation = new DeferredDeviceSessionPersistence();
    manager.stopCleanupTimer();
    manager = makeSessionManager({ timer, persistence: deferredCreation, fakeBarrier: true });
    deferredCreation.deferNextUpsert();
    const creation = manager.createSession("pending", "device-a", "android");
    await deferredCreation.waitForUpsert();
    const release = manager.releaseSession("pending", "explicit-release");
    try {
      let settled = false;
      const wait = manager.waitForSessionReleaseWithin("pending", 5000).then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      deferredCreation.finishUpsert();
      await creation;
      await release;
      await expect(wait).resolves.toBe(true);
      expect(manager.getSession("pending")).toBeNull();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      deferredCreation.finishUpsert();
      await creation;
      await release;
    }
  });
});
