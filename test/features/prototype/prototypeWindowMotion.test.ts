import { describe, expect, test } from "bun:test";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeWindowMotionFields } from "../../../src/features/prototype/prototypeWindowMotion";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const spec = (transition: unknown = "auto", stagger: unknown = 50) => ({
  id: "windowMotion",
  window: { placement: { type: "fullscreen" }, transition },
  state: { open: true },
  root: {
    type: "column",
    repeat: { items: [{ name: "A" }, { name: "B" }], as: "item", stagger },
    children: [{ type: "text", text: "{item.name}", visibleWhen: { key: "open", equals: true } }],
  },
});

describe("Android window motion contract", () => {
  test("accepts each window transition and the repeat stagger boundaries", () => {
    for (const transition of ["auto", "none", "fade", "slide", "scale"]) {
      for (const stagger of [0, 100]) {
        expect(validatePrototypeSpec(spec(transition, stagger)).success).toBe(true);
      }
    }
  });
  test("rejects unknown transitions and non-integral or out-of-range stagger", () => {
    expect(validatePrototypeSpec(spec("expand")).success).toBe(false);
    for (const stagger of [-1, 101, 0.5, "50", null]) {
      expect(validatePrototypeSpec(spec("auto", stagger)).success).toBe(false);
    }
  });
  test("gates authored fields, including explicit none and zero", () => {
    expect(prototypeWindowMotionFields(spec("none", 0))).toEqual([
      "window.transition",
      "root.repeat.stagger",
    ]);
    expect(requiredPrototypeCapabilities(spec())).toContain("prototype_window_motion_v1");
    expect(requiredPrototypeCapabilities(spec())).not.toContain("prototype_choreography_v1");
  });
  test("ignores similarly named opaque state values", () => {
    expect(
      prototypeWindowMotionFields({
        id: "a",
        window: { placement: { type: "fullscreen" } },
        state: { repeat: { stagger: 30 } },
        root: { type: "text", text: "A" },
      }),
    ).toEqual([]);
  });
});
