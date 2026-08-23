import { describe, expect, test } from "bun:test";
import { FEATURE_FLAG_DEFINITIONS } from "../../../src/features/featureFlags/FeatureFlagDefinitions";

describe("FEATURE_FLAG_DEFINITIONS", () => {
  const REQUIRED_KEYS = ["defaultValue", "description", "key", "label"];
  // `defaultConfig` is the one optional field on FeatureFlagDefinition.
  const ALLOWED_KEYS = new Set([...REQUIRED_KEYS, "defaultConfig"]);

  test("every definition carries the required fields and no unexpected extras", () => {
    // Catches a dropped `description` (a required key goes missing) or a stray
    // field a loose "has a key" assertion would miss, while permitting the single
    // optional `defaultConfig`.
    for (const definition of FEATURE_FLAG_DEFINITIONS) {
      const keys = Object.keys(definition);
      for (const required of REQUIRED_KEYS) {
        expect(keys).toContain(required);
      }
      for (const key of keys) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    }
  });

  test("every field is well-typed and non-empty", () => {
    for (const definition of FEATURE_FLAG_DEFINITIONS) {
      expect(typeof definition.key).toBe("string");
      expect(definition.key.length).toBeGreaterThan(0);
      expect(typeof definition.label).toBe("string");
      expect(definition.label.length).toBeGreaterThan(0);
      expect(typeof definition.description).toBe("string");
      expect(definition.description.length).toBeGreaterThan(0);
      expect(typeof definition.defaultValue).toBe("boolean");
    }
  });

  test("flag keys are unique", () => {
    const keys = FEATURE_FLAG_DEFINITIONS.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
