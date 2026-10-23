import { expect, spyOn, test, afterEach, mock } from "bun:test";
import { SessionManager, type SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import { SerializedSessionRowWriter } from "../../src/daemon/sessionRowWriter";
import { FileTerminalReleaseJournal } from "../../src/daemon/terminalReleaseJournal";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { FakeSessionRowWriter } from "../fakes/FakeSessionRowWriter";
import { FakeTimer } from "../fakes/FakeTimer";
import { installSessionManagerCleanup, makeSessionManager } from "../helpers/sessionManagerSuite";

afterEach(() => {
  mock.restore();
});

installSessionManagerCleanup();

test("manager slots read pending from the injected writer on every call", async () => {
  const timer = new FakeTimer();
  const writer = new FakeSessionRowWriter();
  const manager = makeSessionManager({
    timer,
    fakeBarrier: true,
    restorers: {
      networkCondition: () => ({ restore: () => Promise.resolve() }),
      clock: () => ({ restore: () => Promise.resolve() }),
    },
  });
  manager.setRowWriter(writer);
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
  const manager = makeSessionManager({ timer, fakeBarrier: true });
  manager.stopCleanupTimer();
  const writer = Reflect.get(manager, "rowWriter") as SerializedSessionRowWriter;
  const slots = Reflect.get(manager, "sessionSlots") as SessionManager["sessionSlots"];
  expect(writer).toBeInstanceOf(SerializedSessionRowWriter);
  await manager.createSession("idle-writer", "fake-device", "android", { timeoutMs: 60_000 });
  expect(slots.rowPending("idle-writer")).toBe(false);
  await manager.releaseSession("idle-writer", "explicit-release");
  expect(slots.rowPending("idle-writer")).toBe(false);
  expect(writer.pendingSnapshot("idle-writer")).toBeUndefined();
  expect(timer.getSleepHistory()).toEqual([]);
});

test("manager delegates drain tracking and awaits writes added during the drain", async () => {
  const timer = new FakeTimer();
  const writer = new FakeSessionRowWriter();
  const manager = makeSessionManager({ timer, fakeBarrier: true });
  manager.setRowWriter(writer);
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
  const manager = makeSessionManager({ timer, fakeBarrier: true });
  manager.setRowWriter(writer);
  manager.stopCleanupTimer();
  expect(await manager.drainReleasePromises(1000)).toBe(true);
  expect(reads).toBe(2);
  expect(timer.getPendingTimeouts()).toEqual([]);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("manager retry callbacks retain instance dispatch and enter on the timer's turn", async () => {
  const timer = new FakeTimer();
  const manager = makeSessionManager({ timer, fakeBarrier: true });
  manager.stopCleanupTimer();
  manager.setTerminalReleaseRetryBackoff({ delayForAttempt: () => 37 });
  const writer = Reflect.get(manager, "rowWriter") as SerializedSessionRowWriter;
  const snapshot: SessionReleaseSnapshot = {
    sessionId: "retry-dispatch",
    deviceId: "fake-device",
    releaseReason: "explicit-release",
    releasedAtMs: 0,
    terminal: true,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 1000, ageMs: 0 },
  };
  Reflect.set(manager, "isTerminalReleaseRetryCurrent", () => true);
  const schedule = Reflect.get(manager, "scheduleTerminalReleaseRetry") as (
    snapshot: SessionReleaseSnapshot,
  ) => void;
  schedule.call(manager, snapshot);
  expect(writer.pending(snapshot.sessionId)).toBe(true);
  expect(timer.getPendingTimeouts()).toEqual([37]);
  let entered = false;
  // Patch after scheduling: the timer must still dispatch through this manager instance.
  Reflect.set(manager, "retryTerminalReleaseWrite", () => {
    entered = true;
    writer.cancelRetry(snapshot);
    return Promise.resolve();
  });
  const settled = writer.settled(snapshot.sessionId);
  timer.advanceTime(37);
  expect(entered).toBe(true);
  expect(writer.pending(snapshot.sessionId)).toBe(false);
  await settled;
  expect(timer.getSleepHistory()).toEqual([]);
});

test("manager stop clears writer handles and drain retains the original retry promise", async () => {
  const timer = new FakeTimer();
  const manager = makeSessionManager({ timer, fakeBarrier: true });
  manager.stopCleanupTimer();
  const writer = Reflect.get(manager, "rowWriter") as SerializedSessionRowWriter;
  const snapshot: SessionReleaseSnapshot = {
    sessionId: "retry-stop",
    deviceId: "fake-device",
    releaseReason: "explicit-release",
    releasedAtMs: 0,
    terminal: true,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 1000, ageMs: 0 },
  };
  Reflect.set(manager, "isTerminalReleaseRetryCurrent", () => true);
  const schedule = Reflect.get(manager, "scheduleTerminalReleaseRetry") as (
    snapshot: SessionReleaseSnapshot,
  ) => void;
  schedule.call(manager, snapshot);
  expect(timer.getPendingTimeouts()).toHaveLength(1);
  manager.stopCleanupTimer();
  expect(timer.getPendingTimeouts()).toEqual([]);
  expect(writer.pending(snapshot.sessionId)).toBe(true);
  const gate = Promise.withResolvers<void>();
  Reflect.set(manager, "retryTerminalReleaseWrite", () => gate.promise);
  const retryNow = Reflect.get(manager, "retryPendingTerminalReleasesNow") as () => Promise<void>[];
  expect(retryNow.call(manager)).toEqual([gate.promise]);
  let drained = false;
  const drain = manager.drainReleasePromises(1000).then((result) => {
    drained = true;
    return result;
  });
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  expect(drained).toBe(false);
  writer.cancelRetry(snapshot);
  gate.resolve();
  expect(await drain).toBe(true);
  expect(timer.getPendingTimeouts()).toEqual([]);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("startup replay retains its fence without lifting a successor writer desire", async () => {
  const writer = new FakeSessionRowWriter();
  const manager = makeSessionManager({ fakeBarrier: true });
  manager.setRowWriter(writer);
  manager.stopCleanupTimer();
  const snapshot: SessionReleaseSnapshot = {
    sessionId: "replay",
    deviceId: "fake-device",
    terminal: true,
    releaseReason: "heartbeat-timeout",
    releasedAtMs: 0,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 1000, ageMs: 0 },
  };
  manager.testHooks.wiring.host.sessionSlots.setTerminalSnapshot(snapshot.sessionId, snapshot);
  writer.noteRelease(snapshot);
  writer.desire(snapshot.sessionId, {
    snapshot,
    terminal: true,
    precondition: () => Promise.resolve({}),
  });
  const lift = spyOn(writer, "liftTerminal");
  const publish = spyOn(writer, "noteLive");
  const journal = new FileTerminalReleaseJournal(
    "/in-memory/replay.jsonl",
    new FakeTerminalReleaseJournalFileSystem(),
  );
  journal.record({ sessionId: snapshot.sessionId, reason: "explicit-release", at: 0 });
  manager.attachTerminalReleaseJournal(journal);
  await manager.applyRecoveredTerminalReleaseIntents();
  expect(journal.loadUnconfirmed()).toEqual([]);
  expect(manager.testHooks.wiring.host.sessionSlots.getTerminalSnapshot(snapshot.sessionId)).toBe(
    snapshot,
  );
  expect(writer.pendingSnapshot(snapshot.sessionId)).toBe(snapshot);
  expect(writer.canIssueRelease(snapshot)).toBe(true);
  expect(lift).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

test("non-terminal commit without a fence does not resolve or reload the journal", async () => {
  const manager = makeSessionManager({ fakeBarrier: true });
  manager.stopCleanupTimer();
  const journal = new FileTerminalReleaseJournal(
    "/in-memory/unused.jsonl",
    new FakeTerminalReleaseJournalFileSystem(),
  );
  manager.attachTerminalReleaseJournal(journal);
  const resolve = spyOn(journal, "resolve");
  await manager.createSession("no-fence", "fake-device", "android", { timeoutMs: 60_000 });
  await manager.releaseSession("no-fence", "plan-auto-release");
  expect(resolve).not.toHaveBeenCalled();
});
