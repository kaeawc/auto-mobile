import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  EXPLORE_EMBEDDED_SDK_GATE_HINT,
  registerNavigationTools,
} from "../../src/server/navigationTools";
import { resolveTool } from "../../src/server/pipeline/ingress/routing";
import { EMBEDDED_SDK_GATE_REASON } from "../../src/server/toolRegistryTypes";
import { ToolUnavailableError } from "../../src/daemon/toolUnavailableError";
import { DAEMON_TOOL_UNAVAILABLE_CODE } from "../../src/daemon/types";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { serverConfig } from "../../src/utils/ServerConfig";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const NAVIGATION_TOOLS = ["explore", "navigateTo", "getNavigationGraph"];

const registered = (name: string): RegisteredTool => ToolRegistry.getRegisteredTool(name)!;

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

  test("explore's rejection names Apple TV and how to enable the flag (#17528)", () => {
    serverConfig.setEmbeddedSdkEnabled(false);
    expect(ToolRegistry.getToolAvailabilityGateReasons(registered("explore"))).toEqual([
      `${EMBEDDED_SDK_GATE_REASON}. ${EXPLORE_EMBEDDED_SDK_GATE_HINT}`,
    ]);
    expect(EXPLORE_EMBEDDED_SDK_GATE_HINT).toContain("Apple TV (tvOS)");
    expect(EXPLORE_EMBEDDED_SDK_GATE_HINT).toContain("Add --embedded-sdk");
    for (const name of ["navigateTo", "getNavigationGraph"]) {
      expect(ToolRegistry.getToolAvailabilityGateReasons(registered(name))).toEqual([
        EMBEDDED_SDK_GATE_REASON,
      ]);
    }
  });

  test("a tvOS explore call without --embedded-sdk is refused with a typed error carrying the hint", () => {
    serverConfig.setEmbeddedSdkEnabled(false);
    let caught: unknown;
    try {
      resolveTool("explore", { platform: "tvos" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolUnavailableError);
    const refusal = caught as ToolUnavailableError;
    expect(refusal.data).toEqual({ code: DAEMON_TOOL_UNAVAILABLE_CODE, toolName: "explore" });
    expect(refusal.message).toBe(
      `Unknown tool: explore. ${EMBEDDED_SDK_GATE_REASON}. ${EXPLORE_EMBEDDED_SDK_GATE_HINT}`,
    );
  });

  test("with --embedded-sdk explore resolves for a tvOS call", () => {
    expect(resolveTool("explore", { platform: "tvos" }).name).toBe("explore");
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
