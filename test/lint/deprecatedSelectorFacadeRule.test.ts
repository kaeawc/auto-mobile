import { describe, expect, test } from "bun:test";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

const FACADE = "selectByText/selectByResourceId/selectByTestTag/selectClickable* are deprecated";

function lint(code: string, filename: string): boolean {
  return runRule(plugin.rules["no-deprecated-selector-facade"], code, filename).some((message) =>
    message.startsWith(FACADE),
  );
}

describe("auto-mobile/no-deprecated-selector-facade", () => {
  const call = `export const probe = (selector: any) => selector.selectByText(capture, "Save");\n`;

  test.each([
    "selectByText",
    "selectByResourceId",
    "selectByTestTag",
    "selectClickable",
    "selectClickableSiblingOfText",
    "selectClickableSiblingOfResourceId",
  ])("flags %s outside the allowed files", (method) => {
    expect(lint(call.replace("selectByText", method), "src/features/action/SetUIState.ts")).toBe(
      true,
    );
  });

  test("flags an element-access call too", () => {
    expect(
      lint(
        `export const probe = (s: any) => s["selectByText"](c, "x");\n`,
        "src/features/navigation/Explore.ts",
      ),
    ).toBe(true);
  });

  test("allows the adapter itself and the two tap actions that still use it", () => {
    for (const file of [
      "src/features/utility/ResolverElementSelector.ts",
      "src/features/action/TapOnElement.ts",
      "src/features/action/TapAnyElement.ts",
    ]) {
      expect(lint(call, file)).toBe(false);
    }
  });

  test("allows the single entry point and files outside src", () => {
    expect(
      lint(
        `export const probe = (s: any) => s.select(capture, { text: "Save" });\n`,
        "src/features/action/SetUIState.ts",
      ),
    ).toBe(false);
    expect(lint(call, "test/features/action/SetUIState.test.ts")).toBe(false);
  });
});
