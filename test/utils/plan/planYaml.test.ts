import { describe, expect, test } from "bun:test";
import * as yaml from "js-yaml";
import { decodePlanContent, PLAN_YAML_LOAD_OPTIONS } from "../../../src/utils/plan/planYaml";

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

describe("decodePlanContent", () => {
  test("returns plain YAML unchanged", () => {
    expect(decodePlanContent("name: p\nsteps: []")).toBe("name: p\nsteps: []");
  });

  test("decodes a base64: prefixed value, including multi-byte text", () => {
    const text = "name: café\nsteps: []";
    const encoded = `base64:${Buffer.from(text, "utf-8").toString("base64")}`;
    expect(decodePlanContent(encoded)).toBe(text);
  });

  test("only a leading prefix counts", () => {
    expect(decodePlanContent("name: base64:QQ==")).toBe("name: base64:QQ==");
  });

  test("invalid base64 decodes leniently instead of throwing", () => {
    expect(() => decodePlanContent("base64:!!!not base64???")).not.toThrow();
    expect(decodePlanContent("base64:")).toBe("");
  });
});
