import { describe, expect, test } from "bun:test";
import { PrototypeShownSpecs } from "../../../src/features/prototype/PrototypeShownSpecs";

const spec = { data: { count: 1 } };
function shown(store: PrototypeShownSpecs, device = "d", id = "panel") {
  const ticket = store.beginShow(device);
  store.endShow(device, ticket, { id, spec });
  const read = store.read(device, id);
  expect(read.kind).toBe("known");
  if (read.kind !== "known") {
    throw new Error("Expected tracked spec");
  }
  return read;
}
describe("PrototypeShownSpecs", () => {
  test.each([false, true])("overlapping additive ids both commit (reverse: %s)", (reverse) => {
    const store = new PrototypeShownSpecs();
    const a = store.beginShow("d", "a", false);
    const b = store.beginShow("d", "b", false);
    const shows = [
      { ticket: a, id: "a" },
      { ticket: b, id: "b" },
    ];
    if (reverse) {
      shows.reverse();
    }
    for (const { ticket, id } of shows) {
      store.endShow("d", ticket, { id, spec, replaceOthers: false });
    }
    expect(store.read("d", "a")).toMatchObject({ kind: "known", spec });
    expect(store.read("d", "b")).toMatchObject({ kind: "known", spec });
  });
  test.each([false, true])(
    "a newer same-id or replacing show supersedes additive (%s)",
    (replaceOthers) => {
      const store = new PrototypeShownSpecs();
      const a = store.beginShow("d", "a", false);
      const id = replaceOthers ? "b" : "a";
      const newer = { data: { count: 2 } };
      const b = store.beginShow("d", id, replaceOthers);
      store.endShow("d", b, { id, spec: newer, replaceOthers });
      store.endShow("d", a, { id: "a", spec, replaceOthers: false });
      expect(store.read("d", id)).toMatchObject({ kind: "known", spec: newer });
      if (replaceOthers) {
        expect(store.read("d", "a")).toEqual({ kind: "unknown" });
      }
    },
  );
  test("a refused additive show forgets only its own id", () => {
    const store = new PrototypeShownSpecs();
    for (const id of ["a", "b"]) {
      const ticket = store.beginShow("d", id, false);
      store.endShow("d", ticket, { id, spec, replaceOthers: false });
    }
    const refused = store.beginShow("d", "a", false);
    store.endShow("d", refused, undefined, "indeterminate");
    expect(store.read("d", "a")).toEqual({ kind: "unknown" });
    expect(store.read("d", "b")).toMatchObject({ kind: "known", spec });
  });
  test("a typed refusal of an additive re-show keeps the previous mirror", () => {
    const store = new PrototypeShownSpecs();
    const first = store.beginShow("d", "a", false);
    store.endShow("d", first, { id: "a", spec, replaceOthers: false });
    const refused = store.beginShow("d", "a", false);
    store.endShow("d", refused, undefined, "typed");
    expect(store.read("d", "a")).toMatchObject({ kind: "known", spec });
  });
  test("a show without a spec leaves its id untracked", () => {
    const store = new PrototypeShownSpecs();
    const first = store.beginShow("d", "a", false);
    store.endShow("d", first, { id: "a", spec, replaceOthers: false });
    const again = store.beginShow("d", "a", false);
    store.endShow("d", again, { id: "a", replaceOthers: false });
    expect(store.read("d", "a")).toEqual({ kind: "unknown" });
  });
  test("successful shows clone and reads remain busy while any ticket is open", () => {
    const store = new PrototypeShownSpecs();
    const first = store.beginShow("d");
    const last = store.beginShow("d");
    const input = { data: { count: 2 } };
    store.endShow("d", last, { id: "panel", spec: input });
    input.data.count = 9;
    expect(store.read("d", "panel")).toEqual({ kind: "busy" });
    store.endShow("d", first, { id: "old", spec });
    expect(store.read("d", "panel")).toMatchObject({ kind: "known", spec: { data: { count: 2 } } });
    expect(store.read("d", "old")).toEqual({ kind: "unknown" });
  });
  test("last failed show forgets; endShow is idempotent", () => {
    const store = new PrototypeShownSpecs();
    shown(store);
    const ticket = store.beginShow("d");
    store.endShow("d", ticket);
    store.endShow("d", ticket, { id: "panel", spec });
    expect(store.read("d", "panel")).toEqual({ kind: "unknown" });
  });
  test("committed patches clone their input and invalidate an older version", () => {
    const store = new PrototypeShownSpecs();
    const read = shown(store);
    const patched = { data: { count: 2 } };
    expect(store.commitPatch("d", "panel", read.version, patched)).toBe(true);
    patched.data.count = 99;
    expect(store.read("d", "panel")).toMatchObject({ spec: { data: { count: 2 } } });
    expect(store.commitPatch("d", "panel", read.version, spec)).toBe(false);
    expect(store.read("d", "panel")).toEqual({ kind: "unknown" });
  });
  test("an overlapping show is poisoned; a later dispatched show restores tracking", () => {
    const store = new PrototypeShownSpecs();
    const read = shown(store);
    const overlap = store.beginShow("d");
    expect(store.commitPatch("d", "panel", read.version, spec)).toBe(false);
    store.endShow("d", overlap, { id: "panel", spec });
    expect(store.read("d", "panel")).toEqual({ kind: "unknown" });
    shown(store);
  });
  test("abandon distrusts pending shows and a later show restores tracking", () => {
    const store = new PrototypeShownSpecs();
    const read = shown(store);
    const overlap = store.beginShow("d");
    store.abandon("d");
    expect(store.read("d", "panel")).toEqual({ kind: "busy" });
    store.endShow("d", overlap, { id: "panel", spec: { data: { count: 2 } } });
    expect(store.read("d", "panel")).toEqual({ kind: "unknown" });
    const restored = shown(store);
    expect(restored.version).toBeGreaterThan(read.version);
    expect(store.commitPatch("d", "panel", restored.version, spec)).toBe(true);
  });
  test("abandon forgets an entry and invalidates its patch version", () => {
    const store = new PrototypeShownSpecs();
    const read = shown(store);
    store.abandon("d");
    expect(store.read("d", "panel")).toEqual({ kind: "unknown" });
    const restored = shown(store);
    expect(restored.version).toBeGreaterThan(read.version);
    expect(store.commitPatch("d", "panel", read.version, spec)).toBe(false);
  });
  test("abandon on an unknown device is a no-op", () => {
    const store = new PrototypeShownSpecs();
    const read = shown(store);
    store.abandon("unknown");
    expect(store.read("unknown", "panel")).toEqual({ kind: "unknown" });
    expect(store.read("d", "panel")).toEqual(read);
    const ticket = store.beginShow("unknown");
    expect(ticket).toBe(read.version + 1);
    store.endShow("unknown", ticket, { id: "panel", spec });
    expect(store.read("unknown", "panel").kind).toBe("known");
  });
  test.each(["endShow", "forget", "wrongId"])("commit fails after %s", (intervention) => {
    const store = new PrototypeShownSpecs();
    const read = shown(store);
    if (intervention === "endShow") {
      shown(store);
    }
    if (intervention === "forget") {
      store.forget("d", "panel");
    }
    expect(
      store.commitPatch("d", intervention === "wrongId" ? "wrong" : "panel", read.version, spec),
    ).toBe(false);
    expect(store.read("d", "panel")).toEqual({ kind: "unknown" });
  });
  test("retainOnly and forget remove only matching entries; devices are independent", () => {
    const store = new PrototypeShownSpecs();
    const read = shown(store);
    shown(store, "other");
    store.retainOnly("d", "panel");
    store.forget("d", "wrong");
    expect(store.read("d", "panel")).toEqual(read);
    store.retainOnly("d", "new");
    expect(store.read("d", "panel")).toEqual({ kind: "unknown" });
    expect(store.read("other", "panel").kind).toBe("known");
    store.forget("other");
    expect(store.read("other", "panel").kind).toBe("unknown");
  });
  test("clear cannot let a late show close a new show's ticket", () => {
    const store = new PrototypeShownSpecs();
    const old = store.beginShow("d");
    store.clearDevice("d");
    const current = store.beginShow("d");
    store.endShow("d", old, { id: "panel", spec });
    expect(store.read("d", "panel")).toEqual({ kind: "busy" });
    const newer = { data: { count: 2 } };
    store.endShow("d", current, { id: "panel", spec: newer });
    expect(store.read("d", "panel")).toMatchObject({ kind: "known", spec: newer });
    expect(current).not.toBe(old);
  });
  test("clear cannot recycle a patch version after another show", () => {
    const store = new PrototypeShownSpecs();
    const before = shown(store);
    store.clearDevice("d");
    const after = shown(store);
    expect(store.commitPatch("d", "panel", before.version, { data: { count: 99 } })).toBe(false);
    expect(store.read("d", "panel")).toEqual({ kind: "unknown" });
    expect(after.version).not.toBe(before.version);
  });
  test("clearing a device ignores late endShow and patch commits", () => {
    const store = new PrototypeShownSpecs();
    const ticket = store.beginShow("d");
    store.clearDevice("d");
    store.endShow("d", ticket, { id: "panel", spec });
    expect(store.read("d", "panel")).toEqual({ kind: "unknown" });
    expect(store.commitPatch("d", "panel", 0, spec)).toBe(false);
  });
});
