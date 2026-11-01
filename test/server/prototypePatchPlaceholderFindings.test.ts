import { describe, expect, test } from "bun:test";
import { PrototypeShownSpecs } from "../../src/features/prototype/PrototypeShownSpecs";
import {
  createPrototypePatchQueue,
  performPrototypePatch,
  type PrototypePatchDependencies,
} from "../../src/server/prototypePatchAction";

const spec = {
  id: "p",
  window: { placement: { type: "fullscreen" } },
  data: { n: 1 },
  root: {
    type: "column",
    repeat: { items: [{ name: "Alpha" }], as: "item" },
    children: [{ type: "chip", label: "{item.name}" }],
  },
};

function dependencies(): PrototypePatchDependencies {
  const shownSpecs = new PrototypeShownSpecs();
  const ticket = shownSpecs.beginShow("d", "p");
  shownSpecs.endShow("d", ticket, { id: "p", spec });
  return {
    store: { shownSpecs, recordPatch: () => {} },
    transport: { patch: async () => ({ success: true, delivery: "answered" }) },
    supportsPatch: async () => true,
    specRefusal: async () => undefined,
    settleSpec: async () => {},
    platform: "android",
    queue: createPrototypePatchQueue(),
    retire: () => {},
  };
}

describe("patch reports placeholder findings (#15444)", () => {
  test("a patched spec that still has a chip.label placeholder returns the finding and succeeds", async () => {
    const out = await performPrototypePatch(dependencies(), "d", {
      id: "p",
      ops: [{ op: "replace", path: "/data/n", value: 2 }],
    });
    expect(out.success).toBe(true);
    expect(out.placeholderFindings).toEqual([
      expect.objectContaining({ path: "root.children[0].label", placeholder: "{item.name}" }),
    ]);
  });
});
