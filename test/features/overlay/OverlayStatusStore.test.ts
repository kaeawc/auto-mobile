import { event } from "../../helpers/overlayTestEvent";
import { describe, expect, test } from "bun:test";
import { InMemoryOverlayStatusStore } from "../../../src/features/overlay/OverlayStatusStore";
import { FakeTimer } from "../../fakes/FakeTimer";

const ok = { success: true };

describe("InMemoryOverlayStatusStore scope bound", () => {
  test("event snapshots are copied on ingestion and status reads and survive mutation results", () => {
    const store = new InMemoryOverlayStatusStore(new FakeTimer());
    const scope = { deviceId: "device", sessionUuid: "one" };
    store.record(scope, "show", { id: "panel" }, ok);
    const pushed = { ...event(1), pages: { pager: 2 } };
    store.recordEvent(scope, pushed);
    pushed.pages.pager = 9;
    pushed.state.title = "changed";
    const status = store.status(scope);
    const snapshot = status.overlays[0];
    expect(snapshot).toMatchObject({
      pages: { pager: 2 },
      state: { title: "Hello" },
      lastKnown: true,
    });
    if (snapshot.pages && snapshot.state) {
      snapshot.pages.pager = 7;
      snapshot.state.title = "caller mutation";
    }
    store.record(scope, "update", { id: "panel" }, { success: false });
    expect(store.status(scope).overlays[0]).toMatchObject({
      pages: { pager: 2 },
      state: { title: "Hello" },
      lastKnown: true,
    });
    expect(store.status({ ...scope, sessionUuid: "two" })).toEqual({ overlays: [] });
    store.dismissed(scope, "panel");
    expect(store.status(scope).overlays).toEqual([]);
    store.record(scope, "show", { id: "panel" }, ok);
    expect(store.status(scope).overlays[0]).not.toHaveProperty("lastKnown");
  });

  test("snapshots before a show are bounded without inventing mutation results", () => {
    const store = new InMemoryOverlayStatusStore(new FakeTimer(), 1);
    const scope = { deviceId: "device", sessionUuid: "one" };
    store.recordEvent(scope, event(1));
    expect(store.status(scope)).toEqual({ overlays: [] });
    store.recordEvent({ deviceId: "other" }, event(2));
    store.record(scope, "show", { id: "panel" }, ok);
    expect(store.status(scope).overlays[0]).not.toHaveProperty("lastKnown");
  });

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

  test("adopt takes the device report as presence and last known pages and state", () => {
    const store = new InMemoryOverlayStatusStore(new FakeTimer());
    const scope = { deviceId: "dev", sessionUuid: "new" };
    store.adopt(scope, { id: "panel", pages: { pager: 1 }, state: { title: "typed" } });
    expect(store.status(scope).overlays).toMatchObject([
      {
        id: "panel",
        adopted: true,
        lastAction: "show",
        success: true,
        pages: { pager: 1 },
        state: { title: "typed" },
        lastKnown: true,
      },
    ]);
    // The device holds one overlay: a different report replaces the earlier presence.
    store.adopt(scope, { id: "other", pages: {}, state: {} });
    expect(store.status(scope).overlays.map((entry) => entry.id)).toEqual(["other"]);
    store.dismissed(scope, "other");
    expect(store.status(scope).overlays).toEqual([]);
  });
});
