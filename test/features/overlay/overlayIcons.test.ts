import { describe, expect, test } from "bun:test";
import { overlaySpecSchema } from "../../../src/features/overlay/overlaySpec";
import { validateOverlaySpec } from "../../../src/features/overlay/overlayValidation";
import contract from "../../../schemas/overlay-spec-contract.json";

/** Every enum in the contract that lists icon names other than the shared `iconName` itself. */
function staleIconEnums(value: unknown, path: string, found: string[]): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => staleIconEnums(item, `${path}[${index}]`, found));
  } else if (value && typeof value === "object") {
    const rule = value as { kind?: unknown; values?: unknown };
    if (rule.kind === "enum" && Array.isArray(rule.values) && rule.values.includes("home")) {
      found.push(path);
    }
    for (const [key, child] of Object.entries(value)) {
      staleIconEnums(child, `${path}.${key}`, found);
    }
  }
  return found;
}

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

  test("button, listItem leading and trailing icons accept the full set in both validators", () => {
    const list = (fields: Record<string, unknown>) => ({
      type: "listItem",
      headline: "Wi-Fi",
      ...fields,
    });
    for (const root of [
      { type: "button", label: "Connect", icon: "wifi" },
      list({ leadingIcon: "wifi" }),
      list({ trailing: { type: "icon", name: "wifi" } }),
    ]) {
      const spec = { id: "panel", window: { placement: { type: "fullscreen" } }, root };
      expect(validateOverlaySpec(spec)).toMatchObject({ success: true });
      expect(overlaySpecSchema.safeParse(spec).success).toBe(true);
      const unknown = JSON.parse(JSON.stringify(spec).replace('"wifi"', '"not_an_icon"'));
      expect(validateOverlaySpec(unknown).success).toBe(false);
    }
  });

  test("no contract field keeps its own copy of the icon-name list", () => {
    const { iconName, ...rest } = contract.definitions;
    expect(iconName.values.length).toBeGreaterThan(2000);
    expect(staleIconEnums(rest, "definitions", [])).toEqual([]);
  });
});
