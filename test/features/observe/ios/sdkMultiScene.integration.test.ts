import type { WebSocketMessage } from "../../../../src/features/observe/ios/types";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { decodeCtrlProxyMessage } from "../../../../src/features/observe/ios/decodeCtrlProxyMessage";
import { createIosSdkBridgeReader } from "../../../../src/features/observe/ios/IosSdkBridgeReader";
import { IosSdkMultiSceneError } from "../../../../src/features/observe/ios/sdkObservationBridge";
import { RealObserveScreen } from "../../../../src/features/observe/ObserveScreen";
import { registerObserveTools } from "../../../../src/server/observeTools";
import { ToolRegistry } from "../../../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { FakeDeviceStateCollector } from "../../../fakes/FakeDeviceStateCollector";
import { FakeIosLockStateProbe } from "../../../fakes/FakeIosLockStateProbe";
import { FakeObserveCacheStore } from "../../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../../fakes/FakeScreenshotStateStore";
import { noopObserveAudits } from "../../../fakes/noopObserveAudits";
import { createReplayWebSocketFactory } from "../../../fakes/ReplayCtrlProxyWebSocket";
import { isolateToolRegistry } from "../../../helpers/withTemporaryTool";
import type { RecordedExchange } from "../../../fakes/ReplayCtrlProxyWebSocket";

// Expected Swift encoder bytes, following ResponseContractFixtureTests' sorted-key and timestamp
// normalization pattern. Swift execution/capture is unavailable in this implementation lane.
const fixtureDir = new URL("../../../fixtures/ios-contract/", import.meta.url);
const httpBody = JSON.parse(
  readFileSync(new URL("sdk-multi-scene-http.json", fixtureDir), "utf8"),
) as {
  error: string;
  scenes: string[];
};
const contract = JSON.parse(readFileSync(new URL("runner-responses.json", fixtureDir), "utf8")) as {
  responses: Array<{ name: string; wire: WebSocketMessage & Record<string, unknown> }>;
};
const message =
  "The app has 2 connected scenes (scene-a, scene-b). SDK observation needs one scene; XCTest does not stand in for this result.";
const device = { deviceId: "multi-scene-fake", name: "Fake iPhone", platform: "ios" as const };
isolateToolRegistry();
let client: IOSCtrlProxyClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

test("SDK 409 contract survives CtrlProxy decoding, client transport, reader and observe MCP handler without fallback", async () => {
  const wire = contract.responses.find(({ name }) => name === "sdk_observation_multi_scene")!.wire;
  // This is the Swift relay's fixture boundary; the TS test does not reimplement that relay.
  expect(httpBody).toEqual({ error: "multi_scene", scenes: ["scene-a", "scene-b"] });
  expect(wire.failure).toBe(httpBody.error);
  expect(wire.scenes).toEqual(httpBody.scenes);
  expect(decodeCtrlProxyMessage(wire)?.result).toMatchObject({
    failure: "multi_scene",
    scenes: httpBody.scenes,
  });
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const exchanges: RecordedExchange[] = [
    {
      fileName: "capabilities",
      request: { type: "get_sdk_capabilities" },
      response: {
        type: "sdk_capabilities_result",
        success: true,
        available: true,
        bundleId: "fixture.app",
        observationBridge: { schemaVersion: 1, available: true, supportedActions: ["tap"] },
      },
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      fileName: `snapshot-${index}`,
      request: { type: "request_sdk_observation" },
      response: wire,
    })),
  ];
  const replay = createReplayWebSocketFactory(exchanges, timer);
  client = IOSCtrlProxyClient.createForTesting(device, 8791, { wsFactory: replay.factory, timer });
  const reader = createIosSdkBridgeReader({
    client: () => client ?? null,
    enabled: () => true,
    timer,
  });
  // Assert the actual request method preserves the typed reply before testing the next boundary.
  expect(await client.requestSdkObservationForIos()).toMatchObject({
    failure: "multi_scene",
    scenes: httpBody.scenes,
  });
  replay.sockets[0].simulateMessage(
    JSON.stringify({
      type: "connected",
      supportedCommands: ["get_sdk_capabilities", "request_sdk_observation"],
    }),
  );
  await expect(reader.observe("fixture.app")).rejects.toBeInstanceOf(IosSdkMultiSceneError);

  const viewHierarchy = new FakeViewHierarchy();
  viewHierarchy.configureHierarchy({
    packageName: "fixture.app",
    screenWidth: 390,
    screenHeight: 844,
    hierarchy: {
      node: {
        $: {
          class: "XCUIElementTypeApplication",
          bounds: { left: 0, top: 0, right: 390, bottom: 844 },
        },
      },
    },
  });
  const lock = new FakeIosLockStateProbe();
  lock.reading = { kind: "known", lock: { locked: false, keyguardShowing: false } };
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      viewHierarchy,
      sdkBridge: () => reader,
      window: new FakeWindow(),
      deviceStateCollector: new FakeDeviceStateCollector(false),
      iosLockStateProbe: lock,
      cacheStore: new FakeObserveCacheStore(timer),
      screenshotStateStore: new FakeScreenshotStateStore(timer),
      ...noopObserveAudits(),
    },
    { timer },
  );
  registerObserveTools({ createScreen: () => screen, timer });
  const tool = ToolRegistry.getTool("observe")!;
  const outcome = await tool.deviceAwareHandler!(
    device,
    tool.schema.parse({ screenshot: "none" }),
  ).then(
    () => {
      throw new Error("observe returned an XCTest fallback");
    },
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(IosSdkMultiSceneError);
  expect(outcome).toMatchObject({ failure: "multi_scene", scenes: httpBody.scenes, message });
  expect(replay.sockets.flatMap((socket) => socket.unmatchedRequests)).toEqual([]);
  expect(
    replay.sockets.flatMap((socket) => socket.sentRequests).map((request) => request.type),
  ).not.toContain("request_tap_coordinates");
  expect(timer.getSleepHistory()).toEqual([]);
});
