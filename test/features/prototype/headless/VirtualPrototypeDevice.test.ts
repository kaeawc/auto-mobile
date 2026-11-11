import { describe, expect, test } from "bun:test";
import type { PrototypeEvent } from "../../../../src/features/observe/android/ctrlProxyProtocol";
import { VirtualPrototypeDevice } from "../../../../src/features/prototype/headless/VirtualPrototypeDevice";
import {
  prototypeSpecSchema,
  type PrototypeSpec,
} from "../../../../src/features/prototype/prototypeSpec";
import { FakeTimer } from "../../../fakes/FakeTimer";

const spec = (id: string, extra: Record<string, unknown> = {}): PrototypeSpec =>
  prototypeSpecSchema.parse({
    id,
    window: { placement: { type: "fullscreen" } },
    state: { count: 1, label: "a" },
    root: { type: "text", text: "Hello" },
    ...extra,
  });

function device() {
  const timer = new FakeTimer();
  timer.setCurrentTime(5000);
  return new VirtualPrototypeDevice(timer);
}

describe("VirtualPrototypeDevice (#17974)", () => {
  test("advertises emulated capabilities and refuses device-only ones", async () => {
    const virtual = device();
    expect(await virtual.supportsCommand("prototype_patch_v1")).toBe(true);
    expect(await virtual.supportsCommand("prototype_persistence_replay_v1")).toBe(true);
    expect(await virtual.supportsCommand("prototype_window_options_v1")).toBe(false);
    expect(await virtual.supportsCommand("prototype_timers_v1")).toBe(false);
  });

  test("show holds the spec's state and inspect reports it", async () => {
    const virtual = device();
    const shown = await virtual.requestShowPrototype(spec("one", { data: { items: [1] } }));
    expect(shown).toMatchObject({ success: true, timestamp: 5000 });
    const inspected = await virtual.requestInspectPrototypes();
    expect(inspected.prototypes).toEqual([
      {
        id: "one",
        persistent: false,
        state: { count: 1, label: "a" },
        pages: {},
        lastSequence: 0,
        data: { items: [1] },
      },
    ]);
  });

  const pager = (pageCount: number, extra: Record<string, unknown> = {}) => ({
    root: {
      type: "pager",
      id: "tabs",
      children: Array.from({ length: pageCount }, (_, index) => ({
        type: "text",
        text: `Page ${index}`,
      })),
      ...extra,
    },
  });

  test("show derives a state-bound pager's position from the spec", async () => {
    const virtual = device();
    await virtual.requestShowPrototype(
      spec("one", { state: { page: 1 }, ...pager(2, { stateKey: "page" }) }),
    );
    const inspected = await virtual.requestInspectPrototypes();
    expect(inspected.prototypes?.[0]?.pages).toEqual({ tabs: 1 });
  });

  test("a same-id show clamps a retained pager position to the new page count", async () => {
    const virtual = device();
    await virtual.requestShowPrototype(spec("one", pager(2)));
    virtual.dispatch({ id: "one", kind: "page_changed", name: "tabs", pages: { tabs: 1 } });
    await virtual.requestShowPrototype(spec("one", pager(1)));
    const inspected = await virtual.requestInspectPrototypes();
    expect(inspected.prototypes?.[0]?.pages).toEqual({ tabs: 0 });
  });

  test("a show replaces other prototypes unless replaceOthers is false", async () => {
    const virtual = device();
    await virtual.requestShowPrototype(spec("one"));
    await virtual.requestShowPrototype(spec("two"), undefined, undefined, { replaceOthers: false });
    expect(virtual.shownIds()).toEqual(["one", "two"]);
    await virtual.requestShowPrototype(spec("three"));
    expect(virtual.shownIds()).toEqual(["three"]);
  });

  test("dispatch pushes a prototype_event with merged state and rising sequences", async () => {
    const virtual = device();
    await virtual.requestShowPrototype(spec("one"));
    const events: PrototypeEvent[] = [];
    const stop = virtual.onPrototypeEvent((event) => events.push(event));
    expect(virtual.dispatch({ id: "one", kind: "emit", name: "tapped" })).toBe(true);
    expect(
      virtual.dispatch({
        id: "one",
        kind: "change",
        name: "change",
        payload: { key: "label", value: "b" },
        state: { label: "b" },
      }),
    ).toBe(true);
    stop();
    virtual.dispatch({ id: "one", kind: "emit", name: "unheard" });
    expect(events.map((event) => [event.sequence, event.kind, event.name])).toEqual([
      [1, "emit", "tapped"],
      [2, "change", "change"],
    ]);
    expect(events[1].state).toEqual({ count: 1, label: "b" });
    expect(events[0].payload).toBeNull();
    expect(virtual.dispatch({ id: "missing", kind: "emit", name: "x" })).toBe(false);
  });

  test("sequences never rewind across a same-id show", async () => {
    const virtual = device();
    await virtual.requestShowPrototype(spec("one"));
    virtual.dispatch({ id: "one", kind: "emit", name: "a" });
    await virtual.requestShowPrototype(spec("one"), undefined, undefined, { reset: true });
    expect((await virtual.requestInspectPrototypes()).prototypes?.[0].lastSequence).toBe(1);
  });

  test("patch applies ops, raises the revision, and a stale /state patch conflicts", async () => {
    const virtual = device();
    await virtual.requestShowPrototype(spec("one"));
    const patched = await virtual.requestPatchPrototype({
      id: "one",
      baseRevision: 1,
      ops: [{ op: "replace", path: "/state/count", value: 2 }],
    });
    expect(patched).toMatchObject({ success: true, delivery: "answered", revision: 2 });
    virtual.dispatch({ id: "one", kind: "change", name: "change", state: { count: 7 } });
    const stale = await virtual.requestPatchPrototype({
      id: "one",
      baseRevision: 2,
      ops: [{ op: "replace", path: "/state/count", value: 3 }],
    });
    expect(stale.success).toBe(false);
    expect(stale.conflict).toEqual({ revision: 3, state: { count: 7 } });
    const inspected = await virtual.requestInspectPrototypes();
    expect(inspected.prototypes?.[0].state).toEqual({ count: 7, label: "a" });
  });

  test("a second host patch of a key from the same baseRevision conflicts", async () => {
    const virtual = device();
    await virtual.requestShowPrototype(spec("one"));
    const replace = (value: number, baseRevision: number) =>
      virtual.requestPatchPrototype({
        id: "one",
        baseRevision,
        ops: [{ op: "replace", path: "/state/count", value }],
      });
    expect(await replace(2, 1)).toMatchObject({ success: true, revision: 2 });
    expect((await replace(3, 1)).conflict).toEqual({ revision: 2, state: { count: 2 } });
    const other = await virtual.requestPatchPrototype({
      id: "one",
      baseRevision: 1,
      ops: [{ op: "replace", path: "/state/label", value: "b" }],
    });
    expect(other).toMatchObject({ success: true, revision: 3 });
    expect((await replace(4, 3)).success).toBe(true);
  });

  test("a /state patch needs a baseRevision no newer than the device's", async () => {
    const virtual = device();
    await virtual.requestShowPrototype(spec("one"));
    const ops = [{ op: "replace" as const, path: "/state/count", value: 2 }];
    expect((await virtual.requestPatchPrototype({ id: "one", ops })).error).toContain(
      "baseRevision is required",
    );
    expect(
      (await virtual.requestPatchPrototype({ id: "one", baseRevision: 9, ops })).error,
    ).toContain("newer than the device revision 1");
  });

  test("an invalid patch or an unknown id is answered with an error", async () => {
    const virtual = device();
    expect(
      (await virtual.requestPatchPrototype({ id: "x", ops: [{ op: "remove", path: "/data/a" }] }))
        .error,
    ).toContain("No prototype with id x");
    await virtual.requestShowPrototype(spec("one"));
    const invalid = await virtual.requestPatchPrototype({
      id: "one",
      baseRevision: 1,
      ops: [{ op: "replace", path: "/state/missing", value: 1 }],
    });
    expect(invalid).toMatchObject({ success: false, delivery: "answered" });
    expect(invalid.error).toContain("Path does not exist");
  });

  test("dismiss removes one id or all", async () => {
    const virtual = device();
    await virtual.requestShowPrototype(spec("one"));
    await virtual.requestShowPrototype(spec("two"), undefined, undefined, { replaceOthers: false });
    await virtual.requestDismissPrototype({ id: "one" });
    expect(virtual.shownIds()).toEqual(["two"]);
    await virtual.requestDismissPrototype({ all: true });
    expect(virtual.shownIds()).toEqual([]);
  });

  test("referenced assets that were never uploaded are reported missing", async () => {
    const virtual = device();
    const withImage = spec("one", { root: { type: "image", asset: "logo" } });
    expect((await virtual.requestShowPrototype(withImage)).missingAssets).toEqual(["logo"]);
    const put = await virtual.requestPutPrototypeAsset({
      id: "logo",
      mimeType: "image/png",
      bytes: new Uint8Array([1]),
    });
    expect(put).toMatchObject({ success: true, dispatched: true, acknowledged: true });
    expect((await virtual.requestShowPrototype(withImage)).missingAssets).toBeUndefined();
  });

  test("saved prototypes are refused", async () => {
    const virtual = device();
    expect((await virtual.requestListSavedPrototypes()).success).toBe(false);
  });
});
