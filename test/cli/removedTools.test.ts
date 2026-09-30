import { describe, expect, test } from "bun:test";
import { formatDaemonToolError, getRemovedToolReplacement } from "../../src/cli/removedTools";

describe("removed tool registry", () => {
  test("documents removed tools and their replacements", () => {
    expect(getRemovedToolReplacement("captureScreenshot")).toBe(
      'observe {screenshot:"settled"} (returns screenshotPath)',
    );
    expect(getRemovedToolReplacement("inputText")).toBe("sendKeys");
    expect(getRemovedToolReplacement("clearText")).toBe("sendKeys");
    expect(getRemovedToolReplacement("imeAction")).toBe("sendKeys");
    expect(getRemovedToolReplacement("missing-tool")).toBeUndefined();
  });

  test("recommends replacements for removed tools without a restart hint", () => {
    expect(formatDaemonToolError("captureScreenshot", 'Unknown tool "captureScreenshot".')).toBe(
      'captureScreenshot was removed; use observe {screenshot:"settled"} (returns screenshotPath)',
    );
  });

  test("keeps one period and a restart hint for unknown tools", () => {
    expect(formatDaemonToolError("otherTool", 'Unknown tool "otherTool".')).toBe(
      'Error calling daemon: Unknown tool "otherTool". Try: auto-mobile --daemon restart',
    );
  });
});
