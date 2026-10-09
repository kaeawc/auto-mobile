import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import type { CtrlProxyNode } from "../../../../src/features/observe/ios/types";
import type { BootedDevice } from "../../../../src/models";
import { NetworkState } from "../../../../src/server/NetworkState";
import { serverConfig } from "../../../../src/utils/ServerConfig";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  createReplayWebSocketFactory,
  loadRecordedExchanges,
  type RecordedExchange,
  type ReplayCtrlProxyWebSocket,
} from "../../../fakes/ReplayCtrlProxyWebSocket";

// Captured from a real runner on an iPhone 17 / iOS 26.5 simulator with
// scripts/ios/capture-ctrlproxy-golden.ts (issue #5837): launch Settings,
// observe, tap the "General" row, observe again.
const SETTINGS_TAP_GENERAL = path.resolve(
  import.meta.dir,
  "../../../fixtures/ios/ctrlproxy-golden/settings-tap-general",
);

function labels(root: CtrlProxyNode): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.shift() as CtrlProxyNode;
    if (node.text) {
      found.push(node.text);
    }
    const children = node.node ?? [];
    stack.push(...(Array.isArray(children) ? children : [children]));
  }
  return found;
}

describe("IOSCtrlProxyClient golden replay (Settings, tap General)", () => {
  const device: BootedDevice = {
    deviceId: "5AA36BC6-B742-407D-9015-4C5452BD11F8",
    platform: "ios",
    name: "dv-golden",
  };
  let exchanges: RecordedExchange[];
  let sockets: ReplayCtrlProxyWebSocket[];
  let client: IOSCtrlProxyClient;

  beforeEach(() => {
    IOSCtrlProxyClient.resetInstances();
    NetworkState.resetInstance();
    serverConfig.setNetworkMockableEnabled(false);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    exchanges = loadRecordedExchanges(SETTINGS_TAP_GENERAL);
    const replay = createReplayWebSocketFactory(exchanges, timer);
    sockets = replay.sockets;
    client = IOSCtrlProxyClient.createForTesting(device, 8791, replay.factory, timer);
  });

  afterEach(async () => {
    await client.close();
    NetworkState.resetInstance();
  });

  test("the fixture is a real capture of the full round trip", () => {
    expect(exchanges.map((exchange) => exchange.fileName)).toContain("0001-push-connected.json");
    expect(
      exchanges.filter((exchange) => exchange.response).map((exchange) => exchange.request?.type),
    ).toEqual([
      "request_launch_app",
      "get_sdk_capabilities",
      "get_sdk_capabilities",
      "request_hierarchy_if_stale",
      "request_tap_coordinates",
      "request_hierarchy_if_stale",
    ]);
  });

  test("observe of the Settings root decodes the recorded hierarchy", async () => {
    const launched = await client.requestLaunchApp("com.apple.Preferences");
    expect(launched.success).toBe(true);

    const synced = await client.requestHierarchySync();

    expect(synced?.hierarchy.packageName).toBe("com.apple.Preferences");
    expect(synced?.hierarchy.screenWidth).toBe(402);
    expect(labels(synced!.hierarchy.hierarchy)).toEqual(
      expect.arrayContaining(["General", "Accessibility", "Camera"]),
    );
  });

  test("tapOn General round trip: tap the row centre, then observe the General screen", async () => {
    await client.requestLaunchApp("com.apple.Preferences");
    const before = await client.requestHierarchySync();
    // The recorded General row spans x 16-386, y 380-432; the capture tapped its centre.
    expect(labels(before!.hierarchy.hierarchy)).toContain("General");

    const tap = await client.requestTapCoordinates(201, 406);
    expect(tap.success).toBe(true);
    const after = await client.requestHierarchySync();

    expect(labels(after!.hierarchy.hierarchy)).toEqual(
      expect.arrayContaining(["About", "Keyboard", "Language & Region"]),
    );
    const sent = sockets.flatMap((socket) => socket.sentRequests);
    expect(sent.find((request) => request.type === "request_tap_coordinates")).toMatchObject({
      x: 201,
      y: 406,
    });
    expect(sockets.flatMap((socket) => socket.unmatchedRequests)).toEqual([]);
  });
});
