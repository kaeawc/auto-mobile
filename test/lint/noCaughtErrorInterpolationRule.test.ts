import { describe, expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

function fires(code: string): boolean {
  return runRule(plugin.rules["no-caught-error-interpolation"], code).length > 0;
}

describe("auto-mobile/no-caught-error-interpolation", () => {
  test("flags caught error interpolation", () => {
    expect(fires("try {} catch (error) { throw new ActionableError(`Failed: ${error}`); }")).toBe(
      true,
    );
  });

  test("flags destructured catch bindings", () => {
    expect(
      fires("try {} catch ({ cause }) { throw new ActionableError(`Failed: ${cause}`); }"),
    ).toBe(true);
  });

  test("does not flag unrelated template interpolation", () => {
    expect(fires("try {} catch (error) { throw new ActionableError(`Failed: ${id}`); }")).toBe(
      false,
    );
  });

  test("does not flag ordinary template construction", () => {
    expect(fires("throw new ActionableError(`Failed: ${error}`);")).toBe(false);
  });
});
