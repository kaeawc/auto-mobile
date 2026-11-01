import { describe, expect, test } from "bun:test";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import type { PrototypePatchReply } from "../../src/features/prototype/prototypePatchWire";
import {
  createPrototypePatchQueue,
  performPrototypePatch,
} from "../../src/server/prototypePatchAction";
import { FakeTimer } from "../fakes/FakeTimer";

const spec = {
  id: "p",
  window: { placement: { type: "fullscreen" } },
  data: { n: 1 },
  root: { type: "column", children: [{ type: "text", id: "title", text: "hi" }] },
};
const scope = { deviceId: "d" };

/** A real status store holding prototype `p` as shown, and a device that answers the patch. */
function shownPrototype(reply: PrototypePatchReply) {
  const store = new InMemoryPrototypeStatusStore(new FakeTimer());
  const ticket = store.shownSpecs.beginShow("d", "p");
  store.shownSpecs.endShow("d", ticket, { id: "p", spec });
  store.record(scope, "show", { id: "p" }, { result: { success: true } });
  const patch = (ops: unknown[]) =>
    performPrototypePatch(
      {
        store,
        transport: { patch: async () => reply },
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
