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

describe("InMemoryPrototypeStatusStore failed mutations", () => {
  test("a failed show or dismiss leaves the shown prototype's flags and snapshot intact (#11394)", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    const scope = { deviceId: "dev" };
    store.adopt(scope, {
      id: "panel",
      persistent: true,
      suspended: true,
      pages: { pager: 1 },
      state: { title: "typed" },
    });
    const failed = { success: false, error: "boom" };
    const shown = store.record(scope, "show", { id: "panel" }, failed);
    store.record(scope, "dismiss", { id: "panel" }, failed);
    expect(shown).toMatchObject({ success: false, error: "boom" });
    expect(store.status(scope).prototypes).toMatchObject([
      {
        id: "panel",
        adopted: true,
        persistent: true,
        suspended: true,
        success: true,
        pages: { pager: 1 },
        lastKnown: true,
      },
    ]);
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("error");
    expect(store.status(scope).lastResult).toMatchObject({ success: false, error: "boom" });
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

  test("a crossing show separates presence from its result and consumes the marker", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    store.beginShowDispatch(scope.deviceId, "panel");
    store.recordEvent(scope, change(1, { mode: "dark", source: "system" }));
    const result = store.record(scope, "show", { id: "panel" }, { ...ok, appearance: light });
    expect(result.appearance).toEqual(light);
    expect(store.status(scope).lastResult?.appearance).toEqual(light);
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("appearance");
    store.record(scope, "show", { id: "panel" }, { ...ok, appearance: light });
    expect(store.status(scope).prototypes[0]?.appearance).toEqual(light);
  });

  test("a host-refused sibling leaves the in-flight show's crossing marker intact", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    store.beginShowDispatch(scope.deviceId, "panel");
    store.record(scope, "show", { id: "panel" }, { success: false, error: "refused" });
    store.recordEvent(scope, change(1, { mode: "dark", source: "system" }));
    const result = store.record(scope, "show", { id: "panel" }, { ...ok, appearance: light });
    expect(result.appearance).toEqual(light);
    expect(store.status(scope).lastResult?.appearance).toEqual(light);
    expect(store.status(scope).prototypes[0]).not.toHaveProperty("appearance");
  });

  test.each(["same", "other-id", "other-device"])(
    "dispatch crossings are device/id keyed across sessions: %s",
    (crossing) => {
      const store = new InMemoryPrototypeStatusStore(new FakeTimer());
      const showing = { ...scope, sessionUuid: "b" };
      store.beginShowDispatch(scope.deviceId, "panel");
      store.recordEvent(
        { deviceId: crossing === "other-device" ? "other" : scope.deviceId, sessionUuid: "a" },
        {
          ...change(1, { mode: "dark", source: "system" }),
          id: crossing === "other-id" ? "other" : "panel",
        },
      );
      store.startShow(showing);
      store.record(showing, "show", { id: "panel" }, { ...ok, appearance: light });
      if (crossing === "same") {
        expect(store.status(showing).prototypes[0]).not.toHaveProperty("appearance");
      } else {
        expect(store.status(showing).prototypes[0]?.appearance).toEqual(light);
      }
    },
  );

  test.each(["device", "session"])("clear %s drops an armed crossed marker", (clear) => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    const owned = { ...scope, sessionUuid: "a" };
    store.record(owned, "show", { id: "panel" }, ok);
    store.beginShowDispatch(scope.deviceId, "panel");
    store.recordEvent(owned, change(1, { mode: "dark", source: "system" }));
    if (clear === "device") {
      store.clearDevice(scope.deviceId);
    } else {
      store.clearSession("a");
    }
    store.record(owned, "show", { id: "panel" }, { ...ok, appearance: light });
    expect(store.status(owned).prototypes[0]?.appearance).toEqual(light);
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

  test("appearance_changed updates mode and source and drops deviceDark until a device result", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    store.record(scope, "show", { id: "panel" }, { ...ok, appearance: light });
    store.recordEvent(scope, change(1, { mode: "dark", source: "system" }));
    expect(store.status(scope).prototypes[0]?.appearance).toEqual({
      mode: "dark",
      source: "system",
    });
    store.recordEvent(scope, change(2, { mode: "light", source: "authoredBackground" }));
    expect(store.status(scope).prototypes[0]?.appearance).toEqual({
      mode: "light",
      source: "authoredBackground",
    });
    // A device result supplies it again.
    store.adopt(scope, { id: "panel", appearance: light, pages: {}, state: {} });
    expect(store.status(scope).prototypes[0]?.appearance).toEqual(light);
    // The record of the show itself is not rewritten.
    expect(store.status(scope).lastResult?.appearance).toEqual(light);
  });

  test("appearance_changed never invents a deviceDark, and ignores an unshown id or a bad payload", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    store.recordEvent(scope, change(1, { mode: "dark", source: "system" }));
    expect(store.status(scope).prototypes).toEqual([]);
    store.record(scope, "show", { id: "panel" }, ok);
    store.recordEvent(scope, change(2, { mode: "dark", source: "override" }));
    expect(store.status(scope).prototypes[0]?.appearance).toEqual({
      mode: "dark",
      source: "override",
    });
    store.recordEvent(scope, change(3, { mode: "sepia", source: "system" }));
    expect(store.status(scope).prototypes[0]?.appearance).toEqual({
      mode: "dark",
      source: "override",
    });
    // Even a system-sourced change does not state the device's setting by itself.
    store.recordEvent(scope, change(4, { mode: "light", source: "system" }));
    expect(store.status(scope).prototypes[0]?.appearance).not.toHaveProperty("deviceDark");
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

test("data is copied on show, adoption and every read, preserved on failure, and cleared on replacement", () => {
  const store = new InMemoryPrototypeStatusStore(new FakeTimer());
  const scope = { deviceId: "data-device" };
  const data = { orders: [{ title: "Latte" }] };
  store.record(scope, "show", { id: "orders" }, ok, undefined, { data });
  data.orders[0].title = "external";
  const status = store.status(scope);
  expect(status.prototypes[0].data).toEqual({ orders: [{ title: "Latte" }] });
  if (status.prototypes[0].data) {
    status.prototypes[0].data.orders = [];
  }
  const shown = store.shownOnDevice(scope.deviceId, "orders");
  if (shown?.data) {
    shown.data.orders = [];
  }
  expect(store.status(scope).prototypes[0].data).toEqual({ orders: [{ title: "Latte" }] });
  store.record(scope, "show", { id: "orders" }, { success: false }, undefined, {
    data: { orders: [] },
  });
  expect(store.status(scope).prototypes[0].data).toEqual({ orders: [{ title: "Latte" }] });
  store.adopt(scope, { id: "orders", data, pages: {}, state: {} });
  data.orders[0].title = "changed again";
  expect(store.status(scope).prototypes[0].data).toEqual({ orders: [{ title: "external" }] });
  store.adopt(scope, { id: "orders", pages: {}, state: {} });
  expect(store.status(scope).prototypes[0]).not.toHaveProperty("data");
  store.record(scope, "show", { id: "orders" }, ok, undefined, { data });
  store.record(scope, "show", { id: "orders" }, ok);
  expect(store.status(scope).prototypes[0]).not.toHaveProperty("data");
  store.record(scope, "show", { id: "orders" }, ok, undefined, { data });
  store.record(scope, "dismiss", { id: "orders" }, ok);
  expect(store.status(scope).prototypes).toEqual([]);
});

describe("patch spec and data hooks", () => {
  const scope = { deviceId: "device", sessionUuid: "one" };
  function track(store: InMemoryPrototypeStatusStore) {
    const ticket = store.shownSpecs.beginShow(scope.deviceId);
    store.shownSpecs.endShow(scope.deviceId, ticket, { id: "panel", spec: { data: { count: 1 } } });
    store.record(scope, "show", { id: "panel" }, ok, undefined, { data: { count: 1 } });
  }
  test("patched data refreshes every session without touching results or snapshots", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    track(store);
    const other = { ...scope, sessionUuid: "two" };
    store.adopt(other, { id: "panel", pages: {}, state: { title: "Hello" } });
    store.recordEvent(other, { ...event(1), id: "panel" });
    const before = store.status(other);
    const data = { count: 2 };
    store.recordPatchedData("device", "panel", data);
    data.count = 99;
    expect(store.status(other).prototypes[0]).toEqual({
      ...before.prototypes[0],
      data: { count: 2 },
    });
    expect(store.status(other).lastResult).toEqual(before.lastResult);
    store.recordPatchedData("device", "panel", undefined);
    expect(store.status(other)).toEqual(before);
    // Insert another session presence through the public show path, then prove device/id filtering.
    store.record(scope, "show", { id: "panel" }, ok, undefined, { data: { count: 1 } });
    store.recordPatchedData("device", "other", { count: 3 });
    expect(store.status(scope).prototypes[0].data).toEqual({ count: 1 });
  });
  test.each(["dismissed", "dismiss", "all", "clearDevice", "clearSession", "adopt"])(
    "%s removes tracked specs",
    (hook) => {
      const store = new InMemoryPrototypeStatusStore(new FakeTimer());
      track(store);
      if (hook === "dismissed") {
        store.dismissed(scope, "panel");
      }
      if (hook === "dismiss") {
        store.record(scope, "dismiss", { id: "panel" }, ok);
      }
      if (hook === "all") {
        store.record(scope, "dismiss", { all: true }, ok);
      }
      if (hook === "clearDevice") {
        store.clearDevice("device");
      }
      if (hook === "clearSession") {
        store.clearSession("one");
      }
      if (hook === "adopt") {
        store.adopt(scope, { id: "other", pages: {}, state: {} });
      }
      expect(store.shownSpecs.read("device", "panel")).toEqual({ kind: "unknown" });
    },
  );
  test("failed dismiss, wrong-id dismissal and same-id adoption retain the spec", () => {
    const store = new InMemoryPrototypeStatusStore(new FakeTimer());
    track(store);
    store.record(scope, "dismiss", { id: "panel" }, { success: false });
    store.dismissed(scope, "other");
    store.adopt(scope, { id: "panel", pages: {}, state: {} });
    expect(store.shownSpecs.read("device", "panel").kind).toBe("known");
  });
});

test("stack snapshots are copied through events, pending shows and inspect adoption", () => {
  const store = new InMemoryPrototypeStatusStore(new FakeTimer());
  const scope = { deviceId: "stacks" };
  const stacks = { nav: { path: ["home", "detail"], depth: 2 } };
  store.recordEvent(scope, { ...event(1), stacks });
  store.record(scope, "show", { id: "panel" }, ok);
  stacks.nav.path[0] = "mutated";
  expect(store.status(scope).prototypes[0].stacks).toEqual({
    nav: { path: ["home", "detail"], depth: 2 },
  });
  store.status(scope).prototypes[0].stacks!.nav.path.push("caller");
  expect(store.status(scope).prototypes[0].stacks!.nav.path).toHaveLength(2);
  store.adopt(scope, {
    id: "panel",
    pages: {},
    state: {},
    stacks: { nav: { path: ["home"], depth: 1 } },
  });
  expect(store.status(scope).prototypes[0].stacks).toEqual({ nav: { path: ["home"], depth: 1 } });
  store.adopt(scope, { id: "panel", pages: {}, state: {} });
  expect(store.status(scope).prototypes[0]).not.toHaveProperty("stacks");
});

test("show snapshots expose initial stacks until a device snapshot supersedes them", () => {
  const store = new InMemoryPrototypeStatusStore(new FakeTimer());
  const scope = { deviceId: "initial-stacks" };
  const stacks = { nav: { path: ["home"], depth: 1 } };
  store.record(scope, "show", { id: "panel" }, { success: true, stacks });
  stacks.nav.path[0] = "caller";
  expect(store.status(scope).prototypes[0].stacks).toEqual({ nav: { path: ["home"], depth: 1 } });
  store.recordEvent(scope, event(1));
  expect(store.status(scope).prototypes[0]).not.toHaveProperty("stacks");
});
