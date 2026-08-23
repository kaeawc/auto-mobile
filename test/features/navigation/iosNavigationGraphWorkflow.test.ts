import { afterEach, describe, expect, test } from "bun:test";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import {
  DefaultIosSdkEventIngestor,
  type IosTelemetryRecorder,
} from "../../../src/features/observe/ios/IosSdkEventIngestor";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "../../../src/server/internalToolCall";
import type { BootedDevice } from "../../../src/models";
import type { SdkEvent } from "../../../src/features/observe/interfaces/SdkEventIngestor";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ScreenTransitionWaiter } from "../../../src/features/navigation/interfaces/ScreenTransitionWaiter";

const iOSDevice: BootedDevice = {
  deviceId: "ios-simulator-navigation-workflow",
  platform: "ios",
  source: "local",
} as BootedDevice;

const noOpTelemetryRecorder: IosTelemetryRecorder = {
  getContext: () => ({ deviceId: null, sessionId: null }),
  setContext: () => {},
  recordNetworkEvent: async () => {},
  recordLogEvent: async () => {},
  recordOsEvent: async () => {},
  recordNavigationEvent: async () => {},
  recordStorageEvent: async () => {},
  recordLayoutEvent: async () => {},
};

describe("iOS navigation-event graph workflow", () => {
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("ingests SDK events, reports the learned graph, and replays its iOS path", async () => {
    const graph = new FakeNavigationGraphManager();
    const ingestor = new DefaultIosSdkEventIngestor({
      deviceId: iOSDevice.deviceId,
      getNavigationGraphManager: () => graph,
      captureScreenshot: async () => ({ success: false }),
      telemetryRecorder: noOpTelemetryRecorder,
      navigationScreenshotsEnabled: () => false,
    });
    const navigationEvent = (destination: string): SdkEvent => ({
      type: "navigation",
      timestamp: Date.now(),
      payload: { destination, source: "swiftui_navigation", arguments: {}, metadata: {} },
    });

    await ingestor.recordSdkEvent(
      navigationEvent("Home"),
      "dev.jasonpearson.automobile.Playground",
    );
    graph.recordToolCall("tapOn", { text: "Settings", action: "tap", platform: "ios" });
    await ingestor.recordSdkEvent(
      navigationEvent("Settings"),
      "dev.jasonpearson.automobile.Playground",
    );

    const graphReport = await graph.exportGraph();
    expect(graphReport.nodes.map((node) => node.screenName)).toEqual(["Home", "Settings"]);
    expect(graphReport.edges).toHaveLength(1);
    expect(graphReport.edges[0]).toMatchObject({
      from: "Home",
      to: "Settings",
      interaction: { toolName: "tapOn", args: { text: "Settings", platform: "ios" } },
    });

    // Model the iOS back action that returns the user to the learned source screen.
    graph.setCurrentScreenValue("Home");
    let replayArgs: Record<string, unknown> | undefined;
    ToolRegistry.register("tapOn", "tapOn", {}, async (args) => {
      replayArgs = args;
      return { success: true };
    });
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const screenWaiter: ScreenTransitionWaiter = {
      waitForScreen: async (screen) => screen === "Settings",
    };
    const navigateTo = new NavigateTo(
      iOSDevice,
      new FakeAdbClientFactory(),
      null,
      screenWaiter,
      graph,
      timer,
    );

    const replay = await navigateTo.execute({ targetScreen: "Settings", platform: "ios" });

    expect(replay.success).toBe(true);
    expect(replay.path).toEqual(['tapOn({"text":"Settings","action":"tap","platform":"ios"})']);
    expect(replayArgs).toEqual({
      text: "Settings",
      action: "tap",
      platform: "ios",
      deviceId: "ios-simulator-navigation-workflow",
      [INTERNAL_NO_DIFF_PARAM]: true,
    });
  });
});
