import { describe, expect, test } from "bun:test";
import { renderPrototypeGuide } from "../../../src/features/prototype/prototypeGuide";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const specWithScrim = (scrim: string) => ({
  id: "sheet",
  window: { placement: { type: "fullscreen", scrim } },
  root: { type: "text", text: "x" },
});

/**
 * #11416: in a scrim slot only the `scrim` role is drawn translucent (0.4 alpha); the alpha is
 * applied on the device. The host's part of the contract is to state it and to pass every role
 * through untouched, never adding alpha or substituting the `scrim` role itself.
 */
describe("scrim slot roles (#11416)", () => {
  test.each(["scrim", "surface", "primary", "surfaceContainer"])(
    "role %s is accepted and forwarded verbatim",
    (role) => {
      const input = specWithScrim(role);
      const result = validatePrototypeSpec(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window.placement).toMatchObject({ scrim: role });
      }
    },
  );

  test("the guide tells authors that only the scrim role is translucent", () => {
    const guide = renderPrototypeGuide().replace(/\s+/g, " ");
    expect(guide).toContain("only the `scrim` role is drawn translucent");
    expect(guide).toContain("Any other role is drawn unchanged");
  });
});
