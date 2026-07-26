import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { BootedDevice } from "../../src/models";
import { NavigateTo } from "../../src/features/navigation/NavigateTo";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createJSONToolResponse } from "../../src/utils/toolUtils";
import { setDebugModeEnabled } from "../../src/utils/debug";
import { installInMemoryNavManager, type InMemoryNavManagerHarness } from "../helpers/navigationTestHarness";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import type { ScreenTransitionWaiter } from "../../src/features/navigation/interfaces/ScreenTransitionWaiter";
import type { UIStateSetup } from "../../src/features/navigation/interfaces/UIStateSetup";

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
    harness = await installInMemoryNavManager();
  });

  afterEach(async () => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(false);
    await harness.dispose();
  });

  test("creates and inspects a graph, replays its learned Android path, and serves every navigation tool without --debug", async () => {
    const homeTimestamp = Date.now();
    await harness.manager.recordNavigationEvent({
      destination: "Home",
      source: "ANDROID_FIXTURE",
      arguments: {},
      metadata: {},
      timestamp: homeTimestamp,
      sequenceNumber: 1,
      applicationId: appId,
    });
    harness.manager.recordToolCall("tapOn", { text: "Settings", action: "tap", platform: "android" });
    const settingsTimestamp = Date.now();
    await harness.manager.recordNavigationEvent({
      destination: "Settings",
      source: "ANDROID_FIXTURE",
      arguments: {},
      metadata: {},
      timestamp: settingsTimestamp,
      sequenceNumber: 2,
      applicationId: appId,
    });
    const returnHomeTimestamp = Date.now();
    await harness.manager.recordNavigationEvent({
      destination: "Home",
      source: "ANDROID_FIXTURE",
      arguments: {},
      metadata: {},
      timestamp: returnHomeTimestamp,
      sequenceNumber: 3,
      applicationId: appId,
    });

    let replayedArgs: Record<string, unknown> | undefined;
    ToolRegistry.register(
      "tapOn",
      "Deterministic Android fixture tap",
      z.object({}),
      async args => {
        replayedArgs = args;
        await harness.manager.recordNavigationEvent({
          destination: "Settings",
          source: "ANDROID_FIXTURE",
          arguments: {},
          metadata: {},
          timestamp: Date.now(),
          sequenceNumber: 4,
          applicationId: appId,
        });
        return createJSONToolResponse({ success: true });
      }
    );
    registerNavigationTools();

    const served = new Map(ToolRegistry.getAllTools().map(tool => [tool.name, tool]));
    for (const name of ["explore", "navigateTo", "getNavigationGraph"]) {
      expect(served.get(name)?.requiresDevice).toBe(true);
    }

    const graphTool = ToolRegistry.getTool("getNavigationGraph");
    expect(graphTool).toBeDefined();
    const graphResponse = await graphTool!.deviceAwareHandler!(device, { platform: "android" });
    const graph = JSON.parse(graphResponse.content[0].text);
    expect(graph).toMatchObject({
      currentScreen: "Home",
      nodeCount: 2,
      edgeCount: 2,
      knownEdges: 2,
      unknownEdges: 0,
    });
    expect(graph.screens.map((screen: { name: string }) => screen.name)).toEqual(["Home", "Settings"]);
    expect(graph.transitions).toContainEqual(expect.objectContaining({
      from: "Home",
      to: "Settings",
      tool: "tapOn",
    }));

    const uiStateSetup: UIStateSetup = {
      setupUIState: async () => [],
      setupScrollPosition: async () => null,
    };
    const screenWaiter: ScreenTransitionWaiter = {
      waitForScreen: async screen => harness.manager.getCurrentScreen() === screen,
    };
    const timer = new FakeTimer();
    const navigateTo = new NavigateTo(
      device,
      new FakeAdbClientFactory(),
      uiStateSetup,
      screenWaiter,
      harness.manager,
      timer
    );

    const result = await navigateTo.execute({ targetScreen: "Settings", platform: "android" });

    expect(result).toMatchObject({
      success: true,
      currentScreen: "Settings",
      targetScreen: "Settings",
      stepsExecuted: 1,
    });
    expect(replayedArgs).toMatchObject({ text: "Settings", action: "tap", platform: "android" });
  });
});
