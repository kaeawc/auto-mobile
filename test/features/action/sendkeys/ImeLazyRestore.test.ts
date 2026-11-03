import { expect, test } from "bun:test";
import { ImeSpanService, type ImeSpanHost } from "../../../../src/features/action/sendkeys/ImeSpan";
import {
  DevicePendingImeRestores,
  IME_IDLE_RESTORE_MS,
} from "../../../../src/features/action/sendkeys/PendingImeRestore";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainUntil, drainMicrotasks } from "../../../helpers/fakeTimerStepping";
import { withAndroidImeLock } from "../../../../src/features/action/androidImeLock";

const snapshot = { prior: "keyboard/.Ime", wasEnabled: false, priorSubtype: { id: 7 } };
let serial = 0;
function harness() {
  const deviceId = `lazy-ime-${++serial}`;
  const timer = new FakeTimer();
  const registry = new DevicePendingImeRestores();
  let pinnedUser: number | undefined;
  const restored: unknown[] = [];
  const host: ImeSpanHost = {
    deviceId,
    verifySafeImeRecovery: async () => true,
    restoreIme: async (...args) => {
      restored.push([...args, pinnedUser]);
    },
    getPinnedUser: () => pinnedUser,
    setPinnedUser: (user) => {
      pinnedUser = user;
    },
    clearPinnedUser: () => {
      pinnedUser = undefined;
    },
  };
  const service = new ImeSpanService(host, timer, registry);
  let captures = 0;
  const commit = () =>
    service.withImeSpan(async () => {
      const span = service.imeSpan!;
      await service.acquireImeSpan(span);
      if (!span.snapshot) {
        captures++;
        pinnedUser = 10;
        span.snapshot = snapshot;
      }
      return { results: [{ index: 0, action: "type", resolvedMode: "ime", success: true }] };
    });
  return { deviceId, timer, registry, service, commit, restored, host, captures: () => captures };
}

test("three calls retain the original snapshot and release the device lock while idle", async () => {
  const h = harness();
  await h.commit();
  await withAndroidImeLock(h.deviceId, async () => {
    expect(h.restored).toEqual([]);
  });
  await h.commit();
  await h.commit();
  expect(h.restored).toEqual([]);
  expect(h.captures()).toBe(1);
  await h.registry.flush(h.deviceId);
  await h.registry.flush(h.deviceId);
  expect(h.restored).toEqual([["keyboard/.Ime", false, { id: 7 }, 10]]);
});

test("idle restore resets on each call and preserves the pinned Android user", async () => {
  const h = harness();
  await h.commit();
  h.timer.advanceTime(IME_IDLE_RESTORE_MS - 1);
  await h.commit();
  h.timer.advanceTime(1);
  expect(h.restored).toEqual([]);
  h.timer.advanceTime(IME_IDLE_RESTORE_MS);
  await drainUntil(() => h.restored.length === 1, { description: "idle IME restoration" });
  expect(h.restored).toEqual([["keyboard/.Ime", false, { id: 7 }, 10]]);
  await h.registry.flush(h.deviceId);
  expect(h.restored).toHaveLength(1);
});

test("a non-IME typing mode restores pending state before delivery", async () => {
  const h = harness();
  await h.commit();
  await h.service.withImeSpan(async () => {
    await h.service.restoreImeSpan();
    expect(h.restored).toHaveLength(1);
    return { results: [] };
  });
  await h.registry.flush(h.deviceId);
  expect(h.restored).toHaveLength(1);
});

test("a second executor on the same device inherits the original snapshot", async () => {
  const h = harness();
  await h.commit();
  const second = new ImeSpanService(h.host, h.timer, h.registry);
  await second.withImeSpan(async () => {
    await second.acquireImeSpan(second.imeSpan!);
    expect(second.imeSpan?.snapshot).toEqual(snapshot);
    return { results: [] };
  });
  await h.registry.flush(h.deviceId);
  expect(h.restored).toHaveLength(1);
});

test("an idle failure logs a warning and consumes the snapshot without implicit retries", async () => {
  const timer = new FakeTimer();
  const warnings: unknown[] = [];
  const registry = new DevicePendingImeRestores({
    warn: (...args) => {
      warnings.push(args);
    },
  });
  let attempts = 0;
  registry.store(
    "idle-failure",
    {
      snapshot,
      userId: 10,
      restore: async () => {
        attempts++;
        throw new Error("restore rejected");
      },
    },
    timer,
  );
  timer.advanceTime(IME_IDLE_RESTORE_MS);
  await drainUntil(() => warnings.length === 1, { description: "idle restore warning" });
  expect(String(warnings[0])).toContain("Idle IME restoration failed");
  await registry.flush("idle-failure");
  expect(attempts).toBe(1);
});

test("an expired timer queued on the mutex cannot consume a newly reset idle period", async () => {
  const h = harness();
  await h.commit();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const competingCall = withAndroidImeLock(h.deviceId, async () => {
    entered.resolve();
    await gate.promise;
    const pending = h.registry.take(h.deviceId)!;
    h.registry.store(h.deviceId, pending, h.timer);
  });
  await entered.promise;
  h.timer.advanceTime(IME_IDLE_RESTORE_MS);
  gate.resolve();
  await competingCall;
  await drainMicrotasks(20);
  expect(h.restored).toEqual([]);
  h.timer.advanceTime(IME_IDLE_RESTORE_MS - 1);
  expect(h.restored).toEqual([]);
  h.timer.advanceTime(1);
  await drainUntil(() => h.restored.length === 1, { description: "reset idle IME restoration" });
  expect(h.restored).toHaveLength(1);
});
