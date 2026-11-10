import { describe, expect, spyOn, test } from "bun:test";
import { DefaultAfterToolCallHandler } from "../../src/server/toolRegistry";
import {
  SCREENSHOT_HIERARCHY_LAG_THRESHOLD_MS,
  SCREENSHOT_HIERARCHY_LAG_WARNING,
  stampScreenshotHierarchyLag,
} from "../../src/server/screenshotHierarchyLag";
import {
  captureOrDeferTerminalScreenshot,
  hasPendingTerminalScreenshot,
  isTerminalScreenshotUnavailable,
  runWithPostActionCaptureScope,
} from "../../src/utils/PostActionCaptureContext";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { logger } from "../../src/utils/logger";
import type { BootedDevice } from "../../src/models";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { buildObserveResult } from "../helpers/observeFixture";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * #17765: the screenshot published under an action observation's id must say how far
 * it trails that observation's hierarchy, and a non-settle-gated action captures it
 * at hierarchy time rather than at the response boundary.
 */

const device: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
const HIERARCHY_AT = Date.parse("2026-11-10T07:22:56.000Z");

/**
 * An action frame whose hierarchy reached the host at `receivedAt` (host clock) and
 * carries the device-authored `updatedAt`; they differ by the device's clock skew.
 */
function frame(
  id: string,
  receivedAt = HIERARCHY_AT,
  updatedAt: number | undefined = receivedAt,
): ObserveResult {
  return {
    ...buildObserveResult({
      updatedAt,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: {
        packageName: "com.example.chat",
        hierarchy: { node: { class: "android.widget.EditText", text: id } },
        updatedAt,
        receivedAt,
      },
    }),
    deviceId: device.deviceId,
    observationId: id,
  };
}

/** A source that does not track host receipt time (e.g. the iOS delegate). */
function withoutHostReceipt(observation: ObserveResult): ObserveResult {
  delete observation.viewHierarchy?.receivedAt;
  return observation;
}

/** A capture seam that stamps the injected clock as the screenshot time. */
function clockCapture(timer: FakeTimer, calls: { count: number }) {
  return async (chosen: ObserveResult) => {
    calls.count++;
    chosen.screenshotPath = `/fake/${chosen.observationId}.png`;
    chosen.screenshotCapturedAt = new Date(timer.now()).toISOString();
  };
}

async function respond(
  name: string,
  observation: ObserveResult,
  handler: DefaultAfterToolCallHandler,
  timer: FakeTimer,
) {
  const result = await handler.handle({
    name,
    outputSchema: undefined,
    args: name === "sendKeys" ? { commands: [{ action: "text", text: "@ali" }] } : {},
    device,
    internalCall: false,
    response: createStructuredToolResponse({ success: true, observation }),
    sessionUuid: undefined,
    shouldResolveDevice: false,
    timer,
    toolStartMs: 0,
  });
  const payload = getStructuredPayload<{ observation: ObserveResult }>(result.finalizedResponse);
  if (!payload) {
    throw new Error("Missing response payload");
  }
  return payload.observation;
}

describe("stampScreenshotHierarchyLag", () => {
  test("stamps the lag and leaves a pair within the threshold unmarked", () => {
    const observation = {
      ...frame("within"),
      screenshotCapturedAt: new Date(HIERARCHY_AT + 120).toISOString(),
    };
    expect(stampScreenshotHierarchyLag(observation)).toBe(true);
    expect(observation.screenshotHierarchyLagMs).toBe(120);
    expect(observation.screenshotHierarchyMismatch).toBeUndefined();
    expect(observation.freshness?.warning).toBeUndefined();
  });

  test("marks a lag above the threshold once, keeping earlier warnings", () => {
    const observation = {
      ...frame("late"),
      freshness: { isFresh: true, warning: "earlier" },
      screenshotCapturedAt: new Date(HIERARCHY_AT + 3000).toISOString(),
    };
    stampScreenshotHierarchyLag(observation);
    stampScreenshotHierarchyLag(observation);
    expect(observation.screenshotHierarchyLagMs).toBe(3000);
    expect(observation.screenshotHierarchyMismatch).toBe(true);
    expect(observation.freshness).toEqual({
      isFresh: true,
      warning: `earlier; ${SCREENSHOT_HIERARCHY_LAG_WARNING}`,
    });
  });

  test("the threshold is injectable", () => {
    const late = {
      ...frame("x"),
      screenshotCapturedAt: new Date(HIERARCHY_AT + 200).toISOString(),
    };
    stampScreenshotHierarchyLag(late, { thresholdMs: 100 });
    expect(late.screenshotHierarchyMismatch).toBe(true);
    const within = { ...late, freshness: undefined, screenshotHierarchyMismatch: undefined };
    stampScreenshotHierarchyLag(within, { thresholdMs: 300 });
    expect(within.screenshotHierarchyMismatch).toBeUndefined();
    expect(SCREENSHOT_HIERARCHY_LAG_THRESHOLD_MS).toBe(500);
  });

  // #17787: the screenshot time is a host file time, so the lag must be measured
  // against the host receipt time, never the device-authored `updatedAt`.
  describe("is measured on the host clock whatever the device clock skew", () => {
    /** The hierarchy arrives at host `now`; the screenshot is captured `captureAfterMs` later. */
    function capturedPair(deviceSkewMs: number, captureAfterMs: number): ObserveResult {
      const timer = new FakeTimer();
      timer.setCurrentTime(HIERARCHY_AT);
      const receivedAt = timer.now();
      const observation = frame("pair", receivedAt, receivedAt + deviceSkewMs);
      timer.advanceTime(captureAfterMs);
      observation.screenshotCapturedAt = new Date(timer.now()).toISOString();
      return observation;
    }

    test("a device clock running ahead of the host does not hide a late screenshot", () => {
      const observation = capturedPair(+250, 120);
      stampScreenshotHierarchyLag(observation, { platform: "android" });
      expect(observation.screenshotHierarchyLagMs).toBe(120);
      expect(observation.screenshotHierarchyMismatch).toBeUndefined();
    });

    test("a device clock running behind the host does not raise a false mismatch", () => {
      const observation = capturedPair(-600, 120);
      stampScreenshotHierarchyLag(observation, { platform: "android" });
      expect(observation.screenshotHierarchyLagMs).toBe(120);
      expect(observation.screenshotHierarchyMismatch).toBeUndefined();
      expect(observation.freshness?.warning).toBeUndefined();
    });

    test("a really late screenshot is marked even when the device clock is ahead", () => {
      // The old cross-clock value would be 600 - 250 = 350 ms: within the threshold.
      const observation = capturedPair(+250, 600);
      stampScreenshotHierarchyLag(observation, { platform: "android" });
      expect(observation.screenshotHierarchyLagMs).toBe(600);
      expect(observation.screenshotHierarchyMismatch).toBe(true);
      expect(observation.freshness?.warning).toContain(SCREENSHOT_HIERARCHY_LAG_WARNING);
    });

    test("an Android tree without a host receipt time gets no cross-clock lag", () => {
      const observation = {
        ...withoutHostReceipt(frame("unreceived", HIERARCHY_AT, HIERARCHY_AT - 250)),
        screenshotCapturedAt: new Date(HIERARCHY_AT).toISOString(),
      };
      expect(stampScreenshotHierarchyLag(observation, { platform: "android" })).toBe(false);
      expect(stampScreenshotHierarchyLag(observation)).toBe(false);
      expect(observation.screenshotHierarchyLagMs).toBeUndefined();
    });

    test("iOS, which shares the host clock, falls back to the device updatedAt", () => {
      const observation = {
        ...withoutHostReceipt(frame("ios")),
        screenshotCapturedAt: new Date(HIERARCHY_AT + 90).toISOString(),
      };
      stampScreenshotHierarchyLag(observation, { platform: "ios" });
      expect(observation.screenshotHierarchyLagMs).toBe(90);
    });
  });

  test("no screenshot means no lag, and a stale stamp is removed", () => {
    const observation: ObserveResult = {
      ...frame("none"),
      screenshotHierarchyLagMs: 9,
      screenshotHierarchyMismatch: true,
    };
    expect(stampScreenshotHierarchyLag(observation)).toBe(true);
    expect(observation.screenshotHierarchyLagMs).toBeUndefined();
    expect(observation.screenshotHierarchyMismatch).toBeUndefined();
    expect(stampScreenshotHierarchyLag(frame("bare"))).toBe(false);
  });
});

describe("post-action screenshot pairing at the response boundary", () => {
  test("a non-settle-gated sendKeys captures at hierarchy time, not after later tool work", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(HIERARCHY_AT);
    const calls = { count: 0 };
    const action = frame("sendKeys");
    await runWithPostActionCaptureScope(
      undefined,
      async () => {
        timer.advanceTime(80);
        expect(await captureOrDeferTerminalScreenshot(action, clockCapture(timer, calls))).toBe(
          true,
        );
        expect(calls.count).toBe(1);
        expect(hasPendingTerminalScreenshot(action)).toBe(false);
        // Response-path work that used to run before the deferred capture.
        timer.advanceTime(3000);
        const published = await respond(
          "sendKeys",
          action,
          new DefaultAfterToolCallHandler(),
          timer,
        );
        expect(published.screenshotCapturedAt).toBe(new Date(HIERARCHY_AT + 80).toISOString());
        expect(published.screenshotHierarchyLagMs).toBe(80);
        expect(published.screenshotHierarchyMismatch).toBeUndefined();
        expect(published.settled).toBe(false);
      },
      true,
      false,
    );
    expect(calls.count).toBe(1);
  });

  test("a deferred capture published past the threshold is stamped and marked", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(HIERARCHY_AT);
    const calls = { count: 0 };
    const action = frame("deferred");
    await runWithPostActionCaptureScope(undefined, async () => {
      expect(await captureOrDeferTerminalScreenshot(action, clockCapture(timer, calls))).toBe(true);
      expect(calls.count).toBe(0);
      timer.advanceTime(3000);
      const published = await respond("sendKeys", action, new DefaultAfterToolCallHandler(), timer);
      expect(calls.count).toBe(1);
      expect(published.screenshotHierarchyLagMs).toBe(3000);
      expect(published.screenshotHierarchyMismatch).toBe(true);
      expect(published.freshness?.warning).toContain(SCREENSHOT_HIERARCHY_LAG_WARNING);
    });
  });

  test("settle-gated tapOn still defers and captures the adopted frame", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(HIERARCHY_AT);
    const calls = { count: 0 };
    const action = frame("action");
    const adopted = frame("adopted", HIERARCHY_AT + 400);
    const handler = new DefaultAfterToolCallHandler(undefined, () => ({
      execute: async () => {
        timer.advanceTime(450);
        return {
          observation: adopted,
          settled: true,
          polls: 2,
          waitMs: 450,
          terminalReason: "settled",
        };
      },
      captureScreenshot: clockCapture(timer, calls),
    }));
    await runWithPostActionCaptureScope(undefined, async () => {
      expect(
        await captureOrDeferTerminalScreenshot(action, async () => {
          throw new Error("the action frame must not be captured");
        }),
      ).toBe(true);
      expect(hasPendingTerminalScreenshot(action)).toBe(true);
      const published = await respond("tapOn", action, handler, timer);
      expect(published.observationId).toBe("adopted");
      expect(published.settled).toBe(true);
      expect(calls.count).toBe(1);
      expect(Date.parse(published.screenshotCapturedAt!)).toBeGreaterThanOrEqual(
        HIERARCHY_AT + 400,
      );
      expect(published.screenshotHierarchyLagMs).toBe(50);
      expect(published.screenshotHierarchyMismatch).toBeUndefined();
    });
  });

  test("an eager capture keeps the deferred retry and failure tracking", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const action = frame("failing");
      let attempts = 0;
      await runWithPostActionCaptureScope(
        undefined,
        async () => {
          await captureOrDeferTerminalScreenshot(action, async () => {
            attempts++;
            throw new Error("capture failed");
          });
          expect(attempts).toBe(2);
          expect(isTerminalScreenshotUnavailable({ ...action })).toBe(true);
        },
        true,
        false,
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("without a scope the caller captures itself", async () => {
    expect(await captureOrDeferTerminalScreenshot(frame("unscoped"), async () => {})).toBe(false);
  });
});
