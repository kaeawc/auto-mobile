import { expect, test } from "bun:test";
import { ImeSpanService, type ImeSpanHost } from "../../../../src/features/action/sendkeys/ImeSpan";
import { DevicePendingImeRestores } from "../../../../src/features/action/sendkeys/PendingImeRestore";
import { drainUntil, drainMicrotasks } from "../../../helpers/fakeTimerStepping";
import { withAndroidImeLock } from "../../../../src/features/action/androidImeLock";

const snapshot = { prior: "keyboard/.Ime", wasEnabled: false, priorSubtype: { id: 7 } };
let serial = 0;
function harness() {
  const deviceId = `lazy-ime-${++serial}`;
  const registry = new DevicePendingImeRestores();
  let pinnedUser: number | undefined;
  const restored: unknown[] = [];
  const fences: (AbortSignal | undefined)[] = [];
  const host: ImeSpanHost = {
    deviceId,
    verifySafeImeRecovery: async () => true,
    restoreIme: async (prior, wasEnabled, subtype, fence) => {
      restored.push([prior, wasEnabled, subtype, pinnedUser]);
      fences.push(fence);
    },
    getPinnedUser: () => pinnedUser,
    setPinnedUser: (user) => {
      pinnedUser = user;
    },
    clearPinnedUser: () => {
      pinnedUser = undefined;
    },
  };
  const service = new ImeSpanService(host, registry);
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
  return {
    deviceId,
    registry,
    service,
    commit,
    restored,
    fences,
    host,
    captures: () => captures,
  };
}

test("an empty flush completes while the device IME lock is held", async () => {
  const h = harness();
  await withAndroidImeLock(h.deviceId, async () => {
    let flushed = false;
    const flush = h.registry.flush(h.deviceId).then(() => {
      flushed = true;
    });
    await drainUntil(() => flushed, { description: "empty IME flush", maxTurns: 20 });
    await flush;
  });
  expect(h.restored).toEqual([]);
});

test("consecutive calls swap in once, never restore between them, and release the lock", async () => {
  const h = harness();
  expect(h.registry.hasPending(h.deviceId)).toBe(false);
  await h.commit();
  expect(h.registry.hasPending(h.deviceId)).toBe(true);
  await withAndroidImeLock(h.deviceId, async () => {
    expect(h.restored).toEqual([]);
  });
  await h.commit();
  await h.commit();
  expect(h.restored).toEqual([]);
  expect(h.captures()).toBe(1);
  await h.registry.flush(h.deviceId);
  expect(h.registry.hasPending(h.deviceId)).toBe(false);
  await h.registry.flush(h.deviceId);
  expect(h.restored).toEqual([["keyboard/.Ime", false, { id: 7 }, 10]]);
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
  const second = new ImeSpanService(h.host, h.registry);
  await second.withImeSpan(async () => {
    await second.acquireImeSpan(second.imeSpan!);
    expect(second.imeSpan?.snapshot).toEqual(snapshot);
    return { results: [] };
  });
  await h.registry.flush(h.deviceId);
  expect(h.restored).toHaveLength(1);
});

test("a restore in flight stays pending and a second flush waits for it to finish", async () => {
  const deviceId = `lazy-ime-${++serial}`;
  const registry = new DevicePendingImeRestores();
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  registry.store(deviceId, {
    snapshot,
    userId: 10,
    restore: async () => {
      events.push("restore-start");
      await gate.promise;
      events.push("restore-end");
    },
  });
  const first = registry.flush(deviceId);
  await drainUntil(() => events.includes("restore-start"), { description: "restore start" });

  expect(registry.hasPending(deviceId)).toBe(true);
  let flushed = false;
  const flush = registry.flush(deviceId).then(() => {
    flushed = true;
    events.push("flushed");
  });
  await drainMicrotasks(50);
  expect(flushed).toBe(false);

  gate.resolve();
  await first;
  await flush;
  expect(events).toEqual(["restore-start", "restore-end", "flushed"]);
  expect(registry.hasPending(deviceId)).toBe(false);
});

test("a forced flush discards the pending restore once it holds the lock", async () => {
  const deviceId = `lazy-ime-${++serial}`;
  const registry = new DevicePendingImeRestores();
  let restores = 0;
  registry.store(deviceId, {
    snapshot,
    userId: 10,
    restore: async () => {
      restores++;
    },
  });
  let forced = false;
  const lockHeld = Promise.withResolvers<void>();
  const holder = withAndroidImeLock(deviceId, () => lockHeld.promise);
  const flush = registry.flush(deviceId, { isForced: () => forced });
  await drainMicrotasks(50);
  forced = true;
  lockHeld.resolve();
  await holder;
  await flush;
  expect(restores).toBe(0);
  expect(registry.hasPending(deviceId)).toBe(false);
});

test("a teardown flush hands its ownership signal to the deferred restore (#16580)", async () => {
  const h = harness();
  await h.commit();
  const owner = new AbortController();
  await h.registry.flush(h.deviceId, { signal: owner.signal });
  expect(h.restored).toEqual([["keyboard/.Ime", false, { id: 7 }, 10]]);
  expect(h.fences).toEqual([owner.signal]);
});

test("a flush without an owner restores without an ownership signal", async () => {
  const h = harness();
  await h.commit();
  await h.registry.flush(h.deviceId);
  expect(h.fences).toEqual([undefined]);
});

test("a recorded keyboard survives any number of calls until release restores it once (#16428)", async () => {
  const h = harness();
  await h.commit();
  await h.commit();
  expect(h.captures()).toBe(1);
  expect(h.restored).toEqual([]);
  expect(h.registry.hasPending(h.deviceId)).toBe(true);
  await h.registry.flush(h.deviceId, { signal: new AbortController().signal });
  expect(h.restored).toEqual([["keyboard/.Ime", false, { id: 7 }, 10]]);
  await h.commit();
  expect(h.captures()).toBe(2);
});
