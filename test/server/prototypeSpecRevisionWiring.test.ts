import { describe, expect, test } from "bun:test";
import { PrototypeShownSpecs } from "../../src/features/prototype/PrototypeShownSpecs";
import { PrototypeSpecRevisions } from "../../src/features/prototype/prototypeSpecRevisions";
import {
  createPrototypePatchQueue,
  performPrototypePatch,
} from "../../src/server/prototypePatchAction";
import { shownSpecOutcome } from "../../src/server/prototypeShownOutcome";
import { prototypeSchema } from "../../src/server/prototypeTools";
import { FakeTimer } from "../fakes/FakeTimer";

const spec = {
  id: "p",
  window: { placement: { type: "fullscreen" } },
  data: { items: [] as string[] },
  root: { type: "text", text: "hi" },
};
const variant = { group: "checkout", label: "Compact" };

function shownWithVariant() {
  const revisions = new PrototypeSpecRevisions(new FakeTimer());
  const shownSpecs = new PrototypeShownSpecs(revisions);
  const ticket = shownSpecs.beginShow("d", "p", true, "android");
  const { shown, refusal } = shownSpecOutcome({
    action: "show",
    success: true,
    id: "p",
    spec,
    variant,
    result: { success: true },
  });
  shownSpecs.endShow("d", ticket, shown, refusal);
  return { revisions, shownSpecs };
}

describe("spec revisions from the prototype tool (#16345)", () => {
  test("an acknowledged show records its variant", () => {
    const { revisions } = shownWithVariant();
    expect(revisions.revision("p")).toMatchObject({ revision: 1, operation: "show", variant });
  });

  test("a landed patch records the device revision its reply reported", async () => {
    const { revisions, shownSpecs } = shownWithVariant();
    const out = await performPrototypePatch(
      {
        store: { shownSpecs, recordPatch: () => {} },
        transport: { patch: async () => ({ success: true, delivery: "answered", revision: 9 }) },
        supportsPatch: async () => true,
        platform: "android",
        queue: createPrototypePatchQueue(),
        retire: () => {},
      },
      "d",
      { id: "p", ops: [{ op: "add", path: "/data/items/-", value: "x" }] },
    );
    expect(out.success).toBe(true);
    expect(revisions.revision("p")).toMatchObject({
      revision: 2,
      operation: "patch",
      deviceRevision: 9,
      variant,
    });
  });

  test("variant is a show-only field", () => {
    expect(prototypeSchema.safeParse({ action: "show", spec, variant }).success).toBe(true);
    const ops = [{ op: "add", path: "/data/items/-", value: "x" }];
    expect(prototypeSchema.safeParse({ action: "patch", id: "p", ops }).success).toBe(true);
    expect(prototypeSchema.safeParse({ action: "patch", id: "p", ops, variant }).success).toBe(
      false,
    );
    expect(
      prototypeSchema.safeParse({ action: "show", spec, variant: { group: "g" } }).success,
    ).toBe(false);
  });
});
