import { describe, expect, test } from "bun:test";
import { startDeviceSchema } from "../../src/server/deviceTools";

describe("startDevice screenSize validation", () => {
  test.each(
    [-1, 0, NaN, Infinity, -Infinity].flatMap((dimension) => [
      { width: dimension, height: 2400 },
      { width: 1080, height: dimension },
    ]),
  )("rejects invalid dimensions %j", (screenSize) => {
    expect(startDeviceSchema.safeParse({ platform: "android", screenSize }).success).toBe(false);
  });

  test("accepts normal dimensions in both supported request shapes", () => {
    const device = { platform: "android", screenSize: { width: 1080, height: 2400 } };
    expect(startDeviceSchema.safeParse(device).success).toBe(true);
    expect(startDeviceSchema.safeParse({ device }).success).toBe(true);
  });
});
