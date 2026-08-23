import { describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";
import { PLAN_YAML_LOAD_OPTIONS } from "../../../src/utils/plan/planYaml";

describe("PLAN_YAML_LOAD_OPTIONS", () => {
  test("loads YAML merge keys", () => {
    const loaded = yaml.load(
      `
defaults: &defaults
  tool: tapOn
  params:
    selector:
      text: Save
step:
  <<: *defaults
  label: Tap save
`,
      PLAN_YAML_LOAD_OPTIONS,
    ) as {
      step: {
        tool: string;
        params: { selector: { text: string } };
        label: string;
      };
    };

    expect(loaded.step).toEqual({
      tool: "tapOn",
      params: { selector: { text: "Save" } },
      label: "Tap save",
    });
  });

  test("keeps timestamp-like plain scalars as strings", () => {
    const loaded = yaml.load("when: 12:30:00\n", PLAN_YAML_LOAD_OPTIONS) as { when: unknown };

    expect(loaded.when).toBe("12:30:00");
  });
});
