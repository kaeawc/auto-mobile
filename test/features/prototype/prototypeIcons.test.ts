import { describe, expect, test } from "bun:test";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import curatedNames from "../../../schemas/prototype-icon-names.json";
import contract from "../../../schemas/prototype-spec-contract.json";
import { readFileSync } from "node:fs";
import {
  renderPrototypeIconContract,
  renderPrototypeIconGuide,
} from "../../../scripts/prototype/generate-prototype-icon-names";

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

describe("prototype icon names", () => {
  test.each(["home", "logout", "timer", "bedtime", "alarm_add", "add_a_photo", "crop_169"])(
    "accepts %s in both validators",
    (name) => {
      const spec = specWith({ name });
      expect(validatePrototypeSpec(spec).success).toBe(true);
      expect(prototypeSpecSchema.safeParse(spec).success).toBe(true);
    },
  );

  test.each(["outlined", "rounded", "sharp", "twoTone", "filled"])("accepts variant %s", (v) => {
    const spec = specWith({ name: "timer", variant: v });
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(prototypeSpecSchema.safeParse(spec).success).toBe(true);
  });

  test("rejects unknown icon names and variants with a path", () => {
    const unknown = validatePrototypeSpec(specWith({ name: "not_an_icon" }));
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.path).toContain("name");
    }
    expect(validatePrototypeSpec(specWith({ name: "timer", variant: "bold" })).success).toBe(false);
    expect(prototypeSpecSchema.safeParse(specWith({ name: "not_an_icon" })).success).toBe(false);
  });

  test("nav items accept the full set and reject unknown names", () => {
    expect(validatePrototypeSpec(specWith({ name: "home" }, "bedtime")).success).toBe(true);
    expect(validatePrototypeSpec(specWith({ name: "home" }, "not_an_icon")).success).toBe(false);
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
      expect(validatePrototypeSpec(spec)).toMatchObject({ success: true });
      expect(prototypeSpecSchema.safeParse(spec).success).toBe(true);
      const unknown = JSON.parse(JSON.stringify(spec).replace('"wifi"', '"not_an_icon"'));
      expect(validatePrototypeSpec(unknown).success).toBe(false);
    }
  });

  test("curated icon data is sorted, unique and matches the contract", () => {
    expect(curatedNames).toEqual([...new Set(curatedNames)].sort());
    expect(contract.definitions.iconName.values).toEqual(curatedNames);
    expect(JSON.parse(renderPrototypeIconContract())).toEqual(contract);
    expect(
      readFileSync(new URL("../../../docs/using/prototype-icons.md", import.meta.url), "utf8"),
    ).toBe(renderPrototypeIconGuide());
  });

  test("unknown names without a close match point to the allowed list", () => {
    const result = validatePrototypeSpec(specWith({ name: "zzzzzzzz" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Choose an allowed icon name");
      expect(result.error.message).toContain("automobile:prototype/icons");
    }
  });

  test.each(["settings_applications", "homee"])(
    "rejects removed or misspelled %s with an actionable suggestion in both validators",
    (name) => {
      const expected = name === "homee" ? "home" : "settings";
      const result = validatePrototypeSpec(specWith({ name }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.path).toBe("root.name");
        expect(result.error.message).toContain(`Unknown prototype icon name "${name}"`);
        expect(result.error.message).toContain(`"${expected}"`);
        expect(result.error.message).toContain("Did you mean");
      }
      const parsed = prototypeSpecSchema.safeParse(specWith({ name }));
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toContain(`"${expected}"`);
        expect(parsed.error.issues[0]?.message).toContain("Did you mean");
      }
    },
  );

  test("no contract field keeps its own copy of the icon-name list", () => {
    const { iconName, ...rest } = contract.definitions;
    expect(iconName.values.length).toBe(300);
    expect(staleIconEnums(rest, "definitions", [])).toEqual([]);
  });
});
