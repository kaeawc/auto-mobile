import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import WebSocket from "ws";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { AccessibilityHierarchy } from "../../../src/features/observe/android/types";
import {
  ANDROID_CAPABILITY_FLAGS,
  ANDROID_CAPABILITY_GATED_COMMANDS,
  ANDROID_FULL_COMMAND_SET_CAPABILITY,
  ANDROID_ID_LESS_MESSAGE_TYPES,
  ANDROID_REQUEST_ID_ECHO_CAPABILITY,
  ANDROID_REQUEST_ID_RESPONSE_TYPES,
  KNOWN_REQUEST_TYPES,
  ctrlProxyMissingRequestIdError,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import { logger } from "../../../src/utils/logger";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";

const echoCapability = ANDROID_REQUEST_ID_ECHO_CAPABILITY;
const missingSwipeId =
  "Android service advertised request_id_echo_v1 but sent swipe_result without a requestId";

interface SentRequest {
  type: string;
  requestId: string;
}

class RecordingSocket extends FakeWebSocket {
  readonly sent: SentRequest[] = [];

  override send(data: string): void {
    super.send(data);
    this.sent.push(JSON.parse(data) as SentRequest);
  }
}

async function harness() {
  const timer = new FakeTimer();
  const socket = new RecordingSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "request-id-echo", platform: "android", name: "Android", isEmulator: true },
    new FakeAdbExecutor(),
    () => socket as unknown as WebSocket,
    timer,
    new FakeInstalledAppsRepository(),
  );
  await Promise.resolve(); // FakeWebSocket opens on a microtask, without real timers.
  client["ws"] = socket as unknown as WebSocket;
  spyOn(client, "ensureConnected").mockResolvedValue(true);
  // Keep hierarchy delivery on the real cache/waiter path, with downstream consumers neutralized.
  const streamPushes: string[] = [];
  client["pushHierarchyToObservationStream"] = (data) => {
    streamPushes.push(data.hierarchy?.text ?? "");
  };
  client["startScreenshotBackoff"] = () => {};
  client["shouldUseHierarchyNavigation"] = () => false;
  spyOn(client["deviceConnectionLostNotifier"], "onDeviceConnectionLost").mockImplementation(
    () => {},
  );
  const receive = (message: object) => client["handleWebSocketMessage"](JSON.stringify(message));
  const advertise = (commands: string[]) =>
    receive({ type: "connected", supportedCommands: commands });
  const waitForHierarchy = (requestId: string) =>
    client["hierarchy"]["waitForFreshData"](500, timer.now(), false, undefined, requestId);
  const pushHierarchy = (label: string, requestId?: string) => {
    const data: AccessibilityHierarchy = {
      updatedAt: timer.now(),
      packageName: "",
      hierarchy: { text: label },
    };
    return receive({ type: "hierarchy_update", data, requestId });
  };
  return {
    client,
    timer,
    socket,
    receive,
    advertise,
    waitForHierarchy,
    pushHierarchy,
    streamPushes,
  };
}

afterEach(() => {
  // Includes the global logger spy; restore after every test even when an assertion fails.
  mock.restore();
});

describe("Android request ID echo", () => {
  test("correlates concurrent swipe responses arriving in reverse order", async () => {
    const h = await harness();
    await h.advertise([echoCapability]);
    const first = h.client.requestSwipe(0, 0, 10, 10);
    const second = h.client.requestSwipe(0, 0, 20, 20);
    // The delegate awaits ensureConnected before registering/sending each request.
    await Promise.resolve();
    const requests = h.socket.sent.filter((message) => message.type === "request_swipe");
    expect(requests).toHaveLength(2);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    await h.receive({
      type: "swipe_result",
      requestId: requests[1].requestId,
      success: true,
      totalTimeMs: 22,
    });
    await h.receive({
      type: "swipe_result",
      requestId: requests[0].requestId,
      success: true,
      totalTimeMs: 11,
    });
    expect((await first).totalTimeMs).toBe(11);
    expect((await second).totalTimeMs).toBe(22);
  });

  test("correlates concurrent hierarchy waiters arriving in reverse order", async () => {
    const h = await harness();
    await h.advertise([echoCapability]);
    const first = h.waitForHierarchy("first");
    const second = h.waitForHierarchy("second");
    await h.pushHierarchy("second tree", "second");
    await h.pushHierarchy("first tree", "first");
    expect((await first)?.hierarchy.hierarchy.text).toBe("first tree");
    expect((await second)?.hierarchy.hierarchy.text).toBe("second tree");
  });

  test("advertisement prevents the first id-less push from satisfying a hierarchy waiter", async () => {
    const h = await harness();
    await h.advertise([echoCapability]);
    let settled = false;
    const pending = h.waitForHierarchy("requested").then((value) => {
      settled = true;
      return value;
    });
    await h.pushHierarchy("unsolicited");
    h.timer.advanceTime(50);
    await Promise.resolve();
    expect(h.client["cachedHierarchy"]?.hierarchy.hierarchy.text).toBe("unsolicited");
    expect(h.streamPushes).toEqual(["unsolicited"]);
    expect(h.client["hierarchy"]["pendingHierarchyRejectors"].has("requested")).toBe(true);
    expect(settled).toBe(false);
    await h.pushHierarchy("requested tree", "requested");
    expect((await pending)?.hierarchy.hierarchy.text).toBe("requested tree");
  });

  test("drops missing or empty result IDs and warns without assigning them to a waiter", async () => {
    const h = await harness();
    await h.advertise([echoCapability]);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    let settled = false;
    const pending = h.client.requestSwipe(0, 0, 10, 10).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    const request = h.socket.sent.find((message) => message.type === "request_swipe")!;
    for (const requestId of [undefined, ""]) {
      await h.receive({ type: "swipe_result", requestId, success: true, totalTimeMs: 999 });
    }
    expect(settled).toBe(false);
    expect(ctrlProxyMissingRequestIdError("swipe_result")).toBe(missingSwipeId);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([missingSwipeId, missingSwipeId]);
    await h.receive({
      type: "swipe_result",
      requestId: request.requestId,
      success: true,
      totalTimeMs: 7,
    });
    expect((await pending).totalTimeMs).toBe(7);
  });

  test("id-less hierarchy pushes and undecodable errors do not warn about correlation", async () => {
    const h = await harness();
    await h.advertise([echoCapability]);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    await h.pushHierarchy("push");
    expect(warn).not.toHaveBeenCalled();
    await h.receive({ type: "error", error: "Malformed request" });
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0][0]).toContain("Runner error");
    expect(warn.mock.calls[0][0]).not.toContain("without a requestId");
  });

  for (const handshake of [false, true]) {
    test(`preserves legacy id-less correlation ${handshake ? "with an old APK handshake" : "without a handshake"}`, async () => {
      const h = await harness();
      if (handshake) {
        await h.advertise(["set_hierarchy_interval", "node_selector_actions"]);
      }
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const pending = h.waitForHierarchy("legacy");
      await h.pushHierarchy("legacy tree");
      h.timer.advanceTime(50);
      expect((await pending)?.hierarchy.hierarchy.text).toBe("legacy tree");
      await h.receive({ type: "swipe_result", success: true, totalTimeMs: 1 });
      expect(warn).not.toHaveBeenCalled();
    });
  }

  test("connection close resets advertised strictness before reconnecting to an old APK", async () => {
    const h = await harness();
    await h.advertise([echoCapability]);
    let settled = false;
    const strict = h.waitForHierarchy("strict").then((value) => {
      settled = true;
      return value;
    });
    await h.pushHierarchy("push");
    h.timer.advanceTime(50);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.client["hierarchy"]["pendingHierarchyRejectors"].has("strict")).toBe(true);
    h.client.onConnectionClosed();
    expect(await strict).toBeNull();
    await h.advertise(["node_selector_actions"]);
    const legacy = h.waitForHierarchy("legacy");
    await h.pushHierarchy("old APK tree");
    h.timer.advanceTime(50);
    expect((await legacy)?.hierarchy.hierarchy.text).toBe("old APK tree");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    await h.receive({ type: "swipe_result", success: true, totalTimeMs: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  test("every handler explicitly chooses response correlation or id-less delivery", async () => {
    const h = await harness();
    const correlated = [...ANDROID_REQUEST_ID_RESPONSE_TYPES];
    const idLess = [...ANDROID_ID_LESS_MESSAGE_TYPES];
    expect(correlated.filter((type) => ANDROID_ID_LESS_MESSAGE_TYPES.has(type))).toEqual([]);
    expect([...correlated, ...idLess].sort()).toEqual(
      Object.keys(h.client["webSocketMessageHandlers"]).sort(),
    );
    expect(ANDROID_ID_LESS_MESSAGE_TYPES.has("hierarchy_update")).toBe(true);
    expect(ANDROID_ID_LESS_MESSAGE_TYPES.has("error")).toBe(true);
  });

  for (const complete of [false, true]) {
    test(`echo marker preserves command support with ${complete ? "complete" : "legacy partial"} advertisement`, async () => {
      const h = await harness();
      const commands = complete
        ? [...KNOWN_REQUEST_TYPES, ...ANDROID_CAPABILITY_FLAGS, ANDROID_FULL_COMMAND_SET_CAPABILITY]
        : ["node_selector_actions", "set_hierarchy_interval"];
      await h.advertise(commands);
      const visibleTypes = [...KNOWN_REQUEST_TYPES, ...ANDROID_CAPABILITY_FLAGS, "future_command"];
      const before = visibleTypes.map((type) => h.client["isCommandSupported"](type));
      const rawBefore = await h.client.getSupportedCommands();
      const supportsBefore = await Promise.all(
        visibleTypes.map((type) => h.client.supportsCommand(type)),
      );
      await h.advertise([...commands, echoCapability]);
      expect(visibleTypes.map((type) => h.client["isCommandSupported"](type))).toEqual(before);
      expect(await Promise.all(visibleTypes.map((type) => h.client.supportsCommand(type)))).toEqual(
        supportsBefore,
      );
      expect(await h.client.getSupportedCommands()).toEqual([...rawBefore!, echoCapability].sort());
      expect(await h.client.supportsCommand(echoCapability)).toBe(true);
      expect(h.client["isCommandSupported"](echoCapability)).toBe(true);
      expect(ANDROID_CAPABILITY_GATED_COMMANDS.has(echoCapability)).toBe(false);
      expect(ANDROID_CAPABILITY_FLAGS).not.toContain(echoCapability);
    });
  }
});
