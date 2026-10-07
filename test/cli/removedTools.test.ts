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
    for (const toolName of ["stageSharedStorage", "stageSharedStorageFixtures"]) {
      expect(formatDaemonToolError(toolName, `Unknown tool "${toolName}".`)).toBe(
        `${toolName} was removed; use putAppFile with target.domain user_files (move namespace/reset/indexMedia into target; set indexMedia true to keep the old default)`,
      );
    }
  });

  test("keeps one period and a restart hint for unknown tools", () => {
    expect(formatDaemonToolError("otherTool", 'Unknown tool "otherTool".')).toBe(
      'Error calling daemon: Unknown tool "otherTool". Try: auto-mobile --daemon restart',
    );
  });

  test("a gated tool keeps its gate reason and gets no restart hint", () => {
    const message =
      'Tool "setUIState" is advertised by this AutoMobile client but is unavailable in the connected daemon\'s current configuration for this session. Daemon rejection: MCP error -32603: Unknown tool: setUIState. --debug is disabled.';
    expect(formatDaemonToolError("setUIState", message, { gated: true })).toBe(
      `Error calling daemon: ${message.replace(/[.]+$/, "")}.`,
    );
    expect(formatDaemonToolError("setUIState", message, { gated: true })).not.toContain("restart");
    expect(formatDaemonToolError("setUIState", message)).toContain(
      "Try: auto-mobile --daemon restart",
    );
  });
});
