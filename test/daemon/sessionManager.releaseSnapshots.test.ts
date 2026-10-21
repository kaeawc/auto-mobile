import { expect, test } from "bun:test";
import {
  PLAN_AUTO_RELEASE_REASON,
  type SessionReleaseSnapshot,
} from "../../src/daemon/sessionManager";
import type { SessionRowWriter } from "../../src/daemon/sessionRowWriter";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { installSessionManagerCleanup, makeSessionManager } from "../helpers/sessionManagerSuite";

installSessionManagerCleanup();

test("resetDeviceReadinessForDevice drops restored automation readiness", async () => {
  const manager = makeSessionManager();
  await manager.createSession("restore-session", "emulator-5554", "android");
  manager.setDeviceReadiness("restore-session", "automationReady");

  manager.resetDeviceReadinessForDevice("emulator-5554");

  expect(manager.getDeviceReadiness("restore-session")).toBe("booted");
});

test("device ownership listeners observe assignment, rebind, release, and removal", async () => {
  const manager = makeSessionManager();
  const changed: string[] = [];
  const unsubscribe = manager.onDeviceOwnershipChange((deviceId) => changed.push(deviceId));
  await manager.createSession("owner", "emulator-5554", "android");
  expect(changed).toEqual(["emulator-5554"]);
  await manager.rebindSession("owner", "emulator-5556", "android");
  expect(changed).toEqual(["emulator-5554", "emulator-5554", "emulator-5556"]);
  await manager.releaseSession("owner", "explicit-release");
  expect(changed.at(-1)).toBe("emulator-5556");
  unsubscribe();
  await manager.createSession("next", "emulator-5554", "android");
  expect(changed).toHaveLength(4);
});

test("release notifies ownership listeners after removing the session", async () => {
  const manager = makeSessionManager();
  await manager.createSession("owner", "emulator-5554", "android");
  const observed: Array<{ session: unknown; owner: string | null }> = [];
  manager.onDeviceOwnershipChange((deviceId) => {
    observed.push({
      session: manager.getSession("owner"),
      owner: manager.getSessionForDevice(deviceId),
    });
  });

  await manager.releaseSession("owner", "explicit-release");

  expect(observed).toEqual([{ session: null, owner: null }]);
  manager.stopCleanupTimer();
});

test("invalidateAutomationReadiness downgrades a session and ignores unknown ids", async () => {
  const manager = makeSessionManager();
  await manager.createSession("lost-service", "emulator-5554", "android");
  manager.setDeviceReadiness("lost-service", "automationReady");

  manager.invalidateAutomationReadiness("lost-service", "test");

  expect(manager.getDeviceReadiness("lost-service")).toBe("booted");
  expect(() => manager.invalidateAutomationReadiness("unknown-session", "test")).not.toThrow();
  expect(manager.getDeviceReadiness("unknown-session")).toBeUndefined();
  manager.stopCleanupTimer();
});

test("invalidateAutomationReadinessForDevice downgrades only the owning session", async () => {
  const manager = makeSessionManager();

  await manager.createSession("owner", "emulator-5554", "android");
  await manager.createSession("other", "emulator-5556", "android");
  manager.setDeviceReadiness("owner", "automationReady");
  manager.setDeviceReadiness("other", "automationReady");

  manager.invalidateAutomationReadinessForDevice("emulator-5554", "CtrlProxy lost");

  expect(manager.getDeviceReadiness("owner")).toBe("booted");
  expect(manager.getDeviceReadiness("other")).toBe("automationReady");
  expect(() => manager.invalidateAutomationReadinessForDevice("missing", "lost")).not.toThrow();
});

test("retries a failed non-terminal release after removing the in-memory session", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = makeSessionManager({ timer, persistence });

  await manager.createSession("restart-session", "emulator-5554", "android");
  persistence.failure = "release";
  await expect(manager.releaseSession("restart-session", "device-restart:Pixel_8")).rejects.toThrow(
    "Failed to persist non-terminal release",
  );
  expect(manager.getSession("restart-session")).toBeNull();
  expect((await persistence.getSession("restart-session"))?.status).toBe("active");

  persistence.failure = null;
  await expect(manager.releaseSession("restart-session", "device-restart:Pixel_8")).resolves.toBe(
    "emulator-5554",
  );
  expect(await persistence.getSession("restart-session")).toMatchObject({
    status: "released",
    release_reason: "device-restart:Pixel_8",
    released_at_ms: expect.any(Number),
  });
});

test("explicit release fails closed when persistence fails and retains the terminal snapshot", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const manager = makeSessionManager({ persistence });

  await manager.createSession("explicit-session", "emulator-5554", "android");
  persistence.failure = "release";

  await expect(manager.releaseSession("explicit-session", "explicit-release")).rejects.toThrow(
    "Failed to persist terminal release",
  );
  expect(manager.getTerminalReleaseSnapshot("explicit-session")).toMatchObject({
    sessionId: "explicit-session",
    deviceId: "emulator-5554",
    releaseReason: "explicit-release",
    terminal: true,
  });
  expect((await persistence.getSession("explicit-session"))?.status).toBe("active");
});

test("a same-UUID resume discards a failed non-terminal release snapshot", async () => {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = makeSessionManager({ timer, persistence });

  const original = await manager.createSession("reused-session", "emulator-old", "android");
  persistence.failure = "release";
  await expect(manager.releaseSession("reused-session", "allocation-rollback")).resolves.toBe(
    "emulator-old",
  );
  const writer = Reflect.get(manager, "rowWriter") as SessionRowWriter;
  const pending = writer.pendingNonTerminalReleases();
  const staleSnapshot = pending.get("reused-session")!;
  persistence.failure = null;
  const resumed = await manager.createSession("reused-session", "emulator-new", "android");
  expect(resumed.assignedDevice).toBe("emulator-new");
  expect(pending.has("reused-session")).toBe(false);

  // Exercise the retry write's last synchronous fence with the captured stale snapshot.
  const retryWrite = Reflect.get(manager, "persistSessionRelease") as (
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean,
  ) => Promise<boolean>;
  expect(await retryWrite.call(manager, staleSnapshot, true)).toBe(false);
  // The public ownership fence also declines a late retry from the old incarnation.
  await expect(
    manager.releaseSession("reused-session", "allocation-rollback", {
      expectedOwner: { session: original, deviceId: "emulator-old" },
    }),
  ).resolves.toBeNull();
  expect(await persistence.getSession("reused-session")).toMatchObject({
    device_id: "emulator-new",
    status: "active",
    release_reason: null,
    released_at_ms: null,
  });
  expect(manager.getSession("reused-session")).toBe(resumed);
});

test("a retry during an unpublished same-UUID resume leaves the new row active", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const manager = makeSessionManager({ persistence });
  const upsertStarted = Promise.withResolvers<void>();
  const finishUpsert = Promise.withResolvers<void>();
  const upsert = persistence.upsertActiveSession.bind(persistence);
  try {
    await manager.createSession("racing-session", "emulator-old", "android");
    persistence.failure = "release";
    await expect(manager.releaseSession("racing-session", "allocation-rollback")).resolves.toBe(
      "emulator-old",
    );
    const writer = Reflect.get(manager, "rowWriter") as SessionRowWriter;
    const pending = writer.pendingNonTerminalReleases();
    expect(pending.has("racing-session")).toBe(true);

    persistence.failure = null;
    persistence.upsertActiveSession = async (record, nowMs, options) => {
      const version = await upsert(record, nowMs, options);
      upsertStarted.resolve();
      await finishUpsert.promise;
      return version;
    };
    const resume = manager.createSession("racing-session", "emulator-new", "android");
    await upsertStarted.promise;
    expect(Reflect.get(manager, "sessionSlots").creations.has("racing-session")).toBe(true);
    expect(manager.getSession("racing-session")).toBeNull();
    expect(await persistence.getSession("racing-session")).toMatchObject({
      device_id: "emulator-new",
      status: "active",
    });

    await expect(
      manager.releaseSession("racing-session", "allocation-rollback"),
    ).resolves.toBeNull();
    // Still pending while the resume is in flight (#11557): a resume that failed would leave the
    // row to this release. Publishing ends it.
    expect(pending.has("racing-session")).toBe(true);
    expect((await persistence.getSession("racing-session"))?.status).toBe("active");
    finishUpsert.resolve();
    await expect(resume).resolves.toMatchObject({ assignedDevice: "emulator-new" });
    expect(pending.has("racing-session")).toBe(false);
    expect(await persistence.getSession("racing-session")).toMatchObject({
      status: "active",
      release_reason: null,
    });
  } finally {
    finishUpsert.resolve();
    manager.stopCleanupTimer();
  }
});

test("pending non-terminal releases evict the oldest snapshot at 256 entries", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const manager = makeSessionManager({ persistence });

  await manager.createSession("bounded-0", "emulator-5554", "android");
  persistence.failure = "release";
  await manager.releaseSession("bounded-0", PLAN_AUTO_RELEASE_REASON);
  const writer = Reflect.get(manager, "rowWriter") as SessionRowWriter;
  const pending = writer.pendingNonTerminalReleases();
  const initial = pending.get("bounded-0")!;
  const writeRelease = Reflect.get(manager, "persistSessionRelease") as (
    snapshot: SessionReleaseSnapshot,
  ) => Promise<boolean>;
  for (let index = 1; index <= 256; index++) {
    await expect(
      writeRelease.call(manager, { ...initial, sessionId: `bounded-${index}` }),
    ).resolves.toBe(false);
  }
  expect(pending.size).toBe(256);
  expect(pending.has("bounded-0")).toBe(false);
  expect(pending.has("bounded-1")).toBe(true);
  expect(pending.has("bounded-256")).toBe(true);
});

test("shutdown hooks clear pending non-terminal release snapshots", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const manager = makeSessionManager({ persistence });
  await manager.createSession("drain-session", "emulator-5554", "android");
  persistence.failure = "release";
  await manager.releaseSession("drain-session", PLAN_AUTO_RELEASE_REASON);
  const writer = Reflect.get(manager, "rowWriter") as SessionRowWriter;
  const pending = writer.pendingNonTerminalReleases();
  expect(pending.size).toBe(1);
  await expect(manager.drainReleasePromises(10)).resolves.toBe(true);
  expect(pending.size).toBe(0);

  await manager.createSession("stop-session", "emulator-5556", "android");
  await manager.releaseSession("stop-session", PLAN_AUTO_RELEASE_REASON);
  expect(pending.size).toBe(1);
  manager.stopCleanupTimer();
  expect(pending.size).toBe(0);
});
