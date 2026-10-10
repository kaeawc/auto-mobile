import { event } from "../../helpers/prototypeTestEvent";
import { describe, expect, test } from "bun:test";
import { InMemoryPrototypeStatusStore } from "../../../src/features/prototype/PrototypeStatusStore";
import { FakeTimer } from "../../fakes/FakeTimer";

const ok = { success: true };

describe("InMemoryPrototypeStatusStore scope bound", () => {
  test("event snapshots are copied on ingestion and status reads and survive mutation results", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    const scope = { deviceId: "device", sessionUuid: "one" };
    store.record(scope, "show", { id: "panel" }, ok);
    const pushed = { ...event(1), pages: { pager: 2 } };
    store.recordEvent(scope, pushed);
    pushed.pages.pager = 9;
    pushed.state.title = "changed";
    const status = store.status(scope);
    const snapshot = status.prototypes[0];
    expect(snapshot).toMatchObject({
      pages: { pager: 2 },
      state: { title: "Hello" },
      lastKnown: true,
    });
    if (snapshot.pages && snapshot.state) {
      snapshot.pages.pager = 7;
      snapshot.state.title = "caller mutation";
    }
    store.record(scope, "show", { id: "panel" }, { success: false });
    expect(store.status(scope).prototypes[0]).toMatchObject({
      pages: { pager: 2 },
      state: { title: "Hello" },
      lastKnown: true,
    });
    expect(store.status({ ...scope, sessionUuid: "two" })).toEqual({ prototypes: [] });
    store.dismissed(scope, "panel");
    expect(store.status(scope).prototypes).toEqual([]);
    store.record(scope, "show", { id: "panel" }, ok);
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("lastKnown");
  });

  test("snapshots before a show are bounded without inventing mutation results", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer(), 1);
    const scope = { deviceId: "device", sessionUuid: "one" };
    store.recordEvent(scope, event(1));
    expect(store.status(scope)).toEqual({ prototypes: [] });
    store.recordEvent({ deviceId: "other" }, event(2));
    store.record(scope, "show", { id: "panel" }, ok);
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("lastKnown");
  });

  test("evicts the least recently recorded scope past the cap", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer(), 2);
    for (const session of ["a", "b", "c"]) {
      store.record(
        { sessionUuid: session, deviceId: `dev-${session}` },
        "show",
        { id: session },
        ok,
      );
    }
    expect(store.status({ sessionUuid: "a", deviceId: "dev-a" }).prototypes).toEqual([]);
    expect(store.status({ sessionUuid: "b", deviceId: "dev-b" }).prototypes).toHaveLength(1);
    expect(store.status({ sessionUuid: "c", deviceId: "dev-c" }).prototypes).toHaveLength(1);
  });

  test("recording refreshes recency so an active scope survives eviction", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer(), 2);
    store.record({ sessionUuid: "a", deviceId: "dev-a" }, "show", { id: "a" }, ok);
    store.record({ sessionUuid: "b", deviceId: "dev-b" }, "show", { id: "b" }, ok);
    store.record({ sessionUuid: "a", deviceId: "dev-a" }, "show", { id: "a" }, ok);
    store.record({ sessionUuid: "c", deviceId: "dev-c" }, "show", { id: "c" }, ok);
    expect(store.status({ sessionUuid: "a", deviceId: "dev-a" }).prototypes).toHaveLength(1);
    expect(store.status({ sessionUuid: "b", deviceId: "dev-b" }).prototypes).toEqual([]);
  });

  test("below the cap nothing is evicted and release still clears the device", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    store.record({ sessionUuid: "a", deviceId: "dev" }, "show", { id: "a" }, ok);
    store.record({ sessionUuid: "b", deviceId: "dev" }, "dismiss", { id: "x" }, ok);
    expect(store.status({ sessionUuid: "b", deviceId: "dev" }).lastResult?.lastAction).toBe(
      "dismiss",
    );
    store.clearSession("a");
    expect(store.status({ sessionUuid: "b", deviceId: "dev" })).toEqual({ prototypes: [] });
  });

  test("adopt takes the device report as presence and last known pages and state", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    const scope = { deviceId: "dev", sessionUuid: "new" };
    store.adopt(scope, { id: "panel", pages: { pager: 1 }, state: { title: "typed" } });
    expect(store.status(scope).prototypes).toMatchObject([
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
    // The device holds one prototype: a different report replaces the earlier presence.
    store.adopt(scope, { id: "other", pages: {}, state: {} });
    expect(store.status(scope).prototypes.map((entry) => entry.id)).toEqual(["other"]);
    store.dismissed(scope, "other");
    expect(store.status(scope).prototypes).toEqual([]);
  });
});

describe("InMemoryPrototypeStatusStore suspended", () => {
  test("adopt records suspended only when true, and a fresh show clears it", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    const scope = { deviceId: "dev" };
    store.adopt(scope, { id: "panel", suspended: true, pages: {}, state: {} });
    expect(store.status(scope).prototypes[0]?.suspended).toBe(true);
    store.adopt(scope, { id: "panel", suspended: false, pages: {}, state: {} });
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("suspended");
    store.adopt(scope, { id: "panel", suspended: true, pages: {}, state: {} });
    store.record(scope, "show", { id: "panel" }, ok);
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("suspended");
  });
});

describe("InMemoryPrototypeStatusStore appearance", () => {
  const scope = { deviceId: "dev" };
  const light = { mode: "light", source: "system", deviceDark: false } as const;
  const change = (sequence: number, payload: Record<string, string>) => ({
    ...event(sequence, "panel", "appearance_changed"),
    name: null,
    payload,
  });

  test("a successful show and an adopt cache the reported appearance; absence stays absent", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    expect(store.record(scope, "show", { id: "panel" }, ok)).not.toHaveProperty("appearance");
    const shown = store.record(scope, "show", { id: "panel" }, { ...ok, appearance: light });
    expect(shown.appearance).toEqual(light);
    expect(store.status(scope).prototypes[0]?.appearance).toEqual(light);
    store.adopt(scope, { id: "panel", pages: {}, state: {} });
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("appearance");
    store.adopt(scope, { id: "panel", appearance: light, pages: {}, state: {} });
    expect(store.status(scope).prototypes[0]?.appearance).toEqual(light);
  });

  test("a failed show or dismiss never reports one and keeps the shown prototype's", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    store.record(scope, "show", { id: "panel" }, { ...ok, appearance: light });
    const failed = { success: false, appearance: { ...light, mode: "dark" as const } };
    expect(store.record(scope, "show", { id: "panel" }, failed)).not.toHaveProperty("appearance");
    expect(store.record(scope, "dismiss", { id: "panel" }, failed)).not.toHaveProperty(
      "appearance",
    );
    expect(store.status(scope).prototypes[0]?.appearance).toEqual(light);
    const dismissed = store.record(scope, "dismiss", { id: "panel" }, { ...ok, appearance: light });
    expect(dismissed).not.toHaveProperty("appearance");
  });

  test("appearance_changed refreshes the shown entry: system follows the device, others keep deviceDark", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    store.record(scope, "show", { id: "panel" }, { ...ok, appearance: light });
    store.recordEvent(scope, change(1, { mode: "dark", source: "system" }));
    expect(store.status(scope).prototypes[0]?.appearance).toEqual({
      mode: "dark",
      source: "system",
      deviceDark: true,
    });
    store.recordEvent(scope, change(2, { mode: "light", source: "authoredBackground" }));
    expect(store.status(scope).prototypes[0]?.appearance).toEqual({
      mode: "light",
      source: "authoredBackground",
      deviceDark: true,
    });
    // The record of the show itself is not rewritten.
    expect(store.status(scope).lastResult?.appearance).toEqual(light);
  });

  test("appearance_changed never invents a deviceDark, and ignores an unshown id or a bad payload", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    store.recordEvent(scope, change(1, { mode: "dark", source: "system" }));
    expect(store.status(scope).prototypes).toEqual([]);
    store.record(scope, "show", { id: "panel" }, ok);
    store.recordEvent(scope, change(2, { mode: "dark", source: "override" }));
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("appearance");
    store.recordEvent(scope, change(3, { mode: "sepia", source: "system" }));
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("appearance");
    // A system-sourced change states the device's setting by itself.
    store.recordEvent(scope, change(4, { mode: "light", source: "system" }));
    expect(store.status(scope).prototypes[0]?.appearance).toEqual(light);
  });
});

describe("InMemoryPrototypeStatusStore.shownOnDevice", () => {
  test("finds a shown prototype from any session on that device only, as a copy", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    store.record({ sessionUuid: "a", deviceId: "dev" }, "show", { id: "panel" }, ok, 2);
    expect(store.shownOnDevice("dev", "panel")?.displayId).toBe(2);
    expect(store.shownOnDevice("other", "panel")).toBeUndefined();
    expect(store.shownOnDevice("dev", "missing")).toBeUndefined();
    store.dismissed({ sessionUuid: "b", deviceId: "dev" }, "panel");
    expect(store.shownOnDevice("dev", "panel")).toBeUndefined();
  });
});
