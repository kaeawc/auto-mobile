import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import { Explore } from "../../src/features/navigation/Explore";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { DefaultPathOptimizer } from "../../src/features/navigation/DefaultPathOptimizer";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../src/db/testCoverageRepository";
import { createMcpServer } from "../../src/server/index";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createJSONToolResponse } from "../../src/utils/toolUtils";
import { setDebugModeEnabled } from "../../src/utils/debug";
import { serverConfig } from "../../src/utils/ServerConfig";
import { installInMemoryNavManager, type InMemoryNavManagerHarness } from "../helpers/navigationTestHarness";
import { FakeTimer } from "../fakes/FakeTimer";
import type { SessionToolProfileService } from "../../src/features/toolCapabilities/SessionToolProfileService";

describe("Android navigation graph workflow (#4459)", () => {
  const device: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel API 35",
    platform: "android",
  };
  const appId = "com.example.navigation-fixture";
  let harness: InMemoryNavManagerHarness;

  beforeEach(async () => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(false);
    harness = await installInMemoryNavManager();
  });

  afterEach(async () => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(false);
    await harness.dispose();
  });

  test("serves the debug-gated navigation tools through MCP tools/list", async () => {
    setDebugModeEnabled(true);
    serverConfig.setEmbeddedSdkEnabled(true);
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async () => true,
    };
    const server = createMcpServer({ sessionToolProfileService: profileService });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "navigation-workflow-test", version: "0.0.1" });
    await client.connect(clientTransport);

    try {
      const result = await client.request({ method: "tools/list", params: {} }, z.object({
        tools: z.array(z.object({ name: z.string() }).passthrough())
      }));
      const toolNames = result.tools.map(tool => tool.name);

      expect(toolNames).toEqual(expect.arrayContaining([
        "explore",
        "getNavigationGraph",
        "navigateTo",
      ]));
    } finally {
      await client.close();
    }
  });

  test("discovers, inspects, and replays a learned Android path within one session", async () => {
    const sessionUuid = "android-navigation-session";
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sessionManager = NavigationGraphManager.createForTesting(
      new NavigationRepository(harness.db),
      new TestCoverageRepository(undefined, harness.db),
      timer
    );
    NavigationGraphManager.setInstanceForSessionForTesting(sessionUuid, sessionManager);
    expect(harness.manager.getCurrentScreen()).toBeNull();

    await sessionManager.recordNavigationEvent({
      destination: "Home",
      source: "ANDROID_FIXTURE",
      arguments: {},
      metadata: {},
      timestamp: 1,
      sequenceNumber: 1,
      applicationId: appId,
    });
    await sessionManager.recordBackStack({ depth: 0, currentTaskId: 1 });

    let replayedArgs: Record<string, unknown> | undefined;
    ToolRegistry.register(
      "tapOn",
      "Deterministic Android fixture tap",
      z.object({}),
      async args => {
        replayedArgs = args;
        await sessionManager.recordNavigationEvent({
          destination: "Settings",
          source: "ANDROID_FIXTURE",
          arguments: {},
          metadata: {},
          timestamp: 3,
          sequenceNumber: 3,
          applicationId: appId,
        });
        return createJSONToolResponse({ success: true });
      }
    );
    const explore = new Explore(device, { executeCommand: async () => "" } as never, timer, sessionManager);
    (explore as any).observeScreen = {
      execute: async () => ({
        viewHierarchy: {
          hierarchy: {
            node: [{
              $: {
                "class": "android.widget.Button",
                "text": "Settings",
                "resource-id": "com.example:id/settings",
                "clickable": "true",
                "enabled": "true",
              },
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            }],
          },
          packageName: appId,
        },
      }),
    };
    (explore as any).performInteraction = async () => {
      sessionManager.recordToolCall("tapOn", { text: "Settings", action: "tap", platform: "android" });
      await sessionManager.recordNavigationEvent({
        destination: "Settings",
        source: "ANDROID_FIXTURE",
        arguments: {},
        metadata: {},
        timestamp: 2,
        sequenceNumber: 2,
        applicationId: appId,
      });
      return true;
    };
    const exploration = await explore.execute({
      maxInteractions: 1,
      timeoutMs: 5000,
      packageName: appId,
    });
    expect(exploration).toMatchObject({ success: true, interactionsPerformed: 1, screensDiscovered: 1 });

    setDebugModeEnabled(true);
    serverConfig.setEmbeddedSdkEnabled(true);
    registerNavigationTools();

    const graphTool = ToolRegistry.getTool("getNavigationGraph");
    expect(graphTool).toBeDefined();
    const observationSpy = spyOn(RealObserveScreen, "getRecentCachedResultForDevice").mockReturnValue({
      viewHierarchy: { packageName: appId },
    } as never);
    const graphResponse = await (async () => {
      try {
        return await graphTool!.deviceAwareHandler!(device, { platform: "android", sessionUuid });
      } finally {
        observationSpy.mockRestore();
      }
    })();
    const graph = JSON.parse(graphResponse.content[0].text);
    expect(graph).toMatchObject({
      currentScreen: "Settings",
      nodeCount: 2,
      edgeCount: 1,
      knownEdges: 1,
      unknownEdges: 0,
    });
    expect(graph.screens.map((screen: { name: string }) => screen.name)).toEqual(["Home", "Settings"]);
    expect(graph.transitions).toContainEqual(expect.objectContaining({
      from: "Home",
      to: "Settings",
      tool: "tapOn",
    }));
    await sessionManager.recordBackStack({ depth: 1, currentTaskId: 1 });
    const backRecommendation = await new DefaultPathOptimizer(sessionManager).shouldUseBackButton(
      "Settings",
      "Home",
      1
    );
    expect(backRecommendation).toMatchObject({ shouldUseBack: true, backPresses: 1 });

    await sessionManager.recordNavigationEvent({
      destination: "Home",
      source: "ANDROID_FIXTURE",
      arguments: {},
      metadata: {},
      timestamp: 4,
      sequenceNumber: 4,
      applicationId: appId,
    });
    const navigateTool = ToolRegistry.getTool("navigateTo");
    const response = await navigateTool!.deviceAwareHandler!(device, {
      targetScreen: "Settings",
      platform: "android",
      sessionUuid,
    });
    const result = JSON.parse(response.content[0].text);
    expect(result).toMatchObject({
      success: true,
      currentScreen: "Settings",
      targetScreen: "Settings",
      stepsExecuted: 1,
    });
    expect(replayedArgs).toMatchObject({ text: "Settings", action: "tap", platform: "android" });
  });
});
