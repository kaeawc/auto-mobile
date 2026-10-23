import { describe, expect, test } from "bun:test";
import {
  createRotaryScrollHandler,
  rotaryScrollResultSchema,
  rotaryScrollSchema,
} from "../../src/server/rotaryScrollTool";
import { ActionableError, type BootedDevice } from "../../src/models";
import type { RotaryScroller, RotaryScrollResult } from "../../src/features/wear/RotaryScroll";
import { toolJson } from "../helpers/toolResponse";

const android: BootedDevice = { name: "Wear", deviceId: "emulator-5554", platform: "android" };
const ios: BootedDevice = { name: "iPhone", deviceId: "sim-1", platform: "ios" };

function setup(result: RotaryScrollResult) {
  const calls: number[] = [];
  const scroller: RotaryScroller = {
    scroll: async ({ delta }) => {
      calls.push(delta);
      return result;
    },
  };
  return { calls, handler: createRotaryScrollHandler(() => scroller) };
}

describe("rotaryScroll tool", () => {
  test("reports the working method and the attempts", async () => {
    const { calls, handler } = setup({
      success: true,
      delta: 3,
      method: "swipe",
      attempts: [
        {
          method: "input_rotaryencoder",
          command: "shell input rotaryencoder scroll 3",
          outcome: "failed",
          error: "Error",
        },
        { method: "swipe", command: "shell input swipe 1 2 3 4 250", outcome: "scrolled" },
      ],
    });
    const response = await handler(android, { delta: 3 });
    const json = toolJson(response);
    expect(rotaryScrollResultSchema.safeParse(json).success).toBe(true);
    expect(calls).toEqual([3]);
    expect(json.success).toBe(true);
    expect(json.method).toBe("swipe");
    expect((json.attempts as unknown[]).length).toBe(2);
  });

  test("a call where nothing moved the screen is an error response with a reason", async () => {
    const { handler } = setup({
      success: false,
      delta: 1,
      attempts: [],
      reason: "No rotary candidate changed the screen on read-back.",
    });
    const response = await handler(android, { delta: 1 });
    expect((response as { isError?: boolean }).isError).toBe(true);
    expect(toolJson(response).reason).toContain("No rotary candidate");
  });

  test("is Android-only", async () => {
    const { handler } = setup({ success: true, delta: 1, attempts: [] });
    await expect(handler(ios, { delta: 1 })).rejects.toBeInstanceOf(ActionableError);
  });

  test("delta must be a non-zero integer within the cap", () => {
    expect(rotaryScrollSchema.safeParse({ delta: 5 }).success).toBe(true);
    expect(rotaryScrollSchema.safeParse({ delta: -50 }).success).toBe(true);
    expect(rotaryScrollSchema.safeParse({ delta: 0 }).success).toBe(false);
    expect(rotaryScrollSchema.safeParse({ delta: 51 }).success).toBe(false);
    expect(rotaryScrollSchema.safeParse({ delta: 1.5 }).success).toBe(false);
  });
});
