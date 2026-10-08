import { describe, expect, test } from "bun:test";
import { overlaySpecSchema } from "../../../src/features/overlay/overlaySpec";
import { validateOverlaySpec } from "../../../src/features/overlay/overlayValidation";

function specWith(icon: Record<string, unknown>, bottomNavIcon?: string) {
  return {
    id: "panel",
    window: { placement: { type: "fullscreen" } },
    state: { selected: 0 },
    root: bottomNavIcon
      ? {
          type: "bottomNav",
          stateKey: "selected",
          items: [
            { label: "Clock", icon: bottomNavIcon },
            { label: "Home", icon: "home" },
          ],
        }
      : { type: "icon", ...icon },
  };
}

describe("overlay icon names", () => {
  test.each(["home", "logout", "timer", "bedtime", "alarm_add", "add_a_photo", "crop_169"])(
    "accepts %s in both validators",
    (name) => {
      const spec = specWith({ name });
      expect(validateOverlaySpec(spec).success).toBe(true);
      expect(overlaySpecSchema.safeParse(spec).success).toBe(true);
    },
  );

  test.each(["outlined", "rounded", "sharp", "twoTone", "filled"])("accepts variant %s", (v) => {
    const spec = specWith({ name: "timer", variant: v });
    expect(validateOverlaySpec(spec).success).toBe(true);
    expect(overlaySpecSchema.safeParse(spec).success).toBe(true);
  });

  test("rejects unknown icon names and variants with a path", () => {
    const unknown = validateOverlaySpec(specWith({ name: "not_an_icon" }));
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.path).toContain("name");
    }
    expect(validateOverlaySpec(specWith({ name: "timer", variant: "bold" })).success).toBe(false);
    expect(overlaySpecSchema.safeParse(specWith({ name: "not_an_icon" })).success).toBe(false);
  });

  test("nav items accept the full set and reject unknown names", () => {
    expect(validateOverlaySpec(specWith({ name: "home" }, "bedtime")).success).toBe(true);
    expect(validateOverlaySpec(specWith({ name: "home" }, "not_an_icon")).success).toBe(false);
  });
});
