import { expect, test } from "bun:test";
import type { ObserveResult } from "../../src/models";
import {
  beginPostActionCaptureAction,
  isTerminalScreenshotUnavailable,
  terminalScreenshotCaptureError,
  deferTerminalScreenshot,
  hasPendingTerminalScreenshot,
  runWithPostActionCaptureScope,
} from "../../src/utils/PostActionCaptureContext";

const frame = (): ObserveResult => ({
  deviceId: "fake-device",
  observationId: "frame",
  screenSize: { width: 100, height: 100 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  viewHierarchy: { hierarchy: {} },
});

test("throwing handler discards pending captures and closes descendant scope", async () => {
  let captures = 0;
  const release = Promise.withResolvers<void>();
  let later: Promise<boolean> | undefined;
  const error = new Error("handler failed");
  const observation = frame();
  const capture = async () => {
    captures++;
  };
  await expect(
    runWithPostActionCaptureScope(undefined, async () => {
      deferTerminalScreenshot(observation, capture);
      later = release.promise.then(() => {
        const deferred = deferTerminalScreenshot(observation, capture);
        expect(hasPendingTerminalScreenshot(observation)).toBe(false);
        return deferred;
      });
      throw error;
    }),
  ).rejects.toBe(error);
  expect(captures).toBe(0);
  release.resolve();
  expect(await later).toBe(true);
  expect(captures).toBe(0);
});

test("action boundary consumes before awaiting and retries with the scope signal", async () => {
  const controller = new AbortController();
  const observation = frame();
  const error = new Error("earlier capture failed");
  let attempts = 0;
  await runWithPostActionCaptureScope(controller.signal, async () => {
    expect(
      deferTerminalScreenshot(observation, async (_chosen, signal) => {
        expect(signal).toBe(controller.signal);
        expect(hasPendingTerminalScreenshot(observation)).toBe(false);
        attempts++;
        throw error;
      }),
    ).toBe(true);
    await beginPostActionCaptureAction();
    expect(attempts).toBe(2);
    const textCopy: ObserveResult = JSON.parse(JSON.stringify(observation));
    expect(isTerminalScreenshotUnavailable(textCopy)).toBe(true);
    expect(terminalScreenshotCaptureError(textCopy)).toBe(error);
    expect(deferTerminalScreenshot({ ...frame(), observationId: "next" }, async () => {})).toBe(
      false,
    );
    expect(hasPendingTerminalScreenshot(observation)).toBe(false);
  });
  expect(attempts).toBe(2);
});
