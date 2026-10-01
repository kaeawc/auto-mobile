import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models";
import {
  executeTouchscreenInput,
  touchscreenInputCommand,
} from "../../../src/features/action/touchscreenInput";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

describe("touchscreen input", () => {
  test("puts the source before the display and preserves the default command", () => {
    expect(touchscreenInputCommand("tap 334 1281", 0)).toBe(
      "shell input touchscreen -d 0 tap 334 1281",
    );
    expect(touchscreenInputCommand("tap 334 1281")).toBe("shell input touchscreen tap 334 1281");
  });

  for (const [stream, output] of [
    ["stdout", "Unknown command: touchscreen"],
    ["stderr", "Usage: input [<source>] [-d DISPLAY_ID] <command>"],
  ] as const) {
    test(`rejects ${stream} input failure output despite a successful exit`, async () => {
      const adb = new FakeAdbExecutor();
      const command = "shell input touchscreen -d 0 tap 334 1281";
      adb.setCommandResponse(command, {
        stdout: stream === "stdout" ? output : "",
        stderr: stream === "stderr" ? output : "",
      });
      try {
        await executeTouchscreenInput(adb, "tap 334 1281", 0);
        throw new Error("Expected touchscreen input to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ActionableError);
        expect((error as Error).message).toContain("input touchscreen -d 0 tap 334 1281");
        expect((error as Error).message).toContain(output);
      }
    });
  }

  test("accepts empty command output", async () => {
    const adb = new FakeAdbExecutor();
    await expect(executeTouchscreenInput(adb, "tap 334 1281", 0)).resolves.toBeUndefined();
  });
});
