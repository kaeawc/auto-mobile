import { expect, test } from "bun:test";
import {
  REMOVED_TOOLS,
  getRemovedToolHint,
  getRemovedToolReplacement,
} from "../../src/models/removedTools";
import { formatDaemonToolError } from "../../src/cli/removedTools";

test("one removed-tool table supplies the same replacement sentence to all paths", () => {
  expect(REMOVED_TOOLS).toEqual({
    captureScreenshot: 'observe {screenshot:"settled"} (returns screenshotPath)',
    inputText: "sendKeys",
    clearText: "sendKeys",
    imeAction: "sendKeys",
    debugSearch: "observe to see elements, and the diagnostics returned by tapOn/waitFor failures",
  });
  for (const [tool, replacement] of Object.entries(REMOVED_TOOLS)) {
    const sentence = `${tool} was removed; use ${replacement}`;
    expect(getRemovedToolReplacement(tool)).toBe(replacement);
    expect(getRemovedToolHint(tool)).toBe(sentence);
    expect(formatDaemonToolError(tool, `Unknown tool "${tool}".`)).toBe(sentence);
    expect(`Unknown tool "${tool}". ${getRemovedToolHint(tool)}`).toContain(sentence);
    expect(`Unknown tool: ${tool}. ${getRemovedToolHint(tool)}`).toContain(sentence);
  }
  expect(getRemovedToolReplacement("missing-tool")).toBeUndefined();
  expect(getRemovedToolHint("missing-tool")).toBeUndefined();
});
