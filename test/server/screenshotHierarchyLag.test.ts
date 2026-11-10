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

function frame(id: string, updatedAt = HIERARCHY_AT): ObserveResult {
  return {
    ...buildObserveResult({
      updatedAt,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: {
        packageName: "com.example.chat",
        hierarchy: { node: { class: "android.widget.EditText", text: id } },
        updatedAt,
      },
    }),
    deviceId: device.deviceId,
    observationId: id,
  };
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

  test("the threshold is injectable and a negative skew is never a mismatch", () => {
    const late = {
      ...frame("x"),
      screenshotCapturedAt: new Date(HIERARCHY_AT + 200).toISOString(),
    };
    stampScreenshotHierarchyLag(late, 100);
    expect(late.screenshotHierarchyMismatch).toBe(true);
    const skewed = {
      ...frame("y"),
      screenshotCapturedAt: new Date(HIERARCHY_AT - 40).toISOString(),
    };
    stampScreenshotHierarchyLag(skewed);
    expect(skewed.screenshotHierarchyLagMs).toBe(-40);
    expect(skewed.screenshotHierarchyMismatch).toBeUndefined();
    expect(SCREENSHOT_HIERARCHY_LAG_THRESHOLD_MS).toBe(500);
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
