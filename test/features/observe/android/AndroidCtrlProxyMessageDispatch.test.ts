import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  AndroidCtrlProxyClient,
  type AndroidDisplayTransition,
} from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type {
  AndroidSdkEventIngestor,
  AndroidSdkEventPayload,
} from "../../../../src/features/observe/android/AndroidSdkEventIngestor";
import type { SdkEvent } from "../../../../src/features/observe/interfaces/SdkEventIngestor";
import { FocusElementMatcher } from "../../../../src/features/talkback/FocusElementMatcher";
import type { TraversalOrderResult } from "../../../../src/models";
import type { BootedDevice } from "../../../../src/models";
import { logger } from "../../../../src/utils/logger";
import { PortManager } from "../../../../src/utils/PortManager";
import { displayTransitions } from "../../../../src/features/observe/DisplayTransition";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

interface DispatchTestClient {
  onDisplayTransition?: (event: AndroidDisplayTransition) => void;
  cachedHierarchy?: { hierarchy: { displayId?: number; panelUniqueId?: string } };
  handleWebSocketMessage(data: string): Promise<void>;
  webSocketMessageHandlers: Record<string, unknown>;
  requestManager: RequestManager;
}

describe("Android CtrlProxy WebSocket dispatch", () => {
  const device: BootedDevice = {
    deviceId: "dispatch-test-device",
    platform: "android",
    isEmulator: true,
    name: "Dispatch Test Device",
  };
  let timer: FakeTimer;
  let client: DispatchTestClient;
  let recorded: Array<{ event: SdkEvent<AndroidSdkEventPayload>; applicationId: string | null }>;

  beforeEach(() => {
    displayTransitions.reset(device.deviceId);
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    timer = new FakeTimer();
    recorded = [];
    const ingestor: Pick<AndroidSdkEventIngestor, "recordSdkEvent"> = {
      recordSdkEvent: async (event, applicationId) => {
        recorded.push({ event, applicationId });
      },
    };
    client = AndroidCtrlProxyClient.createForTesting(
      device,
      new FakeAdbExecutor(),
      () => {
        throw new Error("WebSocket connection is not needed for dispatch tests");
      },
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      ingestor as AndroidSdkEventIngestor,
    ) as unknown as DispatchTestClient;
  });

  afterEach(() => {
    displayTransitions.reset(device.deviceId);
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("has an own handler for every typed wire variant", () => {
    // The `satisfies WebSocketMessageHandlers` clause is the union-wide compile-time check.
    // There is no separate runtime list of the union's string literals.
    expect(Object.keys(client.webSocketMessageHandlers)).toHaveLength(61);
    expect(Object.hasOwn(client.webSocketMessageHandlers, "custom_event")).toBe(false);
    for (const type of [
      "keystore_discovery",
      "sdk_capabilities",
      "network_event",
      "websocket_frame_event",
      "log_event",
      "broadcast_event",
      "lifecycle_event",
      "insert_text_state_result",
    ]) {
      expect(Object.hasOwn(client.webSocketMessageHandlers, type)).toBe(true);
    }
  });

  test("parses a display transition and invalidates the owning device", async () => {
    const received: AndroidDisplayTransition[] = [];
    client.onDisplayTransition = (event) => received.push(event);
    displayTransitions.record(device.deviceId, {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 2076, height: 2152 },
    });
    await client.handleWebSocketMessage(
      JSON.stringify({
        type: "display_transition",
        change: "changed",
        displayId: 0,
        panelUniqueId: "local:cover",
        width: 1080,
        height: 2520,
        state: 2,
        rotation: 1,
      }),
    );
    await client.handleWebSocketMessage('{"type":"display_transition","change":"changed"}');
    expect(received).toEqual([
      {
        change: "changed",
        displayId: 0,
        panelUniqueId: "local:cover",
        width: 1080,
        height: 2520,
        state: 2,
        rotation: 1,
      },
    ]);
    expect(displayTransitions.revision(device.deviceId)).toBe(1);
  });

  test("retains optional display identity on hierarchy and screenshot responses", async () => {
    await client.handleWebSocketMessage(
      JSON.stringify({
        type: "hierarchy_update",
        data: {
          updatedAt: 10,
          packageName: "example.app",
          displayId: 5,
          panelUniqueId: "panel-rear",
        },
      }),
    );
    expect(client.cachedHierarchy?.hierarchy.displayId).toBe(5);
    expect(client.cachedHierarchy?.hierarchy.panelUniqueId).toBe("panel-rear");

    const pending = client.requestManager.register("shot-display", "screenshot", 1000, () => ({
      success: false,
    }));
    await client.handleWebSocketMessage(
      JSON.stringify({
        type: "screenshot",
        requestId: "shot-display",
        data: "AA==",
        displayId: 5,
        panelUniqueId: "panel-rear",
      }),
    );
    expect(await pending).toMatchObject({
      success: true,
      displayId: 5,
      panelUniqueId: "panel-rear",
    });
  });

  test.each([{ truncationReasons: undefined }, { truncationReasons: ["max_children"] }])(
    "carries optional traversal truncation reasons %j through dispatch",
    async ({ truncationReasons }) => {
      const pending = client.requestManager.register<TraversalOrderResult>(
        "traversal-1",
        "get_traversal_order",
        1000,
        () => ({ elements: [], focusedIndex: null, totalCount: 0, totalTimeMs: 0 }),
      );
      await client.handleWebSocketMessage(
        JSON.stringify({
          type: "traversal_order_result",
          requestId: "traversal-1",
          totalTimeMs: 2,
          result: { elements: [], focusedIndex: null, totalCount: 0, truncationReasons },
        }),
      );

      const result = await pending;
      expect(result.truncationReasons).toEqual(truncationReasons);
      expect(result.elements).toEqual([]);
      expect(client.requestManager.getPendingCount()).toBe(0);
      expect(timer.getCurrentTime()).toBe(0);
    },
  );

  test("a tap_coordinates_result reply, including a refusal, is marked acknowledged", async () => {
    const pending = client.requestManager.register("tap-ack", "tap_coordinates", 1000, () => ({
      success: false,
    }));
    await client.handleWebSocketMessage(
      JSON.stringify({
        type: "tap_coordinates_result",
        requestId: "tap-ack",
        success: false,
        error: "Stale frame context for input/tap",
        totalTimeMs: 2,
      }),
    );
    expect(await pending).toMatchObject({
      success: false,
      error: "Stale frame context for input/tap",
      acknowledged: true,
    });
  });

  test("resolves a pending settings response through the shared helper", async () => {
    const pending = client.requestManager.register("settings-1", "settings_get", 1000, () => ({
      success: false,
      value: "timeout",
    }));
    await client.handleWebSocketMessage(
      JSON.stringify({
        type: "settings_get_result",
        requestId: "settings-1",
        success: true,
        value: "enabled",
        found: true,
        totalTimeMs: 2,
      }),
    );
    expect(await pending).toMatchObject({ success: true, value: "enabled", found: true });
    expect(client.requestManager.getPendingCount()).toBe(0);
    expect(timer.getCurrentTime()).toBe(0);
  });

  test.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "traversal preserves valid nodes (malformed bounds: %s, focus dropped: %s)",
    async (malformed, focusDropped) => {
      // Synthetic protocol objects, not captured device fixtures. The current producer
      // always supplies numeric bounds; omit them to exercise the nullable parser contract.
      const first = { text: "First", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
      const target = { text: "Target", bounds: { left: 10, top: 0, right: 20, bottom: 10 } };
      const nodes = [first, ...(malformed ? [{ text: "Invalid" }] : []), target];
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      try {
        const pending = client.requestManager.register<TraversalOrderResult>(
          "traversal-1",
          "get_traversal_order",
          1000,
          () => ({ elements: [], focusedIndex: null, totalCount: 0, totalTimeMs: 0 }),
        );
        await client.handleWebSocketMessage(
          JSON.stringify({
            type: "traversal_order_result",
            requestId: "traversal-1",
            totalTimeMs: 2,
            result: {
              elements: nodes,
              focusedIndex: focusDropped ? 1 : nodes.length - 1,
              totalCount: nodes.length,
            },
          }),
        );
        const result = await pending;
        // Exercise the actual dereferencing consumer, before checking the array shape.
        expect(new FocusElementMatcher().findTargetIndex(result.elements, { text: "Target" })).toBe(
          1,
        );
        expect(result).toEqual({
          elements: [first, target],
          focusedIndex: focusDropped ? null : 1,
          totalCount: 2,
          totalTimeMs: 2,
          requestId: "traversal-1",
          error: undefined,
        });
        const drops = debug.mock.calls.filter(([message]) => String(message).includes("Dropped"));
        expect(drops).toEqual(
          malformed ? [["[CTRL_PROXY] Dropped 1 traversal nodes that failed conversion"]] : [],
        );
        expect(client.requestManager.getPendingCount()).toBe(0);
      } finally {
        debug.mockRestore();
      }
    },
  );

  test("logs a truly unknown type once and otherwise ignores it", async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(client.handleWebSocketMessage('{"type":"bogus_type"}')).resolves.toBeUndefined();
      expect(debug.mock.calls).toEqual([
        ["[CTRL_PROXY] Ignoring unknown WebSocket message type: bogus_type"],
      ]);
      expect(warn).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    } finally {
      debug.mockRestore();
      warn.mockRestore();
    }
  });

  test("retains unconditional gesture logs and silent conditional handlers", async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await client.handleWebSocketMessage('{"type":"swipe_result","success":true}');
      await client.handleWebSocketMessage('{"type":"tap_coordinates_result","success":true}');
      expect(debug.mock.calls).toEqual([
        ["[CTRL_PROXY] Swipe result (requestId: undefined, success: true)"],
      ]);
      expect(info.mock.calls).toEqual([
        ["[CTRL_PROXY] Tap coordinates result (requestId: undefined, success: true)"],
      ]);
      debug.mockClear();
      info.mockClear();
      await client.handleWebSocketMessage('{"type":"screenshot_error","error":"missing ID"}');
      await client.handleWebSocketMessage('{"type":"hierarchy_update"}');
      await client.handleWebSocketMessage('{"type":"frame_metrics_event"}');
      expect(debug).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("routes custom_event and typed SDK telemetry through the same recorder", async () => {
    await client.handleWebSocketMessage(
      JSON.stringify({
        type: "custom_event",
        timestamp: 12,
        event: { applicationId: "com.example", name: "checkout" },
      }),
    );
    await client.handleWebSocketMessage(
      JSON.stringify({
        type: "network_event",
        timestamp: 13,
        event: { applicationId: "com.example", url: "https://example.test", method: "GET" },
      }),
    );
    expect(recorded).toEqual([
      {
        event: {
          type: "custom_event",
          timestamp: 12,
          payload: { event: { applicationId: "com.example", name: "checkout" } },
        },
        applicationId: "com.example",
      },
      {
        event: {
          type: "network_event",
          timestamp: 13,
          payload: {
            event: {
              applicationId: "com.example",
              url: "https://example.test",
              method: "GET",
            },
          },
        },
        applicationId: "com.example",
      },
    ]);
  });
});

test("connected greeting records gesture display capability without gating core gestures", async () => {
  const timer = new FakeTimer();
  const proxy = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "gesture-greeting", platform: "android", name: "Fake" },
    new FakeAdbExecutor(),
    undefined,
    timer,
  );
  await proxy["handleWebSocketMessage"](
    JSON.stringify({ type: "connected", supportedCommands: ["gesture_display_id_v1"] }),
  );
  expect(await proxy.supportsCommand("gesture_display_id_v1")).toBe(true);
  const context = proxy["createDelegateContext"]();
  for (const command of [
    "request_tap_coordinates",
    "request_swipe",
    "request_two_finger_swipe",
    "request_drag",
    "request_pinch",
    "request_gesture_start",
  ]) {
    expect(context.isCommandSupported?.(command)).toBe(true);
  }
  await proxy["handleWebSocketMessage"](
    JSON.stringify({ type: "connected", supportedCommands: [] }),
  );
  expect(await proxy.supportsCommand("gesture_display_id_v1")).toBe(false);
  expect(context.isCommandSupported?.("gesture_display_id_v1")).toBe(false);
  proxy["supportedCommands"] = null;
  expect(context.isCommandSupported?.("gesture_display_id_v1")).toBe(false);
});
