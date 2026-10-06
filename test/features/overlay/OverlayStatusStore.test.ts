import { describe, expect, test } from "bun:test";
import { InMemoryOverlayStatusStore } from "../../../src/features/overlay/OverlayStatusStore";
import { FakeTimer } from "../../fakes/FakeTimer";

const ok = { success: true };

describe("InMemoryOverlayStatusStore scope bound", () => {
  test("evicts the least recently recorded scope past the cap", () => {
    const store = new InMemoryOverlayStatusStore(new FakeTimer(), 2);
    for (const session of ["a", "b", "c"]) {
      store.record(
        { sessionUuid: session, deviceId: `dev-${session}` },
        "show",
        { id: session },
        ok,
      );
    }
    expect(store.status({ sessionUuid: "a", deviceId: "dev-a" }).overlays).toEqual([]);
    expect(store.status({ sessionUuid: "b", deviceId: "dev-b" }).overlays).toHaveLength(1);
    expect(store.status({ sessionUuid: "c", deviceId: "dev-c" }).overlays).toHaveLength(1);
  });

  test("recording refreshes recency so an active scope survives eviction", () => {
    const store = new InMemoryOverlayStatusStore(new FakeTimer(), 2);
    store.record({ sessionUuid: "a", deviceId: "dev-a" }, "show", { id: "a" }, ok);
    store.record({ sessionUuid: "b", deviceId: "dev-b" }, "show", { id: "b" }, ok);
    store.record({ sessionUuid: "a", deviceId: "dev-a" }, "update", { id: "a" }, ok);
    store.record({ sessionUuid: "c", deviceId: "dev-c" }, "show", { id: "c" }, ok);
    expect(store.status({ sessionUuid: "a", deviceId: "dev-a" }).overlays).toHaveLength(1);
    expect(store.status({ sessionUuid: "b", deviceId: "dev-b" }).overlays).toEqual([]);
  });

  test("below the cap nothing is evicted and release still clears the device", () => {
    const store = new InMemoryOverlayStatusStore(new FakeTimer());
    store.record({ sessionUuid: "a", deviceId: "dev" }, "show", { id: "a" }, ok);
    store.record({ sessionUuid: "b", deviceId: "dev" }, "dismiss", { id: "x" }, ok);
    expect(store.status({ sessionUuid: "b", deviceId: "dev" }).lastResult?.lastAction).toBe(
      "dismiss",
    );
    store.clearSession("a");
    expect(store.status({ sessionUuid: "b", deviceId: "dev" })).toEqual({ overlays: [] });
  });
});
