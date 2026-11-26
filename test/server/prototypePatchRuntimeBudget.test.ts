import { describe, expect, test } from "bun:test";
import { PROTOTYPE_LARGE_BUDGET_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
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

function dependencies(
  budget: PrototypeRuntimeBudget,
  sent: unknown[] = [],
): PrototypePatchDependencies {
  const shownSpecs = new PrototypeShownSpecs();
  const ticket = shownSpecs.beginShow("d", "feed", true, "android");
  shownSpecs.endShow("d", ticket, { id: "feed", spec, budget });
  return {
    store: { shownSpecs, recordPatch: () => {} },
    transport: {
      patch: async (request) => {
        sent.push(request);
        return { success: true, delivery: "answered" };
      },
    },
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

/** 1.5 MB of data: over the base 1 MiB frame cap, under the large budget's caps. */
const largeOps = [
  { op: "add", path: "/data/pages", value: Array.from({ length: 1000 }, () => "x".repeat(1500)) },
];

describe("the patch frame cap follows the target's runtime budget (#19306)", () => {
  test("a large-budget prototype takes a frame over the base cap", async () => {
    const sent: unknown[] = [];
    const out = await performPrototypePatch(dependencies(PROTOTYPE_LARGE_BUDGET, sent), "d", {
      id: "feed",
      ops: largeOps,
    });
    expect(out).toMatchObject({ success: true });
    expect(sent).toHaveLength(1);
  });

  test("a base-budget prototype refuses it before sending and names the capability", async () => {
    const sent: unknown[] = [];
    const out = await performPrototypePatch(dependencies(PROTOTYPE_BASE_BUDGET, sent), "d", {
      id: "feed",
      ops: largeOps,
    });
    expect(out.success).toBe(false);
    expect(out.error).toStartWith("Invalid patch at ops: Patch byte limit exceeded");
    expect(out.error).toContain(`allows ${PROTOTYPE_BASE_BUDGET.MAX_PROTOTYPE_SPEC_BYTES}`);
    expect(out.error).toContain(PROTOTYPE_LARGE_BUDGET_CAPABILITY);
    expect(sent).toEqual([]);
  });

  test("a frame over the large budget never enters the queue", async () => {
    let queued = false;
    const deps = {
      ...dependencies(PROTOTYPE_LARGE_BUDGET),
      queue: {
        run: <T>(_deviceId: string, task: () => Promise<T>) => {
          queued = true;
          return task();
        },
      },
    };
    const value = "x".repeat(PROTOTYPE_LARGE_BUDGET.MAX_PROTOTYPE_SPEC_BYTES);
    const out = await performPrototypePatch(deps, "d", {
      id: "feed",
      ops: [{ op: "add", path: "/data/big", value }],
    });
    expect(out.error).toContain(`allows ${PROTOTYPE_LARGE_BUDGET.MAX_PROTOTYPE_SPEC_BYTES}`);
    expect(queued).toBe(false);
  });

  test.each([
    ["advertising the large budget", async () => PROTOTYPE_LARGE_BUDGET, 1],
    ["without the capability", async () => PROTOTYPE_BASE_BUDGET, 0],
    ["with no budget lookup", undefined, 0],
  ])("a disposable app %s", async (_name, deviceBudget, sends) => {
    const sent: unknown[] = [];
    const deps: PrototypePatchDependencies = {
      ...dependencies(PROTOTYPE_BASE_BUDGET, sent),
      deviceOwnsSpec: true,
      ...(deviceBudget ? { deviceBudget } : {}),
    };
    const out = await performPrototypePatch(deps, "d", { id: "feed", ops: largeOps });
    expect(out.success).toBe(sends === 1);
    expect(sent).toHaveLength(sends);
  });
});
