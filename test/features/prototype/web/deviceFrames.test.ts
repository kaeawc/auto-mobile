import { describe, expect, test } from "bun:test";
import {
  DEVICE_FRAMES,
  deviceFrameOrThrow,
  defaultDeviceFrameId,
  deviceFrameProblems,
  parseDeviceFrames,
} from "../../../../src/features/prototype/web/deviceFrames";
import registry from "../../../../src/features/prototype/web/deviceFrames.json";

const frame = (overrides: Record<string, unknown> = {}) => ({
  ...structuredClone(registry.frames[0]),
  ...overrides,
});

describe("device frame registry (#16346)", () => {
  test("every checked-in frame is valid", () => {
    expect(deviceFrameProblems(registry)).toEqual([]);
    expect(DEVICE_FRAMES.length).toBe(registry.frames.length);
  });

  test("ships at least one Android and one iOS frame, with platform defaults", () => {
    expect(deviceFrameOrThrow(defaultDeviceFrameId("android")).platform).toBe("android");
    expect(deviceFrameOrThrow(defaultDeviceFrameId("ios")).platform).toBe("ios");
  });

  test("an unknown frame lists the valid ids", () => {
    expect(() => deviceFrameOrThrow("nokia-3310")).toThrow(
      `Unknown device frame "nokia-3310". Valid frames: ${DEVICE_FRAMES.map((f) => f.id).join(", ")}`,
    );
  });

  test("rejects duplicate ids", () => {
    expect(deviceFrameProblems({ frames: [frame(), frame()] })).toEqual([
      `frames[1].id: duplicate id "${registry.frames[0].id}"`,
    ]);
  });

  test("rejects a cutout outside the screen", () => {
    const cutout = { type: "punchHole", centerXDp: 1000, centerYDp: 20, radiusDp: 10 };
    expect(deviceFrameProblems({ frames: [frame({ cutout })] })).toEqual([
      "frames[0].cutout: lies outside the portrait screen",
    ]);
  });

  test("rejects safe areas that leave no screen", () => {
    const safeArea = {
      portrait: { top: 500, bottom: 500, left: 0, right: 0 },
      landscape: { top: 0, bottom: 0, left: 0, right: 0 },
    };
    expect(deviceFrameProblems({ frames: [frame({ safeArea })] })).toEqual([
      "frames[0].safeArea.portrait: insets leave no screen",
    ]);
  });

  test("rejects unknown fields and a missing source", () => {
    const withoutSource: Record<string, unknown> = frame();
    delete withoutSource.source;
    expect(parseDeviceFrames({ frames: [withoutSource] }).success).toBe(false);
    expect(parseDeviceFrames({ frames: [frame({ extra: true })] }).success).toBe(false);
  });
});
