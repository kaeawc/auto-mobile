import { describe, expect, test } from "bun:test";
import {
  FORGET_TOMBSTONE_MAX,
  FORGET_TOMBSTONE_TTL_MS,
  SessionToolBindingStore,
} from "../../src/server/sessionToolBindingStore";
import { FakeTimer } from "../fakes/FakeTimer";

function makeStore() {
  const timer = new FakeTimer();
  const store = new SessionToolBindingStore({
    subscribeReleases: () => () => {},
    onBindingChanged: () => {},
    timer,
  });
  return { store, timer };
}

describe("SessionToolBindingStore forget tombstone", () => {
  test("a late bind after forget does not recreate the key", () => {
    const { store } = makeStore();
    store.bind("sock-1", "s1");
    store.forget("sock-1");
    expect(store.bind("sock-1", "s2")).toBe(false);
    expect(store.bindToolSelectionProfile("sock-1", "p1")).toBe(false);
    expect(store.keyCount).toBe(0);
    expect(store.boundSessionUuid("sock-1")).toBeUndefined();
  });

  test("other keys are unaffected", () => {
    const { store } = makeStore();
    store.forget("sock-1");
    expect(store.bind("sock-2", "s1")).toBe(true);
  });

  test("the tombstone expires after the TTL", () => {
    const { store, timer } = makeStore();
    store.forget("k");
    timer.advanceTime(FORGET_TOMBSTONE_TTL_MS + 1);
    expect(store.bind("k", "s1")).toBe(true);
  });

  test("tombstones are bounded: the oldest is evicted past the cap", () => {
    const { store } = makeStore();
    for (let i = 0; i <= FORGET_TOMBSTONE_MAX; i += 1) {
      store.forget(`k${i}`);
    }
    expect(store.bind("k0", "s1")).toBe(true);
    expect(store.bind(`k${FORGET_TOMBSTONE_MAX}`, "s1")).toBe(false);
  });
});
