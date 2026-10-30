import { describe, expect, test } from "bun:test";
import { decodePrototypeEvent } from "../../../src/features/observe/android/CtrlProxyPrototypes";
import { PrototypeShownSpecs } from "../../../src/features/prototype/PrototypeShownSpecs";
import { InMemoryPrototypeStatusStore } from "../../../src/features/prototype/PrototypeStatusStore";
import { prototypeDataWriteOf } from "../../../src/features/prototype/prototypeDataWriteEvent";
import { prototypePatchDataPaths } from "../../../src/features/prototype/prototypePatch";
import {
  createPrototypePatchQueue,
  performPrototypePatch,
} from "../../../src/server/prototypePatchAction";
import { FakeTimer } from "../../fakes/FakeTimer";
import { event } from "../../helpers/prototypeTestEvent";

// Data pointers, not file paths: named once so the POSIX path-literal lint reads them as data.
const CART = "/data/cart";
const FIRST_ROW = "/data/cart/0";
const DATA_ROOT = "/data";
const spec = {
  id: "shop",
  window: { placement: { type: "fullscreen" }, opacity: 1 },
  root: { type: "text", id: "label", text: "Hello" },
  data: { cart: [{ sku: "a" }], note: "hi" },
};
function dataWrite(
  sequence: number,
  name: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { ...event(sequence, "shop", "change", name), payload };
}
const written = (name: string, revision: number, op = "set", value: unknown = 1) =>
  op === "remove" ? { op, revision } : { op, value, revision };

function tracked() {
  const shown = new PrototypeShownSpecs();
  shown.endShow("d", shown.beginShow("d"), { id: "shop", spec });
  return shown;
}
const dataOf = (shown: PrototypeShownSpecs) => {
  const read = shown.read("d", "shop");
  return read.kind === "known" ? read.spec.data : undefined;
};

describe("data write change events", () => {
  test("decode with a pointer name and a payload, without validity", () => {
    const wire = dataWrite(1, "/data/cart", written("/data/cart", 4, "append", { sku: "b" }));
    const decoded = decodePrototypeEvent(wire, "test");
    expect<unknown>(decoded).toEqual(wire);
    expect(prototypeDataWriteOf(decoded!)).toEqual({
      path: "/data/cart",
      op: "append",
      value: { sku: "b" },
      revision: 4,
    });
  });
  test("a remove carries no value", () => {
    const wire = dataWrite(1, "/data/cart/0", written("/data/cart/0", 5, "remove"));
    expect(prototypeDataWriteOf(decodePrototypeEvent(wire, "test")!)).toEqual({
      path: "/data/cart/0",
      op: "remove",
      revision: 5,
    });
  });
  test.each([
    { op: "set", value: 1 },
    { op: "swap", value: 1, revision: 1 },
    { op: "set", value: 1, revision: -1 },
    { op: "remove", value: 1, revision: 1 },
    "set",
  ])("a data-path change with payload %j is dropped", (payload) => {
    const wire = { ...event(1, "shop", "change", "/data/a"), payload };
    expect(decodePrototypeEvent(wire, "test")).toBeUndefined();
  });
  test("an extend whose page did not travel decodes without a value", () => {
    const wire = {
      ...event(1, "shop", "change", "/data/a"),
      payload: { op: "extend", revision: 2 },
    };
    expect(prototypeDataWriteOf(decodePrototypeEvent(wire, "test")!)).toEqual({
      path: "/data/a",
      op: "extend",
      revision: 2,
    });
  });
  test("a validity change is not a data write", () => {
    const wire = { ...event(1, "shop", "change", "email"), validity: { email: true } };
    expect(prototypeDataWriteOf(decodePrototypeEvent(wire, "test")!)).toBeUndefined();
  });
});

describe("the host mirror follows device data writes", () => {
  test("each write is applied with the shared helper and logged", () => {
    const shown = tracked();
    const outcome = shown.recordDeviceDataWrite("d", "shop", {
      path: "/data/cart",
      op: "append",
      value: { sku: "b" },
      revision: 3,
    });
    expect(outcome).toMatchObject({ kind: "mirrored" });
    expect(dataOf(shown)).toEqual({ cart: [{ sku: "a" }, { sku: "b" }], note: "hi" });
    shown.recordDeviceDataWrite("d", "shop", { path: "/data/cart/0", op: "remove", revision: 4 });
    expect(dataOf(shown)).toEqual({ cart: [{ sku: "b" }], note: "hi" });
  });
  test("a write the mirror cannot apply makes the host stop tracking the spec", () => {
    for (const write of [
      { path: "/data/cart", op: "append" as const, revision: 3 },
      { path: "/data/cart", op: "extend" as const, revision: 3 },
      { path: "/data/missing/x", op: "set" as const, value: 1, revision: 3 },
    ]) {
      const shown = tracked();
      expect(shown.recordDeviceDataWrite("d", "shop", write)).toEqual({ kind: "dropped" });
      expect(shown.read("d", "shop")).toEqual({ kind: "unknown" });
    }
  });
  test("a write during a show cannot be ordered against it", () => {
    const shown = tracked();
    shown.beginShow("d", "shop");
    const outcome = shown.recordDeviceDataWrite("d", "shop", {
      path: "/data/note",
      op: "set",
      value: "x",
      revision: 3,
    });
    expect(outcome).toEqual({ kind: "dropped" });
  });
  test("an untracked prototype or device is left alone", () => {
    const write = { path: "/data/note", op: "set" as const, value: "x", revision: 1 };
    expect(new PrototypeShownSpecs().recordDeviceDataWrite("d", "shop", write)).toEqual({
      kind: "untracked",
    });
    expect(tracked().recordDeviceDataWrite("d", "other", write)).toEqual({ kind: "untracked" });
  });
});

describe("the baseRevision rule for /data patches", () => {
  const writes = (shown: PrototypeShownSpecs, ...entries: [string, number][]) => {
    for (const [path, revision] of entries) {
      shown.recordDeviceDataWrite("d", "shop", { path, op: "set", value: "v", revision });
    }
  };
  const guard = (shown: PrototypeShownSpecs, paths: string[], base?: number) =>
    shown.dataPatchGuard("d", "shop", paths, base);

  test("nothing is required before the device has written data", () => {
    expect(guard(tracked(), ["/data/note"])).toEqual({ kind: "ok" });
  });
  test("after a write, /data ops need a baseRevision; other ops do not", () => {
    const shown = tracked();
    writes(shown, ["/data/note", 3]);
    expect(guard(shown, ["/data/other"])).toEqual({ kind: "baseRevisionRequired" });
    expect(guard(shown, [])).toEqual({ kind: "ok" });
  });
  test("a newer overlapping write conflicts; older or disjoint ones do not", () => {
    const shown = tracked();
    writes(shown, ["/data/cart/0", 3], ["/data/note", 5]);
    expect(guard(shown, [CART], 2)).toEqual({
      kind: "conflict",
      revision: 5,
      paths: [FIRST_ROW],
    });
    expect(guard(shown, ["/data/cart/0/sku"], 2)).toMatchObject({ kind: "conflict" });
    expect(guard(shown, [DATA_ROOT], 4)).toMatchObject({ kind: "conflict", paths: ["/data/note"] });
    expect(guard(shown, ["/data/cart"], 3)).toEqual({ kind: "ok" });
    expect(guard(shown, ["/data/other"], 0)).toEqual({ kind: "ok" });
  });
  test("a base older than the remembered writes conflicts on every path", () => {
    const shown = tracked();
    for (let revision = 1; revision <= 70; revision++) {
      writes(shown, [`/data/k${revision}`, revision]);
    }
    expect(guard(shown, ["/data/free"], 3)).toMatchObject({
      kind: "conflict",
      revision: 70,
      paths: ["/data/free"],
    });
    expect(guard(shown, ["/data/free"], 6)).toEqual({ kind: "ok" });
  });
  test("a show makes its data authoritative again", () => {
    const shown = tracked();
    writes(shown, ["/data/note", 3]);
    shown.endShow("d", shown.beginShow("d"), { id: "shop", spec });
    expect(guard(shown, ["/data/note"])).toEqual({ kind: "ok" });
  });
});

describe("patch action", () => {
  const timer = new FakeTimer();
  function setup() {
    const store = new InMemoryPrototypeStatusStore(timer);
    store.shownSpecs.endShow("d", store.shownSpecs.beginShow("d"), { id: "shop", spec });
    const sent: unknown[] = [];
    const deps = {
      store,
      transport: {
        patch: async (request: unknown) => {
          sent.push(request);
          return { success: true, delivery: "answered" as const, revision: 9 };
        },
      },
      supportsPatch: async () => true,
      platform: "android" as const,
      queue: createPrototypePatchQueue(),
      retire: () => {},
    };
    return { store, sent, deps };
  }
  const patch = (deps: ReturnType<typeof setup>["deps"], ops: unknown, baseRevision?: number) =>
    performPrototypePatch(deps, "d", { id: "shop", ops, baseRevision });
  const replaceNote = [{ op: "replace", path: "/data/note", value: "patched" }];

  test("without device writes a /data patch needs no baseRevision", async () => {
    const { deps, sent } = setup();
    expect(await patch(deps, replaceNote)).toMatchObject({ success: true, revision: 9 });
    expect(sent).toHaveLength(1);
  });
  test("after a device write the host refuses an unbased or stale /data patch locally", async () => {
    const { deps, sent, store } = setup();
    store.recordEvent(
      { deviceId: "d" },
      decodePrototypeEvent(
        dataWrite(1, "/data/note", written("/data/note", 4, "set", "device")),
        "test",
      )!,
    );
    const unbased = await patch(deps, replaceNote);
    expect(unbased.success).toBe(false);
    expect(unbased.error).toContain("baseRevision");
    const stale = await patch(deps, replaceNote, 3);
    expect(stale).toMatchObject({
      success: false,
      conflict: { revision: 4, state: {}, data: ["/data/note"] },
    });
    expect(stale.error).toContain("/data/note");
    expect(sent).toEqual([]);
    expect(await patch(deps, replaceNote, 4)).toMatchObject({ success: true });
    expect(sent).toHaveLength(1);
  });
  test("a patch on a disjoint path built before the write still applies on the mirror", async () => {
    const { deps, store } = setup();
    store.recordEvent(
      { deviceId: "d" },
      decodePrototypeEvent(
        dataWrite(1, "/data/cart", written("/data/cart", 4, "append", { sku: "b" })),
        "test",
      )!,
    );
    const ops = [{ op: "replace", path: "/data/note", value: "patched" }];
    expect(await patch(deps, ops, 2)).toMatchObject({ success: true });
    const read = store.shownSpecs.read("d", "shop");
    expect(read.kind === "known" && read.spec.data).toEqual({
      cart: [{ sku: "a" }, { sku: "b" }],
      note: "patched",
    });
  });
  test("data paths are read from the ops", () => {
    expect(
      prototypePatchDataPaths([
        { op: "add", path: "/data/a", value: 1 },
        { op: "replace", path: "/state/b", value: 1 },
        { op: "replaceNode", id: "x", node: {} },
        { op: "remove", path: DATA_ROOT },
        "junk",
      ]),
    ).toEqual(["/data/a", DATA_ROOT]);
    expect(prototypePatchDataPaths(undefined)).toEqual([]);
  });
});

test("extend event round trip mirrors trimming and records a conflicting write", () => {
  const shown = tracked();
  const wire = dataWrite(1, CART, {
    op: "extend",
    value: [{ sku: "b" }, { sku: "c" }],
    maxItems: 2,
    revision: 4,
  });
  const decoded = decodePrototypeEvent(wire, "test");
  expect<unknown>(decoded).toEqual(wire);
  const write = prototypeDataWriteOf(decoded!);
  expect(write).toEqual({
    path: CART,
    op: "extend",
    value: [{ sku: "b" }, { sku: "c" }],
    maxItems: 2,
    revision: 4,
  });
  expect(shown.recordDeviceDataWrite("d", "shop", write!)).toEqual({
    kind: "mirrored",
    data: { cart: [{ sku: "b" }, { sku: "c" }], note: "hi" },
  });
  expect(shown.dataPatchGuard("d", "shop", [DATA_ROOT], 3)).toMatchObject({
    kind: "conflict",
    paths: [CART],
  });
});

test.each([
  { op: "extend", value: 1, revision: 1 },
  ...[0, -1, 1.5, "2"].map((maxItems) => ({ op: "append", value: 1, maxItems, revision: 1 })),
])("malformed lazy write is dropped: %j", (payload) => {
  expect(decodePrototypeEvent(dataWrite(1, CART, payload), "test")).toBeUndefined();
});

test("an append event followed by a stale whole-data patch preserves the device write", async () => {
  const store = new InMemoryPrototypeStatusStore(new FakeTimer());
  store.shownSpecs.endShow("d", store.shownSpecs.beginShow("d"), { id: "shop", spec });
  store.recordEvent(
    { deviceId: "d" },
    decodePrototypeEvent(
      dataWrite(1, CART, {
        op: "append",
        value: { sku: "b" },
        maxItems: 1,
        revision: 4,
      }),
      "test",
    )!,
  );
  const sent: unknown[] = [];
  const result = await performPrototypePatch(
    {
      store,
      transport: {
        patch: async (request: unknown) => {
          sent.push(request);
          return { success: true, delivery: "answered" as const, revision: 5 };
        },
      },
      supportsPatch: async () => true,
      platform: "android",
      queue: createPrototypePatchQueue(),
      retire: () => {},
    },
    "d",
    {
      id: "shop",
      baseRevision: 3,
      ops: [{ op: "replace", path: DATA_ROOT, value: { cart: [] } }],
    },
  );
  expect(result).toMatchObject({ success: false, conflict: { revision: 4, data: [CART] } });
  expect(sent).toEqual([]);
  expect(dataOf(store.shownSpecs)).toEqual({ cart: [{ sku: "b" }], note: "hi" });
});

test("status snapshot replays extend and maxItems", () => {
  const store = new InMemoryPrototypeStatusStore(new FakeTimer());
  const scope = { deviceId: "d" };
  store.record(
    scope,
    "show",
    { id: "shop" },
    {
      result: { success: true },
      details: {
        data: { cart: [{ sku: "a" }] },
      },
    },
  );
  store.recordEvent(
    scope,
    decodePrototypeEvent(
      dataWrite(1, CART, { op: "extend", value: [{ sku: "b" }], maxItems: 1, revision: 4 }),
      "test",
    )!,
  );
  expect(store.status(scope).prototypes[0]?.data).toEqual({ cart: [{ sku: "b" }] });
});

test("prepend event round trip mirrors trimming and records a conflicting write", () => {
  const shown = tracked();
  const wire = dataWrite(1, CART, {
    op: "prepend",
    value: [{ sku: "b" }, { sku: "c" }],
    maxItems: 2,
    revision: 4,
  });
  const decoded = decodePrototypeEvent(wire, "test");
  expect<unknown>(decoded).toEqual(wire);
  const write = prototypeDataWriteOf(decoded!);
  expect(write).toEqual({
    path: CART,
    op: "prepend",
    value: [{ sku: "b" }, { sku: "c" }],
    maxItems: 2,
    revision: 4,
  });
  expect(shown.recordDeviceDataWrite("d", "shop", write!)).toEqual({
    kind: "mirrored",
    data: { cart: [{ sku: "b" }, { sku: "c" }], note: "hi" },
  });
  expect(shown.dataPatchGuard("d", "shop", [DATA_ROOT], 3)).toMatchObject({
    kind: "conflict",
    paths: [CART],
  });
});

test.each([
  { op: "prepend", value: 1, revision: 1 },
  ...[0, -1, 1.5, "2"].map((maxItems) => ({ op: "prepend", value: [], maxItems, revision: 1 })),
])("malformed prepend event is dropped: %j", (payload) => {
  expect(decodePrototypeEvent(dataWrite(1, CART, payload), "test")).toBeUndefined();
});
test("prepend event without its page abandons the mirror", () => {
  const shown = tracked();
  const write = prototypeDataWriteOf({
    ...event(1, "shop", "change", CART),
    payload: { op: "prepend", revision: 1 },
  });
  expect(write).toBeDefined();
  expect(shown.recordDeviceDataWrite("d", "shop", write!)).toEqual({ kind: "dropped" });
});

test("status snapshot replays prepend and maxItems", () => {
  const store = new InMemoryPrototypeStatusStore(new FakeTimer());
  const scope = { deviceId: "d" };
  store.record(
    scope,
    "show",
    { id: "shop" },
    {
      result: { success: true },
      details: {
        data: { cart: [{ sku: "a" }] },
      },
    },
  );
  store.recordEvent(
    scope,
    decodePrototypeEvent(
      dataWrite(1, CART, { op: "prepend", value: [{ sku: "b" }], maxItems: 1, revision: 4 }),
      "test",
    )!,
  );
  expect(store.status(scope).prototypes[0]?.data).toEqual({ cart: [{ sku: "b" }] });
});
