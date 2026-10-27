import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_SPEC_CAPABILITY_GATES,
  prototypeGateCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  effectUses,
  prototypeEffectFields,
  prototypeEffectsUnsupportedMessage,
} from "../../../src/features/prototype/prototypeEffects";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const noise = { type: "noise" };
const animated = { type: "noise", animate: { periodMs: 1000 } };
const spec = (root: unknown) => ({
  id: "a",
  window: { placement: { type: "fullscreen" } },
  root,
});
const label = (effects: unknown[], text = "t") => ({ type: "text", text, style: { effects } });
const column = (children: unknown[]) => ({ type: "column", children });
const many = (count: number, effect: unknown) => Array.from({ length: count }, () => effect);
// Four effects per node is the per-list maximum, so 16 nodes reach the 64-effect limit exactly.
const nodes = (count: number, effect: unknown) =>
  Array.from({ length: count }, (_, index) => label(many(4, effect), `n${index}`));

describe("effect limits (#15128)", () => {
  test("the contract names the limits", () => {
    expect(contract.limits.MAX_PROTOTYPE_EFFECTS).toBe(64);
    expect(contract.limits.MAX_PROTOTYPE_ANIMATED_EFFECTS).toBe(8);
  });

  test("64 effects pass and the 65th fails at the node that crossed the limit", () => {
    expect(validatePrototypeSpec(spec(column(nodes(16, noise)))).success).toBe(true);
    const over = [...nodes(16, noise), label([noise], "extra")];
    expect(validatePrototypeSpec(spec(column(over)))).toEqual({
      success: false,
      error: { path: "root.children[16]", message: "Effect limit exceeded" },
    });
  });

  test("8 animated effects pass and the 9th fails", () => {
    const eight = [...nodes(2, animated), ...nodes(14, noise)];
    expect(validatePrototypeSpec(spec(column(eight))).success).toBe(true);
    const nine = [...nodes(2, animated), label([animated], "ninth"), ...nodes(13, noise)];
    const result = validatePrototypeSpec(spec(column(nine)));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toEqual({
        path: "root.children[2]",
        message: "Animated effect limit exceeded",
      });
    }
  });

  test("a styleWhen style's effects count too", () => {
    const withWhen = {
      type: "text",
      text: "t",
      style: { effects: many(4, noise) },
      styleWhen: [{ when: { key: "on", equals: true }, style: { effects: many(4, noise) } }],
    };
    const root = column(Array.from({ length: 9 }, () => withWhen));
    const result = validatePrototypeSpec({ ...spec(root), state: { on: true } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe("Effect limit exceeded");
    }
  });

  test("a repeat multiplies a template's effects and reports at the repeat", () => {
    const template = label(many(4, noise));
    const repeated = (count: number) => ({
      ...column([template]),
      repeat: { items: Array.from({ length: count }, (_, id) => ({ id })), as: "item" },
    });
    expect(validatePrototypeSpec(spec(repeated(16))).success).toBe(true);
    expect(validatePrototypeSpec(spec(repeated(17)))).toEqual({
      success: false,
      error: { path: "root.repeat", message: "Expanded effect limit exceeded" },
    });
    const animatedTemplate = label(many(4, animated));
    const result = validatePrototypeSpec(spec({ ...repeated(3), children: [animatedTemplate] }));
    expect(result).toEqual({
      success: false,
      error: { path: "root.repeat", message: "Expanded animated effect limit exceeded" },
    });
  });

  test("an over-long list is reported as that, not as a count overflow", () => {
    const over = [...nodes(15, noise), label(many(5, noise), "long")];
    const result = validatePrototypeSpec(spec(column(over)));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.path).toBe("root.children[15].style.effects");
    }
  });

  test("effectUses counts a node's own and styleWhen effects", () => {
    expect(effectUses({ style: { effects: [noise, animated] } })).toEqual({
      total: 2,
      animated: 1,
    });
    expect(effectUses({ type: "text" })).toEqual({ total: 0, animated: 0 });
  });
});

describe("prototype_effects_v1 gate (#15128)", () => {
  const gate = PROTOTYPE_SPEC_CAPABILITY_GATES.find(
    (entry) => entry.capability === "prototype_effects_v1",
  );

  test("a spec with effects needs the capability, one without does not", () => {
    const withEffects = spec(column([label([noise])]));
    expect(prototypeGateCapabilities(withEffects)).toContain("prototype_effects_v1");
    expect(prototypeGateCapabilities(spec(column([{ type: "text", text: "t" }])))).not.toContain(
      "prototype_effects_v1",
    );
  });

  test("fields name every authored effects list, including styleWhen styles", () => {
    const root = column([
      {
        type: "text",
        text: "t",
        style: { effects: [noise] },
        styleWhen: [{ when: { key: "on", equals: true }, style: { effects: [noise] } }],
      },
    ]);
    expect(prototypeEffectFields(spec(root))).toEqual([
      "root.children[0].style.effects",
      "root.children[0].styleWhen[0].style.effects",
    ]);
  });

  test("the refusal names the capability, the first path and the device", () => {
    expect(gate).toBeDefined();
    const fields = ["root.style.effects", "root.children[0].style.effects"];
    const android = prototypeEffectsUnsupportedMessage(fields, "android");
    expect(android).toContain("prototype_effects_v1");
    expect(android).toContain("root.style.effects (and 1 more)");
    expect(android).toContain("Update the connected CtrlProxy");
    expect(prototypeEffectsUnsupportedMessage(fields.slice(0, 1), "ios")).toContain(
      "launchApp prototype: true",
    );
  });
});
