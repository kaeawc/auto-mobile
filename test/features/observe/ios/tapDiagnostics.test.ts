import { afterEach, describe, expect, spyOn, test } from "bun:test";
import WebSocket from "ws";
import { CtrlProxyGestures } from "../../../../src/features/observe/ios/CtrlProxyGestures";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { decodeCtrlProxyMessage } from "../../../../src/features/observe/ios/decodeCtrlProxyMessage";
import type {
  CtrlProxyTapDiagnostics,
  WebSocketMessage,
} from "../../../../src/features/observe/ios/types";
import { logger, LogLevel } from "../../../../src/utils/logger";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createSuccessWebSocketFactory } from "../../../fakes/FakeWebSocket";
import { dispatchIosCoordinateTap } from "../../../../src/features/action/coordinateTapDispatch";

// #8379: conflicting app/screen frames are faithfully reported; no mapping is applied.
const diagnostics: CtrlProxyTapDiagnostics = {
  requested: {
    x: 443,
    y: 202,
    durationMs: 50,
    mode: "press",
    coordinateConstruction: "appFrameOriginPlusPointOffset",
    units: "points",
  },
  baseScreenPoint: { x: 0, y: 0 },
  resolvedScreenPoint: { x: 443, y: 202 },
  application: { frame: { x: 0, y: 0, width: 669, height: 951 } },
  screen: {
    bounds: { x: 0, y: 0, width: 951, height: 669 },
    nativeBounds: { x: 0, y: 0, width: 2853, height: 2007 },
    scale: 3,
    nativeScale: 3,
    source: "runnerProcessUIScreenMain",
  },
  orientation: {
    device: { rawValue: 3, value: "landscapeLeft", source: "XCUIDevice.shared.orientation" },
    interface: { rawValue: 4, value: "landscapeLeft", source: "runnerProcessScenes" },
  },
  sampleErrors: [],
};
const originalLevel = logger.getLogLevel();
afterEach(() => logger.setLogLevel(originalLevel));

function gestureHarness() {
  const timer = new FakeTimer();
  const requestManager = new RequestManager(timer);
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
      const request: { requestId: string } = JSON.parse(data);
      requestManager.resolve(request.requestId, { success: true });
    },
  } as unknown as WebSocket;
  return {
    sent,
    gestures: new CtrlProxyGestures({
      timer,
      requestManager,
      getWebSocket: () => socket,
      ensureConnected: async () => true,
      cancelScreenshotBackoff() {},
    }),
  };
}

describe("iOS opt-in tap diagnostics", () => {
  test("debug off leaves the exact default wire JSON unchanged", async () => {
    logger.setLogLevel(LogLevel.INFO);
    const { sent, gestures } = gestureHarness();
    await gestures.requestTapCoordinates(443, 202, 50);
    const wire = sent[0];
    const request: { requestId: string } = JSON.parse(wire);
    expect(wire).toBe(
      JSON.stringify({
        type: "request_tap_coordinates",
        requestId: request.requestId,
        x: 443,
        y: 202,
        duration: 50,
      }),
    );
  });

  test("debug on adds only diagnostics:true and preserves the dispatch signature", async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      logger.setLogLevel(LogLevel.DEBUG);
      const { sent, gestures } = gestureHarness();
      expect(await dispatchIosCoordinateTap(gestures, 443, 202, 50, "frame")).toBeUndefined();
      expect(JSON.parse(sent[0])).toEqual({
        type: "request_tap_coordinates",
        requestId: expect.any(String),
        x: 443,
        y: 202,
        duration: 50,
        frameContext: "frame",
        diagnostics: true,
      });
    } finally {
      debug.mockRestore();
    }
  });

  test("decoder carries the unfolded Duo readings unchanged and omits an absent payload", () => {
    const message = { type: "tap_coordinates_result", requestId: "tap", success: true };
    expect(decodeCtrlProxyMessage({ ...message, tapDiagnostics: diagnostics })?.result).toEqual({
      success: true,
      totalTimeMs: 0,
      error: undefined,
      perfTiming: undefined,
      tapDiagnostics: diagnostics,
    });
    expect(decodeCtrlProxyMessage(message)?.result).not.toHaveProperty("tapDiagnostics");
    expect(
      decodeCtrlProxyMessage({ ...message, type: "swipe_result", tapDiagnostics: diagnostics })
        ?.result,
    ).not.toHaveProperty("tapDiagnostics");
  });

  test.each([
    ["full", diagnostics],
    [
      "partial",
      { requested: { x: 443, y: 202 }, sampleErrors: ["application.frame: unavailable"] },
    ],
    ["malformed", "unexpected runner payload"],
  ])("%s payload is logged once and never changes tap success", async (_name, payload) => {
    const timer = new FakeTimer();
    const client = IOSCtrlProxyClient.createForTesting(
      { deviceId: "tap-diagnostics", platform: "ios", name: "Fake Duo" },
      8765,
      createSuccessWebSocketFactory(timer),
      timer,
    );
    const boundary = client as unknown as {
      requestManager: RequestManager;
      processMessage(message: WebSocketMessage): void;
    };
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const pending = boundary.requestManager.register("tap", "tap_coordinates", 5000);
      // Model JSON from an untrusted runner, including a malformed optional value.
      const message: WebSocketMessage = JSON.parse(
        JSON.stringify({
          type: "tap_coordinates_result",
          requestId: "tap",
          success: true,
          tapDiagnostics: payload,
        }),
      );
      boundary.processMessage(message);
      expect(await pending).toMatchObject({ success: true, tapDiagnostics: payload });
      const lines = debug.mock.calls
        .map(([line]) => line)
        .filter((line) => line.startsWith("[CTRLPROXY_TAP_DIAG]"));
      expect(lines).toEqual([`[CTRLPROXY_TAP_DIAG] ${JSON.stringify(payload)}`]);
      // The full #8379 reading fits the logger's existing line-size bound.
      expect(lines[0].length).toBeLessThanOrEqual(1000);
      debug.mockClear();
      boundary.processMessage({
        type: "tap_coordinates_result",
        requestId: "legacy",
        success: true,
      });
      expect(debug.mock.calls.some(([line]) => line.startsWith("[CTRLPROXY_TAP_DIAG]"))).toBe(
        false,
      );
    } finally {
      debug.mockRestore();
      await client.close();
    }
  });
});
