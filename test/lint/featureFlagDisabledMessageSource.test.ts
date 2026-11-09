import { describe, expect, test } from "bun:test";
import {
  bespokeFlagDisabledMessages,
  scanBespokeFlagMessages,
  scanHelperKeys,
} from "./featureFlagDisabledMessageSource";

// Scan src/ once, outside the timed test bodies.
const bespoke = bespokeFlagDisabledMessages();

describe("flag-disabled refusals come from featureFlagDisabledMessage (#16906)", () => {
  test("no src/ file hand-writes a flag-disabled message", () => {
    expect(
      bespoke.map(({ file, line, text }) => `${file}:${line} ${JSON.stringify(text)}`),
      "Use featureFlagDisabledMessage(key, toolName) and add the gate to featureFlagGatedRefusals.test.ts",
    ).toEqual([]);
  });

  test("the scan catches string and template refusals but not unrelated flag text", () => {
    const source = [
      `const a = "x is behind the 'y' feature flag, which is disabled.";`,
      "const b = `Re-enable the ${key} feature flag first`;",
      `const c = "Read feature flag state and configuration by key";`,
    ].join("\n");
    expect(scanBespokeFlagMessages("probe.ts", source).map(({ line }) => line)).toEqual([1, 2]);
  });

  test("helper keys must be string literals", () => {
    expect(scanHelperKeys("probe.ts", `featureFlagDisabledMessage("debug", name);`)).toEqual([
      "debug",
    ]);
    expect(() => scanHelperKeys("probe.ts", "featureFlagDisabledMessage(key, name);")).toThrow(
      "string-literal flag key",
    );
  });
});
