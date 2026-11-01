import { describe, expect, test } from "bun:test";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import type { PrototypePatchReply } from "../../src/features/prototype/prototypePatchWire";
import {
  createPrototypePatchQueue,
  performPrototypePatch,
} from "../../src/server/prototypePatchAction";
import { FakeTimer } from "../fakes/FakeTimer";
import { event } from "../helpers/prototypeTestEvent";

const spec = {
  id: "p",
  window: { placement: { type: "fullscreen" } },
  data: { n: 1 },
  root: { type: "column", children: [{ type: "text", id: "title", text: "hi" }] },
};
const scope = { deviceId: "d" };

/** A real status store holding prototype `p` as shown, and a device that answers the patch. */
function shownPrototype(
  reply: PrototypePatchReply,
  whilePatching: (store: InMemoryPrototypeStatusStore) => void = () => {},
) {
  const store = new InMemoryPrototypeStatusStore(new FakeTimer());
  const ticket = store.shownSpecs.beginShow("d", "p");
  store.shownSpecs.endShow("d", ticket, { id: "p", spec });
  store.record(scope, "show", { id: "p" }, { result: { success: true } });
  const patch = (ops: unknown[]) =>
    performPrototypePatch(
      {
        store,
        transport: {
          patch: async () => {
            whilePatching(store);
            return reply;
          },
        },
        supportsPatch: async () => true,
        specRefusal: async () => undefined,
        settleSpec: async () => {},
        platform: "android",
        queue: createPrototypePatchQueue(),
        retire: () => {},
      },
      "d",
      { id: "p", ops: ops as never },
    );
  return { store, patch };
}

describe("a landed patch is visible in status and inspect (#16277)", () => {
  test("the prototype entry reports lastAction patch and the device's revision", async () => {
    const { store, patch } = shownPrototype({ success: true, revision: 2, delivery: "answered" });
    const out = await patch([
      { op: "replaceNode", id: "title", node: { type: "text", id: "title", text: "new" } },
    ]);
    expect(out).toMatchObject({ success: true, revision: 2 });
    expect(store.status(scope).prototypes[0]).toMatchObject({
      id: "p",
      lastAction: "patch",
      revision: 2,
    });
  });

  test("a device /data write during the patch still records the confirmed patch", async () => {
    const { store, patch } = shownPrototype(
      { success: true, revision: 3, delivery: "answered" },
      (live) =>
        live.recordEvent(scope, {
          ...event(1, "p", "change", "/data/n"),
          payload: { op: "set", value: 5, revision: 2 },
        }),
    );
    await patch([{ op: "replace", path: "/data/n", value: 2 }]);
    // The order of the write and the patch on the device is unknown, so the reported data is kept.
    expect(store.status(scope).prototypes[0]).toMatchObject({
      lastAction: "patch",
      revision: 3,
      data: { n: 5 },
    });
  });

  test("a show that overlaps the patch is not marked as patched", async () => {
    const { store, patch } = shownPrototype(
      { success: true, revision: 3, delivery: "answered" },
      (live) => {
        const ticket = live.shownSpecs.beginShow("d", "p");
        live.shownSpecs.endShow("d", ticket, { id: "p", spec });
        live.record(scope, "show", { id: "p" }, { result: { success: true } });
      },
    );
    const out = await patch([{ op: "replace", path: "/data/n", value: 2 }]);
    expect(out.warning).toContain("overlapped");
    const entry = store.status(scope).prototypes[0];
    expect(entry.lastAction).toBe("show");
    expect(entry).not.toHaveProperty("revision");
  });

  test("a refused patch leaves the entry as the show left it", async () => {
    const { store, patch } = shownPrototype({
      success: false,
      error: "no",
      delivery: "answered",
    });
    await patch([{ op: "replace", path: "/data/n", value: 2 }]);
    const entry = store.status(scope).prototypes[0];
    expect(entry.lastAction).toBe("show");
    expect(entry).not.toHaveProperty("revision");
  });
});
