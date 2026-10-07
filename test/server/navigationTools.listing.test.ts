import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { serverConfig } from "../../src/utils/ServerConfig";

const NAVIGATION_TOOLS = ["explore", "navigateTo", "getNavigationGraph"];

const registered = (name: string): RegisteredTool =>
  (ToolRegistry as unknown as { tools: Map<string, RegisteredTool> }).tools.get(name)!;

describe("navigation tools listing (#4459)", () => {
  const originalDebug = isDebugModeEnabled();
  const originalEmbedded = serverConfig.isEmbeddedSdkEnabled();

  beforeEach(() => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(true);
    registerNavigationTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(originalDebug);
    serverConfig.setEmbeddedSdkEnabled(originalEmbedded);
  });

  test("explore, navigateTo and getNavigationGraph are listed without --debug", () => {
    const listed = ToolRegistry.getToolDefinitions().map((tool) => tool.name);
    expect(listed.filter((name) => NAVIGATION_TOOLS.includes(name)).sort()).toEqual(
      [...NAVIGATION_TOOLS].sort(),
    );
  });

  test("the only remaining gate is embedded SDK mode", () => {
    serverConfig.setEmbeddedSdkEnabled(false);
    const listed = ToolRegistry.getToolDefinitions().map((tool) => tool.name);
    for (const name of NAVIGATION_TOOLS) {
      expect(listed).not.toContain(name);
      const reasons = ToolRegistry.getToolAvailabilityGateReasons(registered(name));
      expect(reasons).toEqual([expect.stringContaining("--embedded-sdk")]);
    }
  });

  test("none are marked debugOnly or enabled by default", () => {
    for (const name of NAVIGATION_TOOLS) {
      const tool = registered(name);
      expect(tool.debugOnly).toBe(false);
      expect(tool.defaultEnabled).toBe(false);
      expect(tool.embeddedSdkOnly).toBe(true);
    }
  });
});
