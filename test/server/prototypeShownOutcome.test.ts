import { describe, expect, test } from "bun:test";
import { PrototypeShownSpecs } from "../../src/features/prototype/PrototypeShownSpecs";
import {
  createPrototypePatchQueue,
  performPrototypePatch,
  type PrototypePatchDependencies,
} from "../../src/server/prototypePatchAction";
import { markIndeterminate, shownSpecOutcome } from "../../src/server/prototypeShownOutcome";

const base = {
  id: "p",
  window: { placement: { type: "fullscreen" } },
  data: { items: [] as string[] },
  root: { type: "text", text: "hi" },
};
const stored = { ...base, storage: { version: 1, keys: ["data:/items"] } };
const patchOps = [{ op: "add", path: "/data/items/-", value: "x" }];

function dependencies(shownSpecs: PrototypeShownSpecs): PrototypePatchDependencies {
  return {
    store: { shownSpecs, recordPatchedData: () => {} },
    transport: { patch: async () => ({ success: true, delivery: "answered" }) },
    supportsPatch: async () => true,
    platform: "android",
    queue: createPrototypePatchQueue(),
    retire: () => {},
  };
}

function show(shownSpecs: PrototypeShownSpecs, spec: unknown, replaceOthers?: boolean) {
  const ticket = shownSpecs.beginShow("d", "p", replaceOthers);
  const { shown, refusal } = shownSpecOutcome({
    action: "show",
    success: true,
    id: "p",
    spec,
    replaceOthers,
    result: { success: true },
  });
  shownSpecs.endShow("d", ticket, shown, refusal);
}

describe("shownSpecOutcome", () => {
  test("a show that persists /data is untracked, so a patch is refused as untracked", async () => {
    const shownSpecs = new PrototypeShownSpecs();
    show(shownSpecs, stored);
    const out = await performPrototypePatch(dependencies(shownSpecs), "d", {
      id: "p",
      ops: patchOps,
    });
    expect(out.success).toBe(false);
    expect(out.error).toContain("not tracking its spec");
  });

  test("a show with only state keys in storage, or none, stays tracked", async () => {
    for (const spec of [
      base,
      { ...base, state: { a: 1 }, storage: { version: 1, keys: ["state:a"] } },
    ]) {
      const shownSpecs = new PrototypeShownSpecs();
      show(shownSpecs, spec);
      const out = await performPrototypePatch(dependencies(shownSpecs), "d", {
        id: "p",
        ops: patchOps,
      });
      expect(out.error).toBeUndefined();
    }
  });

  test("a refused additive show is typed unless the call threw", () => {
    const refused = { action: "show", success: false, replaceOthers: false };
    expect(shownSpecOutcome({ ...refused, result: { success: false } }).refusal).toBe("typed");
    expect(
      shownSpecOutcome({ ...refused, result: markIndeterminate({ success: false }) }).refusal,
    ).toBe("indeterminate");
  });

  test("typed refusal keeps the old spec for patching; indeterminate makes it untracked", async () => {
    for (const [result, tracked] of [
      [{ success: false }, true],
      [markIndeterminate({ success: false }), false],
    ] as const) {
      const shownSpecs = new PrototypeShownSpecs();
      show(shownSpecs, base, false);
      const ticket = shownSpecs.beginShow("d", "p", false);
      const { shown, refusal } = shownSpecOutcome({
        action: "show",
        success: false,
        id: "p",
        replaceOthers: false,
        result,
      });
      shownSpecs.endShow("d", ticket, shown, refusal);
      const out = await performPrototypePatch(dependencies(shownSpecs), "d", {
        id: "p",
        ops: patchOps,
      });
      expect(out.success).toBe(tracked);
    }
  });
});
