import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { afterEach, beforeAll, expect, test } from "bun:test";
import {
  tapAtSchema,
  hitTestSchema,
  tapAtHandler,
  setTapAtElementFactory,
  resetTapAtElementFactory,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import type { TapAtOptions } from "../../src/models/TapAtOptions";
import { cropSource } from "../helpers/imageRelativePoint";

isolateToolRegistry();

const screenshot = {
  screenSize: { width: 100, height: 200 },
  screenshotOrientation: "display" as const,
};
const image = { unit: "normalized" as const, x: 0.25, y: 0.5, source: { screenshot } };
const args = { image };
afterEach(resetTapAtElementFactory);

beforeAll(async () => {
  // One-time cold-start work (lazy zod schema build, registering and JSON-schema-converting the
  // ~20 interaction tools, first crop; ~15 ms in the first test that touches each) is paid here,
  // outside the per-test budget. Nothing asserts on these throwaway calls.
  tapAtSchema.safeParse(args);
  await cropSource(
    {
      platform: "ios",
      screenSize: screenshot.screenSize,
      rotation: 1,
      rasterOrientation: "display",
    },
    { width: 300, height: 600 },
    { left: -10, top: 20, right: 60, bottom: 100 },
  );
  registerInteractionTools();
  ToolRegistry.getToolDefinitions({ includeUnavailable: true });
  ToolRegistry.clearTools();
});

test("strict image argument schema preserves the bare coordinate and hitTest forms", async () => {
  expect(tapAtSchema.safeParse(args).success).toBe(true);
  expect(tapAtSchema.safeParse({ x: 10, y: 20 }).success).toBe(true);
  expect(tapAtSchema.safeParse({ x: 1, y: 1, coordinateSpace: "normalized" }).success).toBe(true);
  expect(hitTestSchema.safeParse(args).success).toBe(false);
  expect(hitTestSchema.safeParse({ x: 10, y: 20 }).success).toBe(true);
  const source = await cropSource(
    {
      platform: "ios",
      screenSize: screenshot.screenSize,
      rotation: 1,
      rasterOrientation: "display",
    },
    { width: 300, height: 600 },
    { left: -10, top: 20, right: 60, bottom: 100 },
  );
  expect(tapAtSchema.safeParse({ image: { ...image, source } }).success).toBe(true);
  expect(
    tapAtSchema.safeParse({
      image: { ...image, source: { crop: { ...source.crop, cropPath: undefined } } },
    }).success,
  ).toBe(true);
});

test.each([
  {},
  { x: 10 },
  { y: 20 },
  { ...args, x: 1 },
  { ...args, y: 1 },
  { ...args, coordinateSpace: "absolute" },
  { image: { ...image, x: 320 } },
  { image: { ...image, x: -0.01 } },
  { image: { ...image, unit: "pixels" } },
  { image: { ...image, unit: "points" } },
  { image: { ...image, x: NaN } },
  { image: { ...image, y: Infinity } },
  { image: { ...image, surprise: true } },
  { image: { ...image, source: { screenshot: { ...screenshot, screenScale: 3 } } } },
  {
    image: { ...image, source: { screenshot: { ...screenshot, screenshotOrientation: "native" } } },
  },
  { image: { ...image, source: { screenshot: { ...screenshot, rotation: 4 } } } },
  {
    image: {
      ...image,
      source: { screenshot: { ...screenshot, screenSize: { ...screenshot.screenSize, extra: 1 } } },
    },
  },
])("rejects malformed or ambiguous shape %j", (value) => {
  expect(tapAtSchema.safeParse(value).success).toBe(false);
});

test("schema pixel range is half-open and names pixels", () => {
  const pixels = {
    ...image,
    unit: "pixels",
    source: { screenshot: { ...screenshot, imageSize: { width: 300, height: 600 } } },
  };
  expect(tapAtSchema.safeParse({ image: { ...pixels, x: 299.9, y: 599.9 } }).success).toBe(true);
  const parsed = tapAtSchema.safeParse({ image: { ...pixels, x: 300 } });
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.message).toContain("pixels x must be in [0, 300)");
  }
  expect(
    tapAtSchema.safeParse({
      image: {
        ...pixels,
        source: {
          screenshot: { ...pixels.source.screenshot, screenshotOrientation: "native", rotation: 0 },
        },
      },
    }).success,
  ).toBe(true);
});

test("tapAtHandler forwards image, snapshot, action and duration and reports native result", async () => {
  const calls: TapAtOptions[] = [];
  setTapAtElementFactory(() => ({
    execute: async (options) => {
      calls.push(options);
      return { success: true, x: 25, y: 100, action: options.action };
    },
  }));
  const response = await tapAtHandler(
    { deviceId: "fake", name: "Fake", platform: "ios" },
    { ...args, snapshotId: "same-frame", action: "longPress", durationMs: 750 },
  );
  expect(calls).toEqual([
    { image, display: undefined, snapshotId: "same-frame", action: "longPress", durationMs: 750 },
  ]);
  expect(JSON.stringify(response)).toContain("Long pressed at (25, 100)");
});

test("advertised tapAt schema retains image metadata and the original argument fields", () => {
  registerInteractionTools();
  try {
    const tool = ToolRegistry.getToolDefinitions({ includeUnavailable: true }).find(
      (tool) => tool.name === "tapAt",
    );
    expect(tool?.inputSchema.properties).toHaveProperty("image");
    expect(tool?.inputSchema.properties).toHaveProperty("x");
    expect(tool?.inputSchema.properties).toHaveProperty("y");
    expect(tool?.inputSchema.properties).toHaveProperty("snapshotId");
    expect(JSON.stringify(tool?.inputSchema)).toContain("screenshotOrientation");
    expect(JSON.stringify(tool?.inputSchema)).toContain("pixelsPerNativeUnit");
  } finally {
    ToolRegistry.clearTools();
  }
});
