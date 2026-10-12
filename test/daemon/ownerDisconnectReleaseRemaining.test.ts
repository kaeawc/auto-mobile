import { expect, test } from "bun:test";
import { OwnerDisconnectRelease } from "../../src/daemon/ownerDisconnectRelease";
import { DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

async function setup() {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const session = await manager.createSession("holder", "device", "android");
  let calls = 0;
  let connected = false;
  let reads = 0;
  let finish: ((result: { deferredUntil: number } | void) => void) | undefined;
  const release = new OwnerDisconnectRelease(
    {
      getSession: () => {
        reads++;
        return session;
      },
      hasConnectedOwner: () => connected,
      release: async () => {
        calls++;
        return await new Promise<{ deferredUntil: number } | void>((resolve) => {
          finish = resolve;
        });
      },
    },
    timer,
    8_000,
    () => timer.now() + 100,
  );
  return {
    timer,
    manager,
    session,
    release,
    reads: () => reads,
    connect: () => {
      connected = true;
    },
    calls: () => calls,
    finish: (due?: number) => finish?.(due === undefined ? undefined : { deferredUntil: due }),
  };
}

test("remaining release time is a pure read on the release clock, absent after cancel", async () => {
  const rig = await setup();
  try {
    expect(rig.release.remainingMs("holder")).toBeUndefined();
    rig.release.ownerDisconnected("holder", "owner");
    expect(rig.release.remainingMs("holder")).toBe(8_000);
    rig.timer.advanceTime(1_234);
    expect(rig.release.remainingMs("holder")).toBe(6_766);
    rig.release.cancel("holder");
    expect(rig.release.remainingMs("holder")).toBeUndefined();
    rig.timer.advanceTime(8_000);
    expect(rig.calls()).toBe(0);
  } finally {
    rig.manager.stopCleanupTimer();
  }
});

test("reads do not delay firing and in-flight attempts report the existing poll hint", async () => {
  const rig = await setup();
  try {
    rig.release.ownerDisconnected("holder", "owner");
    rig.timer.advanceTime(7_999);
    expect(rig.release.remainingMs("holder")).toBe(1);
    rig.timer.advanceTime(1);
    expect(rig.calls()).toBe(1);
    expect(rig.release.remainingMs("holder")).toBe(
      DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS,
    );
    rig.finish(10_100);
    await drainMicrotasks(32);
    expect(rig.release.remainingMs("holder")).toBe(2_000);
    rig.timer.advanceTime(1_999);
    expect(rig.release.remainingMs("holder")).toBe(1);
    rig.release.executionsEnded(["holder"]);
    expect(rig.release.remainingMs("holder")).toBe(0);
    rig.timer.advanceTime(0);
    expect(rig.calls()).toBe(2);
    rig.finish();
    await drainMicrotasks(32);
    expect(rig.release.remainingMs("holder")).toBeUndefined();
  } finally {
    rig.manager.stopCleanupTimer();
  }
});

test("an overdue scheduled attempt never reports a negative remaining time", async () => {
  const rig = await setup();
  try {
    rig.release.ownerDisconnected("holder", "owner");
    rig.timer.setCurrentTime(8_001);
    expect(rig.release.remainingMs("holder")).toBe(0);
    expect(rig.calls()).toBe(0);
    rig.timer.advanceTime(0);
    expect(rig.calls()).toBe(1);
    rig.finish();
    await drainMicrotasks(32);
  } finally {
    rig.manager.stopCleanupTimer();
  }
});

for (const blocker of ["heartbeat", "connected-owner"] as const) {
  test(`remaining time excludes a pending release blocked by ${blocker} without reading the pool`, async () => {
    const rig = await setup();
    try {
      rig.release.ownerDisconnected("holder", "owner");
      const reads = rig.reads();
      rig.timer.advanceTime(1_000);
      if (blocker === "heartbeat") {
        rig.session.lastOwnerHeartbeat = rig.timer.now() + 100;
      } else {
        rig.connect();
      }
      for (const elapsed of [0, 2_000, 2_000, 2_000, 999]) {
        rig.timer.advanceTime(elapsed);
        expect(rig.release.remainingMs("holder")).toBeUndefined();
        expect(rig.release.isPending("holder")).toBe(true);
        expect(rig.reads()).toBe(reads);
      }
      rig.timer.advanceTime(2);
      expect(rig.calls()).toBe(0);
      expect(rig.release.isPending("holder")).toBe(false);
    } finally {
      rig.release.cancel("holder");
      rig.manager.stopCleanupTimer();
    }
  });
}

test("a release deferred beyond grace has no hint until executions end and rearm it", async () => {
  const rig = await setup();
  try {
    rig.release.ownerDisconnected("holder", "owner");
    rig.timer.advanceTime(8_000);
    expect(rig.calls()).toBe(1);
    rig.finish(608_100);
    await drainMicrotasks(32);
    expect(rig.release.remainingMs("holder")).toBeUndefined();
    expect(rig.release.isPending("holder")).toBe(true);
    rig.release.executionsEnded(["holder"]);
    expect(rig.release.remainingMs("holder")).toBe(0);
    rig.timer.advanceTime(0);
    expect(rig.calls()).toBe(2);
    expect(rig.release.remainingMs("holder")).toBe(
      DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS,
    );
    rig.finish();
    await drainMicrotasks(32);
    expect(rig.release.isPending("holder")).toBe(false);
  } finally {
    rig.release.cancel("holder");
    rig.manager.stopCleanupTimer();
  }
});
