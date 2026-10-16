import { beforeAll, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerAppTools } from "../../src/server/appTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/** Names of the registered tools declaring `recordsNavigation`, sorted. */
function navigationRecordingTools(): string[] {
  return [...ToolRegistry["tools"].values()]
    .filter((tool) => tool.recordsNavigation === true)
    .map((tool) => tool.name)
    .sort();
}

describe("recordsNavigation trait (formerly NAVIGATION_RELEVANT_TOOLS)", () => {
  beforeAll(() => {
    registerInteractionTools();
    registerAppTools();
    registerObserveTools();
  });

  test("is declared by exactly the UI-interaction tools that may cause navigation", () => {
    // The former NAVIGATION_RELEVANT_TOOLS set in toolRegistry.ts.
    expect(navigationRecordingTools()).toEqual([
      "dragAndDrop",
      "pinchOn",
      "pressButton",
      "sendKeys",
      "swipeOn",
      "tapOn",
    ]);
  });

  test("excludes app-lifecycle and observation tools", () => {
    for (const tool of ["launchApp", "terminateApp", "homeScreen", "observe", "installApp"]) {
      expect(ToolRegistry.getTool(tool)?.recordsNavigation).toBeUndefined();
    }
  });
});
