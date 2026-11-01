import { describe, expect, test } from "bun:test";
import { PrototypeShownSpecs } from "../../src/features/prototype/PrototypeShownSpecs";
import type { PrototypePatchReply } from "../../src/features/prototype/prototypePatchWire";
import {
  createPrototypePatchQueue,
  performPrototypePatch,
  type PrototypePatchDependencies,
} from "../../src/server/prototypePatchAction";

const spec = {
  id: "p",
  window: { placement: { type: "fullscreen" } },
  data: { n: 1 },
  root: { type: "text", text: "hi" },
};
const ops = [{ op: "replace", path: "/data/n", value: 2 }];

/** Fake collaborators: only what performPrototypePatch reads, no timers or devices. */
function harness(patch: () => Promise<PrototypePatchReply>) {
  const shownSpecs = new PrototypeShownSpecs();
  const ticket = shownSpecs.beginShow("d", "p");
  shownSpecs.endShow("d", ticket, { id: "p", spec });
  const settled: boolean[] = [];
  const dependencies: PrototypePatchDependencies = {
    store: { shownSpecs, recordPatch: () => {} },
    transport: { patch },
    supportsPatch: async () => true,
    specRefusal: async () => undefined,
    settleSpec: async (landed) => {
      settled.push(landed);
    },
    platform: "android",
    queue: createPrototypePatchQueue(),
    retire: () => {},
  };
  return { dependencies, settled };
}

describe("performPrototypePatch spec settlement", () => {
  test("settles as landed when the device accepts the patch", async () => {
    const { dependencies, settled } = harness(async () => ({
      success: true,
      delivery: "answered",
    }));
    const out = await performPrototypePatch(dependencies, "d", { id: "p", ops });
    expect(out.error).toBeUndefined();
    expect(out.success).toBe(true);
    expect(settled).toEqual([true]);
  });

  test("settles as not landed when the device refuses the patch", async () => {
    const { dependencies, settled } = harness(async () => ({
      success: false,
      error: "no",
      delivery: "answered",
    }));
    const out = await performPrototypePatch(dependencies, "d", { id: "p", ops });
    expect(out.success).toBe(false);
    expect(settled).toEqual([false]);
  });

  test("settles as not landed when the call aborts after staging", async () => {
    const { dependencies, settled } = harness(async () => ({
      success: true,
      delivery: "answered",
    }));
    const controller = new AbortController();
    // The call is aborted after the spec was staged, before the patch is sent.
    dependencies.specRefusal = async () => {
      controller.abort();
      return undefined;
    };
    await expect(
      performPrototypePatch(dependencies, "d", { id: "p", ops }, controller.signal),
    ).rejects.toThrow();
    expect(settled).toEqual([false]);
  });

  test("settles as not landed when the spec is refused", async () => {
    const { dependencies, settled } = harness(async () => ({
      success: true,
      delivery: "answered",
    }));
    dependencies.specRefusal = async () => "unsupported";
    const out = await performPrototypePatch(dependencies, "d", { id: "p", ops });
    expect(out.success).toBe(false);
    expect(settled).toEqual([false]);
  });
});
