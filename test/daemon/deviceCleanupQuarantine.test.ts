import { expect, test } from "bun:test";
import { DeviceCleanupQuarantine } from "../../src/daemon/deviceCleanupQuarantine";
import { FakeTimer } from "../fakes/FakeTimer";

const CAP = 10_000;
const DEFAULT_HINT = 1_000;

function create(owned = new Set<string>()) {
  const timer = new FakeTimer();
  const quarantine = new DeviceCleanupQuarantine({
    timer,
    now: () => timer.now(),
    hasOwner: (deviceId) => owned.has(deviceId),
    teardownCapMs: CAP,
    defaultRetryAfterMs: DEFAULT_HINT,
  });
  return { timer, quarantine, owned };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

test("tracked work quarantines the device until it settles", async () => {
  const { quarantine } = create();
  const work = Promise.withResolvers<void>();
  quarantine.track("d1", [work.promise]);
  expect(quarantine.get("d1")).not.toBeNull();
  expect(quarantine.get("d2")).toBeNull();
  work.resolve();
  await flush();
  expect(quarantine.get("d1")).toBeNull();
  expect(quarantine.workCount("d1")).toBe(0);
});

test("a rejected cleanup still releases the quarantine", async () => {
  const { quarantine } = create();
  const work = Promise.withResolvers<void>();
  quarantine.track("d1", [work.promise]);
  work.reject(new Error("late failure"));
  await flush();
  expect(quarantine.get("d1")).toBeNull();
});

test("an own gate is excluded so the holder's own deferred work does not block it", async () => {
  const { quarantine } = create();
  const own = Promise.withResolvers<void>();
  quarantine.track("d1", [own.promise]);
  expect(quarantine.get("d1", own.promise)).toBeNull();
  const other = Promise.withResolvers<void>();
  quarantine.track("d1", [other.promise]);
  expect(quarantine.get("d1", own.promise)).not.toBeNull();
  expect(quarantine.workCount("d1")).toBe(2);
});

test("drain resolves true when idle and false when work outlives the timeout", async () => {
  const { quarantine, timer } = create();
  expect(await quarantine.drain(100)).toBe(true);
  quarantine.track("d1", [new Promise<void>(() => {})]);
  const drained = quarantine.drain(100);
  timer.advanceTime(100);
  expect(await drained).toBe(false);
});

test("a numeric cap bounds the retry hint and clears on settle", async () => {
  const { quarantine, timer } = create();
  const work = Promise.withResolvers<void>();
  quarantine.register("d1", work.promise, 4_000);
  expect(quarantine.retryAfterMs("d1", [])).toBe(4_000);
  timer.advanceTime(1_500);
  expect(quarantine.retryAfterMs("d1", [])).toBe(2_500);
  work.resolve();
  await flush();
  expect(quarantine.boundCount("d1")).toBe(0);
  expect(quarantine.retryAfterMs("d1", [])).toBe(DEFAULT_HINT);
});

test("release bounds are folded into the retry hint", () => {
  const { quarantine, timer } = create();
  timer.setCurrentTime(1_000);
  expect(quarantine.retryAfterMs("d1", [6_000, 3_000])).toBe(5_000);
});

test("a listener cleanup is capped and abandoned only once the device has no owner", async () => {
  const owned = new Set(["d1"]);
  const { quarantine, timer } = create(owned);
  let abandoned = 0;
  quarantine.register("d1", new Promise<void>(() => {}), {
    name: "listener",
    leftover: "state",
    abandon: () => {
      abandoned++;
    },
  });
  // Held by an owner: the cap has not started, the hint assumes a full cap.
  timer.advanceTime(CAP * 2);
  await flush();
  expect(abandoned).toBe(0);
  expect(quarantine.get("d1")).not.toBeNull();
  expect(quarantine.retryAfterMs("d1", [])).toBe(CAP);

  owned.delete("d1");
  quarantine.armCaps("d1");
  timer.advanceTime(CAP);
  await flush();
  expect(abandoned).toBe(1);
  expect(quarantine.get("d1")).toBeNull();
});

test("acquisition work counts only once the device has no owner", async () => {
  const owned = new Set(["d1"]);
  const { quarantine } = create(owned);
  const work = Promise.withResolvers<void>();
  quarantine.registerAcquisition("d1", work.promise, 3_000);
  expect(quarantine.hasAcquisitionWork("d1")).toBe(true);
  expect(quarantine.get("d1")).toBeNull();
  expect(quarantine.retryAfterMs("d1", [])).toBe(DEFAULT_HINT);
  owned.delete("d1");
  expect(quarantine.retryAfterMs("d1", [])).toBe(3_000);
  work.resolve();
  await flush();
  expect(quarantine.hasAcquisitionWork("d1")).toBe(false);
});

test("teardown promises keep their recorded deadline when quarantined", async () => {
  const { quarantine, timer } = create();
  timer.setCurrentTime(500);
  const teardown = Promise.withResolvers<void>();
  quarantine.noteTeardownBound(teardown.promise, 500 + CAP);
  quarantine.trackTeardown("d1", [teardown.promise]);
  expect(quarantine.boundCount("d1")).toBe(1);
  expect(quarantine.retryAfterMs("d1", [])).toBe(CAP);
  teardown.resolve();
  await flush();
  expect(quarantine.boundCount("d1")).toBe(0);
});
