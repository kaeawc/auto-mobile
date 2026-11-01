import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  AndroidScreenshotRequester,
  type AndroidScreenshotRequesterContext,
} from "../../../../src/features/observe/android/AndroidScreenshotRequester";
import { SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY } from "../../../../src/features/observe/android/ctrlProxyProtocol";
import type { ScreenshotResult } from "../../../../src/features/observe/android/types";
import type { ScreenGeometryBinding } from "../../../../src/features/observe/TrackedScreenGeometry";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { OPERATION_CANCELLED_MESSAGE } from "../../../../src/utils/constants";
import { FakeTimer } from "../../../fakes/FakeTimer";

function harness(options: { connected?: boolean; supported?: string[]; open?: boolean } = {}) {
  const timer = new FakeTimer();
  const requestManager = new RequestManager(timer);
  const frames: Record<string, unknown>[] = [];
  const binding: ScreenGeometryBinding = { captureSequence: 7, width: 10, height: 20 };
  const calls = { connect: 0, noted: 0 };
  const context: AndroidScreenshotRequesterContext = {
    timer,
    requestManager,
    screenGeometry: { bind: () => binding },
    screenshotObservationStreamSuppressions: new Set(),
    screenshotCaptureBindings: new Map(),
    lateCancelledScreenshotRequestIds: new Set(),
    socket:
      options.open === false
        ? null
        : {
            readyState: WebSocket.OPEN,
            send: (data: string) => frames.push(JSON.parse(data) as Record<string, unknown>),
          },
    supportedCommands: new Set(options.supported ?? []),
    connectWebSocket: async () => {
      calls.connect++;
      return options.connected ?? true;
    },
    noteScreenshotCaptureStarted: () => {
      calls.noted++;
    },
  };
  return {
    requester: new AndroidScreenshotRequester(context),
    context,
    requestManager,
    frames,
    calls,
    timer,
  };
}

/** Yield until the requester has registered its request (connect and registration are async). */
async function pendingIds(requestManager: RequestManager): Promise<string[]> {
  for (let i = 0; i < 50 && requestManager.getPendingCount() === 0; i++) {
    await Promise.resolve();
  }
  return requestManager.getPendingIds();
}

const perf = new NoOpPerformanceTracker();
const okResult: ScreenshotResult = { success: true, data: "abc", format: "png" };

describe("AndroidScreenshotRequester", () => {
  test("a connection failure returns a typed failure without sending", async () => {
    const { requester, frames } = harness({ connected: false });
    const result = await requester.requestScreenshot(1000, perf);
    expect(result).toEqual({
      success: false,
      error: "Failed to connect to accessibility service",
    });
    expect(frames).toEqual([]);
  });

  test("an already-aborted signal short-circuits before connecting", async () => {
    const { requester, calls } = harness();
    const result = await requester.requestScreenshot(1000, perf, { signal: AbortSignal.abort() });
    expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
    expect(calls.connect).toBe(0);
  });

  test("a round trip binds the capture, sends one frame, resolves, and cleans up", async () => {
    const { requester, context, requestManager, frames, calls } = harness();
    const pending = requester.requestScreenshot(1000, perf);
    const [requestId] = await pendingIds(requestManager);
    expect(frames).toEqual([{ type: "request_screenshot", requestId }]);
    expect(context.screenshotCaptureBindings.get(requestId!)).toEqual({
      captureSequence: 7,
      width: 10,
      height: 20,
    });
    expect(calls.noted).toBe(1);
    requestManager.resolve(requestId!, okResult);
    expect(await pending).toEqual(okResult);
    expect(context.screenshotCaptureBindings.size).toBe(0);
  });

  test("a suppressed push registers the id then drops it after the response", async () => {
    const { requester, context, requestManager } = harness();
    const pending = requester.requestScreenshot(1000, perf, {
      suppressObservationStreamPush: true,
    });
    const [requestId] = await pendingIds(requestManager);
    expect(context.screenshotObservationStreamSuppressions.has(requestId!)).toBe(true);
    expect(context.screenshotCaptureBindings.size).toBe(0);
    requestManager.resolve(requestId!, okResult);
    await pending;
    expect(context.screenshotObservationStreamSuppressions.size).toBe(0);
  });

  test("a timeout resolves a typed failure", async () => {
    const { requester, timer, requestManager } = harness();
    const pending = requester.requestScreenshot(500, perf);
    await pendingIds(requestManager);
    timer.advanceTime(500);
    expect(await pending).toEqual({ success: false, error: "Screenshot timeout after 500ms" });
  });

  test("a post-dispatch abort settles the request and records a late-cancelled id", async () => {
    const { requester, context, requestManager } = harness();
    const controller = new AbortController();
    const pending = requester.requestScreenshot(1000, perf, { signal: controller.signal });
    const [requestId] = await pendingIds(requestManager);
    controller.abort();
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toBe(OPERATION_CANCELLED_MESSAGE);
    expect(context.lateCancelledScreenshotRequestIds.has(requestId!)).toBe(true);
  });

  test("dispatch sends hidePrototypes only when the capability is advertised", async () => {
    const withCapability = harness({ supported: [SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY] });
    await withCapability.requester.dispatchScreenshotRequest("s-1", undefined, 2, true);
    expect(withCapability.frames).toEqual([
      { type: "request_screenshot", requestId: "s-1", displayId: 2, hidePrototypes: true },
    ]);
    const without = harness({ supported: [] });
    await without.requester.dispatchScreenshotRequest("s-1", undefined, undefined, true);
    expect(without.frames).toEqual([{ type: "request_screenshot", requestId: "s-1" }]);
  });

  test("dispatch with no open socket throws and sends nothing", async () => {
    const { requester, calls } = harness({ open: false });
    await expect(requester.dispatchScreenshotRequest("s-1")).rejects.toThrow();
    expect(calls.noted).toBe(0);
  });

  test("a cancelled dispatch settles locally without consuming the rate limit", async () => {
    const { requester, requestManager, frames, calls } = harness();
    const pending = requestManager.register<ScreenshotResult>("s-1", "screenshot", 1000, {
      timeoutErrorFactory: () => ({
        success: false,
        error: "timeout",
      }),
    });
    await requester.dispatchScreenshotRequest("s-1", AbortSignal.abort());
    expect(await pending).toMatchObject({ success: false, error: OPERATION_CANCELLED_MESSAGE });
    expect(frames).toEqual([]);
    expect(calls.noted).toBe(0);
  });
});
