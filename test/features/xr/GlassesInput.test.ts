import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AdbGlassesInputInjector,
  GLASSES_AXES,
  GLASSES_GESTURES,
  GLASSES_KEY_CODES,
} from "../../../src/features/xr/GlassesInput";
import type {
  AdbCommandRunner,
  AdbExecuteOptions,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";
import { ActionableError } from "../../../src/models";

class FakeGlassesAdb implements AdbCommandRunner {
  calls: Array<{ command: string; options?: AdbExecuteOptions }> = [];
  output = "";
  stderr = "";
  failAt = -1;
  async executeCommand(command: string, options?: AdbExecuteOptions) {
    this.calls.push({ command, options });
    if (this.calls.length === this.failAt) {
      throw new Error("device offline");
    }
    return createExecResult(this.output, this.stderr);
  }
}

describe("glasses input", () => {
  for (const axis of GLASSES_AXES) {
    for (const gesture of GLASSES_GESTURES) {
      test(`${axis} ${gesture} sends only the mapped key, in order`, async () => {
        const adb = new FakeGlassesAdb();
        const signal = new AbortController().signal;
        const result = await new AdbGlassesInputInjector(adb).inject({
          gesture,
          axis,
          count: 3,
          signal,
        });
        const key = GLASSES_KEY_CODES[axis][gesture];
        expect(result).toMatchObject({
          success: true,
          gesture,
          axis,
          count: 3,
          keyCodes: [key, key, key],
          commands: Array(3).fill(`shell input keyevent ${key}`),
        });
        expect(adb.calls).toEqual(
          result.commands.map((command) => ({
            command,
            options: { timeoutMs: 10_000, noRetry: true, signal },
          })),
        );
      });
    }
  }

  test("defaults to vertical and one repetition, including tap", async () => {
    const adb = new FakeGlassesAdb();
    expect(await new AdbGlassesInputInjector(adb).inject({ gesture: "tap" })).toMatchObject({
      success: true,
      axis: "vertical",
      count: 1,
      keyCodes: ["KEYCODE_DPAD_CENTER"],
    });
    expect(adb.calls).toHaveLength(1);
  });

  for (const output of [
    "Error: rejected",
    "Exception: denied",
    "KO: failed",
    "Invalid command",
    "Unknown command",
    "No shell command",
    "Unknown source",
  ]) {
    test(`stops on error output: ${output}`, async () => {
      const adb = new FakeGlassesAdb();
      adb.output = output;
      const result = await new AdbGlassesInputInjector(adb).inject({
        gesture: "swipeForward",
        count: 20,
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain(output);
      expect(result.commands).toHaveLength(1);
      expect(adb.calls).toHaveLength(1);
    });
  }
  test("checks stderr too", async () => {
    const adb = new FakeGlassesAdb();
    adb.stderr = "Error: denied";
    expect((await new AdbGlassesInputInjector(adb).inject({ gesture: "tap" })).success).toBe(false);
  });
  test("transport failures are actionable and stop repetitions", async () => {
    const adb = new FakeGlassesAdb();
    adb.failAt = 2;
    await expect(
      new AdbGlassesInputInjector(adb).inject({ gesture: "tap", count: 20 }),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(adb.calls).toHaveLength(2);
  });
  test("pre-aborted requests send nothing", async () => {
    const adb = new FakeGlassesAdb();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new AdbGlassesInputInjector(adb).inject({ gesture: "tap", signal: controller.signal }),
    ).rejects.toThrow();
    expect(adb.calls).toEqual([]);
  });
  test("every emitted key is captured as an app-observed effect", () => {
    const capture = readFileSync(
      new URL("../../fixtures/android-xr/glasses-input-captures.txt", import.meta.url),
      "utf8",
    );
    const blocks = capture
      .split(/^## /m)
      .slice(1)
      .map((block) => {
        const [command, ...effect] = block.trim().split("\n");
        return { command, effect: effect.join("\n") };
      });
    const effects: Record<string, string> = {
      KEYCODE_DPAD_CENTER: "clicks: 1 last: Item 1",
      KEYCODE_DPAD_DOWN: "focus: Item 2",
      KEYCODE_DPAD_UP: "focus: Item 1",
      KEYCODE_DPAD_RIGHT: "FOCUSED=ITEM 1",
      KEYCODE_DPAD_LEFT: "FOCUSED=ITEM 1",
    };
    for (const key of new Set(
      Object.values(GLASSES_KEY_CODES).flatMap((axis) => Object.values(axis)),
    )) {
      const captured = blocks.filter((block) => block.effect.includes(`key ${key} ACTION_UP`));
      expect(captured.length).toBeGreaterThan(0);
      expect(
        captured.some(
          (block) => block.command.startsWith("input ") && block.effect.includes(effects[key]),
        ),
      ).toBe(true);
    }
    // Horizontal keys were delivered; the captured fixture is a vertical list, so focus stays put.
    expect(
      blocks.find((block) => block.command === "input touchpad tap 225 225")?.effect,
    ).toContain("motion 0x100008");
  });
});
