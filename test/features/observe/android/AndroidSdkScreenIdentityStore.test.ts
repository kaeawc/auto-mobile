import { describe, expect, test } from "bun:test";
import { AndroidSdkScreenIdentityStore } from "../../../../src/features/observe/android/AndroidSdkScreenIdentityStore";
import type { ScreenIdentity } from "../../../../src/models/ObserveResult";
import { FakeTimer } from "../../../fakes/FakeTimer";

const identity = (route: string): ScreenIdentity => ({
  platform: "android",
  source: "sdk",
  confidence: "high",
  key: route,
  components: { navigationRoute: route },
});

describe("AndroidSdkScreenIdentityStore", () => {
  test("records the newest route and exposes its host receive time", () => {
    const timer = new FakeTimer();
    const store = new AndroidSdkScreenIdentityStore(timer);
    timer.advanceTime(10);
    store.record("com.app", identity("home"));
    expect(store.get("com.app")?.key).toBe("home");
    expect(store.getReceivedAtMs("com.app")).toBe(10);
    expect(store.get(undefined)).toBeUndefined();
  });

  test("a waiter resolves with a route newer than sinceMs, and at once for an existing one", async () => {
    const timer = new FakeTimer();
    const store = new AndroidSdkScreenIdentityStore(timer);
    store.record("com.app", identity("a"));
    expect((await store.awaitAfter("com.app", -1, 1000))?.key).toBe("a");
    const waiting = store.awaitAfter("com.app", 5, 1000);
    timer.advanceTime(20);
    store.record("com.app", identity("b"));
    expect((await waiting)?.key).toBe("b");
  });

  test("a waiter times out, and clear settles waiters with undefined", async () => {
    const timer = new FakeTimer();
    const store = new AndroidSdkScreenIdentityStore(timer);
    const timedOut = store.awaitAfter("com.app", 0, 100);
    timer.advanceTime(100);
    expect(await timedOut).toBeUndefined();
    const cleared = store.awaitAfter("com.app", 0, 100_000);
    store.clear();
    expect(await cleared).toBeUndefined();
    store.record("com.app", identity("c"));
    store.clear("com.app");
    expect(store.get("com.app")).toBeUndefined();
  });
});
