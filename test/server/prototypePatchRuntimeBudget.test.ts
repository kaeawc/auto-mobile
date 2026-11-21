import { describe, expect, test } from "bun:test";
import { PrototypeShownSpecs } from "../../src/features/prototype/PrototypeShownSpecs";
import {
  PROTOTYPE_BASE_BUDGET,
  PROTOTYPE_LARGE_BUDGET,
  type PrototypeRuntimeBudget,
} from "../../src/features/prototype/prototypeRuntimeBudget";
import {
  createPrototypePatchQueue,
  performPrototypePatch,
  type PrototypePatchDependencies,
} from "../../src/server/prototypePatchAction";

const spec = {
  id: "feed",
  window: { placement: { type: "fullscreen" } },
  data: { rows: Array.from({ length: 2001 }, (_, id) => ({ id })), flag: false },
  root: { type: "text", text: "Rows" },
};

function dependencies(budget: PrototypeRuntimeBudget): PrototypePatchDependencies {
  const shownSpecs = new PrototypeShownSpecs();
  const ticket = shownSpecs.beginShow("d", "feed", true, "android");
  shownSpecs.endShow("d", ticket, { id: "feed", spec, budget });
  return {
    store: { shownSpecs, recordPatch: () => {} },
    transport: { patch: async () => ({ success: true, delivery: "answered" }) },
    supportsPatch: async () => true,
    specRefusal: async () => undefined,
    platform: "android",
    queue: createPrototypePatchQueue(),
    retire: () => {},
  };
}

describe("patch validates with the shown spec's runtime budget (#18804)", () => {
  test.each([
    [PROTOTYPE_LARGE_BUDGET, true],
    [PROTOTYPE_BASE_BUDGET, false],
  ])("a patch to a 2001-row spec", async (budget, success) => {
    const out = await performPrototypePatch(dependencies(budget), "d", {
      id: "feed",
      ops: [{ op: "replace", path: "/data/flag", value: true }],
    });
    expect(out.success).toBe(success);
  });
});
