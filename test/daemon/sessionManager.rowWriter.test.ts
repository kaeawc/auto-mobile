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
