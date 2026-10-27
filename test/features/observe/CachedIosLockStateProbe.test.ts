import { BudgetedIosLockStateProbe } from "../../../src/features/observe/ios/BudgetedIosLockStateProbe";
import { expect, test } from "bun:test";
import { CachedIosLockStateProbe } from "../../../src/features/observe/ios/CachedIosLockStateProbe";
import type { IosLockStateReading } from "../../../src/features/observe/ios/IosLockStateProbe";
import { FakeTimer } from "../../fakes/FakeTimer";

const known: IosLockStateReading = { kind: "known", lock: { locked: true, keyguardShowing: true } };
function harness(options: ConstructorParameters<typeof CachedIosLockStateProbe>[2] = {}) {
  const timer = new FakeTimer();
  let calls = 0;
  let receivedSignal: AbortSignal | undefined;
  let answer: Promise<IosLockStateReading> = Promise.resolve(known);
  const cache = new CachedIosLockStateProbe(
    {
      read: (_id, signal) => {
        calls++;
        receivedSignal = signal;
        return answer;
      },
    },
    timer,
    options,
  );
  return {
    timer,
    cache,
    calls: () => calls,
    signal: () => receivedSignal,
    answer: (value: Promise<IosLockStateReading>) => {
      answer = value;
    },
  };
}
test("known cache TTL and device isolation", async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) {
    expect(await h.cache.read("a")).toEqual(known);
  }
  expect(h.calls()).toBe(1);
  await h.cache.read("b");
  expect(h.calls()).toBe(2);
  h.timer.advanceTime(30_000);
  await h.cache.read("a");
  expect(h.calls()).toBe(3);
});
test("failures retain reason for the shorter TTL", async () => {
  const h = harness();
  const failure: IosLockStateReading = { kind: "unknown", reason: "timeout" };
  h.answer(Promise.resolve(failure));
  expect(await h.cache.read("a")).toEqual(failure);
  h.timer.advanceTime(4999);
  expect(await h.cache.read("a")).toEqual(failure);
  expect(h.calls()).toBe(1);
  h.timer.advanceTime(1);
  await h.cache.read("a");
  expect(h.calls()).toBe(2);
});
test("single flight detaches aborting callers without cancelling the shared read", async () => {
  const h = harness();
  const deferred = Promise.withResolvers<IosLockStateReading>();
  h.answer(deferred.promise);
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const first = h.cache.read("a", controller.signal);
  const others = Array.from({ length: 10 }, () => h.cache.read("a"));
  controller.abort(reason);
  await expect(first).resolves.toEqual({
    kind: "unknown",
    reason: "pending",
    message: "caller aborted",
  });
  expect(h.signal()).toBeUndefined();
  expect(h.calls()).toBe(1);
  deferred.resolve(known);
  expect(await Promise.all(others)).toEqual(others.map(() => known));
});
test("invalidation discards stale flight and forces a new read", async () => {
  const h = harness();
  const deferred = Promise.withResolvers<IosLockStateReading>();
  h.answer(deferred.promise);
  const old = h.cache.read("a");
  h.cache.invalidate("a");
  h.answer(Promise.resolve(known));
  await h.cache.read("a");
  expect(h.calls()).toBe(2);
  deferred.resolve({ kind: "unknown", reason: "error" });
  await old;
  expect(await h.cache.read("a")).toEqual(known);
  expect(h.calls()).toBe(2);
  h.cache.invalidate("a");
  await h.cache.read("a");
  expect(h.calls()).toBe(3);
});
test("soft budget returns pending and late completion fills cache", async () => {
  const h = harness();
  const deferred = Promise.withResolvers<IosLockStateReading>();
  h.answer(deferred.promise);
  const view = new BudgetedIosLockStateProbe(h.cache, h.timer);
  const pending = view.read("a");
  h.timer.advanceTime(750);
  expect(await pending).toEqual({ kind: "unknown", reason: "pending" });
  deferred.resolve(known);
  await h.cache.read("a");
  expect(await view.read("a")).toEqual(known);
  expect(h.calls()).toBe(1);
});
test("a late inner rejection becomes cached explicit error", async () => {
  const h = harness();
  const deferred = Promise.withResolvers<IosLockStateReading>();
  h.answer(deferred.promise);
  const pending = new BudgetedIosLockStateProbe(h.cache, h.timer).read("a");
  h.timer.advanceTime(750);
  await pending;
  deferred.reject(new Error("probe failed"));
  expect(await h.cache.read("a")).toMatchObject({ kind: "unknown", reason: "error" });
});

test("shared read does not inherit ambient request cancellation", async () => {
  const { runWithAbortSignal, getAbortSignal } = await import("../../../src/utils/AbortContext");
  const timer = new FakeTimer();
  let inherited: AbortSignal | undefined;
  const cache = new CachedIosLockStateProbe(
    {
      read: async () => {
        inherited = getAbortSignal();
        return known;
      },
    },
    timer,
  );
  const caller = new AbortController();
  expect(await runWithAbortSignal(caller.signal, () => cache.read("a"))).toEqual(known);
  expect(inherited).toBeUndefined();
});

test("registry uses injected cache and resets lazily", async () => {
  const { getIosLockStateCache, setIosLockStateCache, resetIosLockStateCache } =
    await import("../../../src/features/observe/ios/IosLockStateCacheRegistry");
  const h = harness();
  try {
    setIosLockStateCache(h.cache);
    expect(getIosLockStateCache()).toBe(h.cache);
    resetIosLockStateCache();
    expect(getIosLockStateCache()).not.toBe(h.cache);
  } finally {
    resetIosLockStateCache();
  }
});

test("budgeted abort resolves while the inner read never settles", async () => {
  const timer = new FakeTimer();
  const probe = new BudgetedIosLockStateProbe({ read: () => new Promise(() => {}) }, timer);
  const controller = new AbortController();
  const reading = probe.read("a", controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(reading).resolves.toEqual({
    kind: "unknown",
    reason: "pending",
    message: "caller aborted",
  });
});

const unlocked: IosLockStateReading = {
  kind: "known",
  lock: { locked: false, keyguardShowing: false },
};
test("locked readings expire at two seconds while unlocked readings last thirty", async () => {
  for (const [reading, ttl] of [
    [known, 2_000],
    [unlocked, 30_000],
  ] as const) {
    const h = harness();
    h.answer(Promise.resolve(reading));
    await h.cache.read("a");
    h.timer.advanceTime(ttl - 1);
    await h.cache.read("a");
    expect(h.calls()).toBe(1);
    h.timer.advanceTime(1);
    await h.cache.read("a");
    expect(h.calls()).toBe(2);
  }
});
test("first unlocked reading after invalidation settles before using the normal TTL", async () => {
  const h = harness();
  h.answer(Promise.resolve(unlocked));
  await h.cache.read("a");
  h.cache.invalidate("a");
  await h.cache.read("a");
  h.timer.advanceTime(1_999);
  await h.cache.read("a");
  expect(h.calls()).toBe(2);
  h.timer.advanceTime(1);
  await h.cache.read("a");
  expect(h.calls()).toBe(3);
  h.timer.advanceTime(29_999);
  await h.cache.read("a");
  expect(h.calls()).toBe(3);
  h.timer.advanceTime(1);
  await h.cache.read("a");
  expect(h.calls()).toBe(4);
});
test("stale flight completion cannot consume the new epoch's settling flag", async () => {
  const h = harness();
  const stale = Promise.withResolvers<IosLockStateReading>();
  h.answer(stale.promise);
  const old = h.cache.read("a");
  h.cache.invalidate("a");
  stale.resolve(unlocked);
  await old;
  h.answer(Promise.resolve({ kind: "unknown", reason: "timeout" }));
  await h.cache.read("a");
  h.timer.advanceTime(5_000);
  h.answer(Promise.resolve(unlocked));
  await h.cache.read("a");
  h.timer.advanceTime(2_000);
  await h.cache.read("a");
  expect(h.calls()).toBe(4);
});

test("custom settling cap never lengthens a locked TTL and is per device", async () => {
  const h = harness({ lockedTtlMs: 500, settleTtlMs: 1_000, knownTtlMs: 10_000 });
  h.cache.invalidate("a");
  await h.cache.read("a");
  h.timer.advanceTime(500);
  await h.cache.read("a");
  expect(h.calls()).toBe(2);
  h.answer(Promise.resolve(unlocked));
  h.cache.invalidate("a");
  await h.cache.read("a");
  await h.cache.read("b");
  h.timer.advanceTime(1_000);
  await h.cache.read("a");
  await h.cache.read("b");
  expect(h.calls()).toBe(5);
});
test("budgeted abort leaves the shared flight able to fill the cache", async () => {
  const h = harness();
  const deferred = Promise.withResolvers<IosLockStateReading>();
  h.answer(deferred.promise);
  const controller = new AbortController();
  const view = new BudgetedIosLockStateProbe(h.cache, h.timer);
  const reading = view.read("a", controller.signal);
  controller.abort();
  expect(await reading).toEqual({ kind: "unknown", reason: "pending", message: "caller aborted" });
  deferred.resolve(known);
  expect(await h.cache.read("a")).toEqual(known);
  expect(await view.read("a")).toEqual(known);
  expect(h.calls()).toBe(1);
});

test("an expired unlocked reading is served stale while one background refresh runs (#15311)", async () => {
  const h = harness();
  h.answer(Promise.resolve(unlocked));
  await h.cache.read("a");
  h.timer.advanceTime(30_000);
  const refresh = Promise.withResolvers<IosLockStateReading>();
  h.answer(refresh.promise);
  const view = new BudgetedIosLockStateProbe(h.cache, h.timer);
  const burst = await Promise.all(Array.from({ length: 10 }, () => view.read("a")));
  expect(burst).toEqual(burst.map(() => unlocked));
  expect(h.calls()).toBe(2);
  refresh.resolve(known);
  await Promise.resolve();
  await Promise.resolve();
  expect(await h.cache.read("a")).toEqual(known);
  expect(h.calls()).toBe(2);
});

test("a failed refresh keeps serving the last known reading within the stale window", async () => {
  const h = harness();
  h.answer(Promise.resolve(unlocked));
  await h.cache.read("a");
  h.timer.advanceTime(30_000);
  h.answer(Promise.resolve({ kind: "unknown", reason: "timeout" }));
  expect(await h.cache.read("a")).toEqual(unlocked);
  await Promise.resolve();
  await Promise.resolve();
  expect(await h.cache.read("a")).toEqual(unlocked);
  h.timer.advanceTime(5_000);
  expect(await h.cache.read("a")).toEqual(unlocked);
  expect(h.calls()).toBe(3);
});

test("a stale reading past its window is not served and the caller waits for a fresh one", async () => {
  const h = harness();
  h.answer(Promise.resolve(unlocked));
  await h.cache.read("a");
  h.timer.advanceTime(30_000 + 120_000);
  const fresh = Promise.withResolvers<IosLockStateReading>();
  h.answer(fresh.promise);
  const pending = h.cache.read("a");
  fresh.resolve(known);
  expect(await pending).toEqual(known);
});

test("a locked reading is stale-served only for its short window", async () => {
  const h = harness();
  await h.cache.read("a");
  h.timer.advanceTime(2_000 + 9_999);
  h.answer(Promise.resolve(unlocked));
  expect(await h.cache.read("a")).toEqual(known);
  await Promise.resolve();
  await Promise.resolve();
  // The refresh landed: the fresh unlocked reading replaces the stale locked one.
  expect(await h.cache.read("a")).toEqual(unlocked);
  expect(h.calls()).toBe(2);
});

test("a locked reading older than its stale window is not served", async () => {
  const h = harness();
  await h.cache.read("a");
  h.timer.advanceTime(2_000 + 10_000);
  const fresh = Promise.withResolvers<IosLockStateReading>();
  h.answer(fresh.promise);
  const reading = h.cache.read("a");
  fresh.resolve(unlocked);
  expect(await reading).toEqual(unlocked);
});

test("invalidation drops the stale reading so a transition is never masked", async () => {
  const h = harness();
  h.answer(Promise.resolve(unlocked));
  await h.cache.read("a");
  h.timer.advanceTime(30_000);
  h.cache.invalidate("a");
  const fresh = Promise.withResolvers<IosLockStateReading>();
  h.answer(fresh.promise);
  const reading = h.cache.read("a");
  fresh.resolve(known);
  expect(await reading).toEqual(known);
});
