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

describe("compareScreenshot on an Apple TV simulator (#16725)", () => {
  const APPLE_TV: BootedDevice = { name: "Apple TV 4K", platform: "tvos", deviceId: "tv-udid" };
  const backend = new SharpBackend();

  function tvHandler(
    store: FakeVisualBaselineStore,
    options: { runner: boolean; png: Buffer; captures?: string[] },
  ) {
    return createCompareScreenshotHandler({
      store,
      imageBackend: backend,
      tvosRunnerConnected: () => options.runner,
      tvosScreenshot: async (device) => {
        options.captures?.push(device.deviceId);
        return options.png;
      },
      // Runner bounds are points: a 2x4-point screen behind a 4x8-pixel screenshot.
      hierarchyCaptureFactory: () => ({
        capture: async (request) => ({
          captureId: "tv-capture",
          platform: "ios",
          requestedFreshness: request.freshness,
          receivedAt: 0,
          nodes: [],
          hierarchy: { hierarchy: { node: {} }, screenWidth: 2, screenHeight: 4 },
        }),
      }),
      readSettings: async () => {
        throw new Error("an Apple TV has no display settings reader");
      },
      writeFile: async () => {},
      now: () => "2026-11-05T00:00:00.000Z",
    });
  }

  test("without a runner, records and compares the full simctl screenshot", async () => {
    const store = new FakeVisualBaselineStore();
    const captures: string[] = [];
    const white = solidPng(4, 8, [255, 255, 255, 255]);
    const recorded = (await tvHandler(store, { runner: false, png: white, captures })(APPLE_TV, {
      baseline: "home",
      mode: "record",
    } as never)) as ToolResult;
    expect(compareScreenshotResultSchema.parse(recorded.structuredContent)).toMatchObject({
      status: "recorded",
      profile: { platform: "tvos", width: 4, height: 8, density: null, fontScale: null },
    });
    const changed = solidPng(4, 8, [255, 255, 255, 255], [{ x: 0, y: 0, color: [0, 0, 0, 255] }]);
    const compared = (await tvHandler(store, { runner: false, png: changed, captures })(APPLE_TV, {
      baseline: "home",
      mode: "compare",
    } as never)) as ToolResult;
    expect(compared.structuredContent).toMatchObject({
      status: "compared",
      match: false,
      diffPixels: 1,
      comparedPixels: 32,
    });
    expect(captures).toEqual(["tv-udid", "tv-udid"]);
  });

  test("without a runner, a target or mask region is refused with the way forward", async () => {
    const call = tvHandler(new FakeVisualBaselineStore(), {
      runner: false,
      png: solidPng(4, 8, [255, 255, 255, 255]),
    });
    await expect(
      call(APPLE_TV, {
        baseline: "home",
        mode: "record",
        target: { rect: { left: 0, top: 0, right: 1, bottom: 1 } },
      } as never),
    ).rejects.toThrow("compareScreenshot target and mask regions on tvOS need the tvOS runner");
  });

  test("with the runner, a point rectangle crops the matching screenshot pixels", async () => {
    const store = new FakeVisualBaselineStore();
    const recorded = (await tvHandler(store, {
      runner: true,
      png: solidPng(4, 8, [255, 255, 255, 255]),
    })(APPLE_TV, {
      baseline: "focus",
      mode: "record",
      target: { rect: { left: 0, top: 0, right: 2, bottom: 2 } },
    } as never)) as ToolResult;
    expect(recorded.structuredContent).toMatchObject({ status: "recorded" });
    const [baseline] = [...store.baselines.values()];
    expect(await backend.metadata(baseline.png)).toMatchObject({ width: 4, height: 4 });
  });
});
