import { describe, expect, test } from "bun:test";
import { PROTOTYPE_BACKDROP_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import {
  MAX_PROTOTYPE_BACKDROP_BLUR_DP,
  PROTOTYPE_BACKDROP_MATERIALS,
  prototypeBackdropFields,
  prototypeBackdropUnsupportedMessage,
  shownBackdrop,
} from "../../../src/features/prototype/prototypeBackdrop";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";

const spec = (backdrop: unknown, placement: unknown = { type: "fullscreen" }) => ({
  id: "b",
  window: { placement, backdrop },
  root: { type: "spacer" },
});
const accepts = (backdrop: unknown) => prototypeSpecSchema.safeParse(spec(backdrop)).success;

describe("window.backdrop contract (#15126)", () => {
  test("every closed material is accepted and a missing or unknown one is not", () => {
    for (const material of PROTOTYPE_BACKDROP_MATERIALS) {
      expect(accepts({ material })).toBe(true);
    }
    expect(accepts({ material: "frosted" })).toBe(false);
    expect(accepts({})).toBe(false);
  });

  test("blur is a whole dp radius capped at 150", () => {
    expect(accepts({ material: "thin", blur: 0 })).toBe(true);
    expect(accepts({ material: "thin", blur: MAX_PROTOTYPE_BACKDROP_BLUR_DP })).toBe(true);
    expect(accepts({ material: "thin", blur: MAX_PROTOTYPE_BACKDROP_BLUR_DP + 1 })).toBe(false);
    expect(accepts({ material: "thin", blur: -1 })).toBe(false);
    expect(accepts({ material: "thin", blur: 2.5 })).toBe(false);
  });

  test("tint is one colour, never a per-mode pair, and unknown keys are rejected", () => {
    expect(accepts({ material: "thin", tint: "#FF336699" })).toBe(true);
    expect(accepts({ material: "thin", tint: "surface" })).toBe(true);
    expect(accepts({ material: "thin", tint: { light: "#FFFFFF", dark: "#000000" } })).toBe(false);
    expect(accepts({ material: "thin", radius: 4 })).toBe(false);
  });

  test("it applies to a sheet window as well as fullscreen", () => {
    expect(
      prototypeSpecSchema.safeParse(
        spec({ material: "thick" }, { type: "sheet", edge: "bottom", height: 320 }),
      ).success,
    ).toBe(true);
  });

  test("the gate requires prototype_backdrop_v1 and only for a spec with a backdrop", () => {
    const withBackdrop = spec({ material: "thin" });
    expect(prototypeBackdropFields(withBackdrop)).toEqual(["window.backdrop"]);
    expect(prototypeRequiredCapabilities(withBackdrop).map((gate) => gate.capability)).toContain(
      PROTOTYPE_BACKDROP_CAPABILITY,
    );
    expect(prototypeBackdropFields({ window: {}, root: {} })).toEqual([]);
    expect(prototypeBackdropUnsupportedMessage(["window.backdrop"], "android")).toContain(
      "Nothing was shown",
    );
    expect(prototypeBackdropUnsupportedMessage(["window.backdrop"], "ios")).toContain(
      "launchApp prototype: true",
    );
  });

  test("only a successful show reports the device's outcome", () => {
    const ok = { success: true, timestamp: 1 } as const;
    expect(shownBackdrop("show", { ...ok, backdrop: "blur" })).toEqual({ backdrop: "blur" });
    expect(shownBackdrop("show", { ...ok, backdrop: "fallback" })).toEqual({
      backdrop: "fallback",
    });
    expect(shownBackdrop("dismiss", { ...ok, backdrop: "blur" })).toEqual({});
    expect(shownBackdrop("show", { success: false, timestamp: 1, backdrop: "blur" })).toEqual({});
    expect(shownBackdrop("show", ok)).toEqual({});
  });
});
