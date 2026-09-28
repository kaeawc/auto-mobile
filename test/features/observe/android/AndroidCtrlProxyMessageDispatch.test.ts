import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type {
  AndroidSdkEventIngestor,
  AndroidSdkEventPayload,
} from "../../../../src/features/observe/android/AndroidSdkEventIngestor";
import type { SdkEvent } from "../../../../src/features/observe/interfaces/SdkEventIngestor";
import type { BootedDevice } from "../../../../src/models";
import { logger } from "../../../../src/utils/logger";
import { PortManager } from "../../../../src/utils/PortManager";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

interface DispatchTestClient {
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
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("has an own handler for every typed wire variant", () => {
    // The `satisfies WebSocketMessageHandlers` clause is the union-wide compile-time check.
    // There is no separate runtime list of the union's string literals.
    expect(Object.keys(client.webSocketMessageHandlers)).toHaveLength(55);
    expect(Object.hasOwn(client.webSocketMessageHandlers, "custom_event")).toBe(false);
    for (const type of [
      "network_event",
      "websocket_frame_event",
      "log_event",
      "broadcast_event",
      "lifecycle_event",
    ]) {
      expect(Object.hasOwn(client.webSocketMessageHandlers, type)).toBe(true);
    }
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
