import { describe, expect, test } from "bun:test";
import { createCompareScreenshotHandler } from "../../src/server/compareScreenshotTools";
import { compareScreenshotResultSchema } from "../../src/server/compareScreenshotToolOutputSchemas";
import type { BootedDevice, ScreenshotResult } from "../../src/models";
import { SharpBackend } from "../../src/utils/image/backend/SharpBackend";
import { FakeVisualBaselineStore } from "../fakes/FakeVisualBaselineStore";
import { solidPng } from "../helpers/pngFixtures";

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

interface ToolResult {
  structuredContent: Record<string, unknown>;
  isError?: true;
}

function handler(store: FakeVisualBaselineStore) {
  const png = solidPng(4, 8, [255, 255, 255, 255]);
  return createCompareScreenshotHandler({
    store,
    imageBackend: new SharpBackend(),
    hierarchyCaptureFactory: () => ({
      capture: async (request) => ({
        captureId: "capture-1",
        platform: "android",
        requestedFreshness: request.freshness,
        receivedAt: 0,
        nodes: [],
        hierarchy: { hierarchy: { node: {} }, screenWidth: 4, screenHeight: 8, density: 420 },
      }),
    }),
    screenshotFactory: () => ({
      execute: async (): Promise<ScreenshotResult> => ({ success: true, path: "/shot.png" }),
    }),
    readFile: async () => png,
    readSettings: async () => ({
      success: true,
      deviceId: ANDROID.deviceId,
      platform: "android",
      supported: { fontScale: true, density: true, theme: true },
      current: { fontScale: 1, theme: "light" },
    }),
    writeFile: async () => {},
    now: () => "2026-10-21T00:00:00.000Z",
  });
}

describe("compareScreenshot tool (#14083)", () => {
  test("records, then compares, through the device capture and profile", async () => {
    const store = new FakeVisualBaselineStore();
    const call = handler(store);
    const recorded = (await call(ANDROID, {
      baseline: "home",
      mode: "record",
    } as never)) as ToolResult;
    expect(recorded.isError).toBeUndefined();
    expect(compareScreenshotResultSchema.parse(recorded.structuredContent)).toMatchObject({
      status: "recorded",
      profile: { platform: "android", width: 4, height: 8, density: 420, theme: "light" },
    });
    const compared = (await call(ANDROID, {
      baseline: "home",
      mode: "compare",
    } as never)) as ToolResult;
    expect(compared.structuredContent).toMatchObject({ status: "compared", match: true });
  });

  test("a missing baseline is an isError result with a typed code", async () => {
    const result = (await handler(new FakeVisualBaselineStore())(ANDROID, {
      baseline: "home",
      mode: "compare",
    } as never)) as ToolResult;
    expect(result.isError).toBe(true);
    expect(compareScreenshotResultSchema.parse(result.structuredContent)).toMatchObject({
      success: false,
      errorCode: "baseline_missing",
    });
  });
});
