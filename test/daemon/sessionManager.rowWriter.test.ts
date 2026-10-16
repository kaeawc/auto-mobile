import { expect, test } from "bun:test";
import { SessionManager, type SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import { SerializedSessionRowWriter } from "../../src/daemon/sessionRowWriter";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeSessionRowWriter } from "../fakes/FakeSessionRowWriter";
import { FakeTimer } from "../fakes/FakeTimer";

test("manager slots read pending from the injected writer on every call", async () => {
  const timer = new FakeTimer();
  const writer = new FakeSessionRowWriter();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    undefined,
    undefined,
    {
      networkCondition: () => ({ restore: () => Promise.resolve() }),
      clock: () => ({ restore: () => Promise.resolve() }),
      rowWriter: writer,
    },
  );
  manager.stopCleanupTimer();
  const slots = Reflect.get(manager, "sessionSlots") as SessionManager["sessionSlots"];
  const snapshot: SessionReleaseSnapshot = {
    sessionId: "row-pending",
    deviceId: "fake-device",
    releaseReason: "explicit-release",
    releasedAtMs: 0,
    terminal: true,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 1000, ageMs: 0 },
  };
  expect(slots.rowPending(snapshot.sessionId)).toBe(false);
  writer.desire(snapshot.sessionId, {
    snapshot,
    terminal: true,
    precondition: () => Promise.resolve({}),
  });
  expect(slots.rowPending(snapshot.sessionId)).toBe(true);
  expect(slots.rowPending("other")).toBe(false);
  await writer.land(snapshot.sessionId);
  expect(slots.rowPending(snapshot.sessionId)).toBe(false);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("the default writer stays idle through manager create and release", async () => {
  const timer = new FakeTimer();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  manager.stopCleanupTimer();
  const writer = Reflect.get(manager, "rowWriter") as SerializedSessionRowWriter;
  const slots = Reflect.get(manager, "sessionSlots") as SessionManager["sessionSlots"];
  expect(writer).toBeInstanceOf(SerializedSessionRowWriter);
  await manager.createSession("idle-writer", "fake-device", "android", 60_000);
  expect(slots.rowPending("idle-writer")).toBe(false);
  await manager.releaseSession("idle-writer", "explicit-release");
  expect(slots.rowPending("idle-writer")).toBe(false);
  expect(writer.pendingSnapshot("idle-writer")).toBeUndefined();
  expect(timer.getSleepHistory()).toEqual([]);
});

test("manager delegates drain tracking and awaits writes added during the drain", async () => {
  const timer = new FakeTimer();
  const writer = new FakeSessionRowWriter();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    undefined,
    undefined,
    { rowWriter: writer },
  );
  manager.stopCleanupTimer();
  const track = Reflect.get(manager, "trackReleaseDrainWrite") as (write: Promise<void>) => void;
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  track.call(manager, first.promise);
  expect(Array.from(writer.pendingDrainWrites())).toEqual([first.promise]);
  let drained = false;
  const drain = manager.drainReleasePromises(1000).then((result) => {
    drained = true;
    return result;
  });
  track.call(manager, second.promise);
  first.resolve();
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  expect(drained).toBe(false);
  expect(Array.from(writer.pendingDrainWrites())).toEqual([second.promise]);
  second.resolve();
  expect(await drain).toBe(true);
  expect(writer.pendingDrainWrites().size).toBe(0);
  expect(timer.getPendingTimeouts()).toEqual([]);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("manager drain excludes settled identities from its next writer snapshot", async () => {
  const timer = new FakeTimer();
  const writer = new FakeSessionRowWriter();
  const completed = Promise.resolve();
  let reads = 0;
  writer.pendingDrainWrites = () => {
    reads++;
    // A third read ends a broken loop so the assertion fails without a timeout or real sleep.
    return new Set(reads <= 2 ? [completed] : []);
  };
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    undefined,
    undefined,
    { rowWriter: writer },
  );
  manager.stopCleanupTimer();
  expect(await manager.drainReleasePromises(1000)).toBe(true);
  expect(reads).toBe(2);
  expect(timer.getPendingTimeouts()).toEqual([]);
  expect(timer.getSleepHistory()).toEqual([]);
});
