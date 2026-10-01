import { describe, expect, test } from "bun:test";
import { formatDaemonToolError } from "../../src/cli/removedTools";

describe("removed tool registry", () => {
  test("recommends replacements for removed tools without a restart hint", () => {
    expect(formatDaemonToolError("captureScreenshot", 'Unknown tool "captureScreenshot".')).toBe(
      'captureScreenshot was removed; use observe {screenshot:"settled"} (returns screenshotPath)',
    );
    expect(formatDaemonToolError("debugSearch", 'Unknown tool "debugSearch".')).toBe(
      "debugSearch was removed; use observe to see elements, and the diagnostics returned by tapOn/waitFor failures",
    );
  });

  test("keeps one period and a restart hint for unknown tools", () => {
    expect(formatDaemonToolError("otherTool", 'Unknown tool "otherTool".')).toBe(
      'Error calling daemon: Unknown tool "otherTool". Try: auto-mobile --daemon restart',
    );
  });
});
