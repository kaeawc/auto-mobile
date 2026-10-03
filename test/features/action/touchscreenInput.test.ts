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
    expect(adb.getCommandCalls()[0].timeoutMs).toBeUndefined();
  });

  test.each([false, true])("passes an explicit timeout to ADB (fenced %s)", async (fenced) => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    let assertions = 0;
    const assertCurrent = () => {
      assertions++;
    };
    await executeTouchscreenInput(
      adb,
      "swipe 10 20 10 20 20000",
      2,
      controller.signal,
      fenced ? assertCurrent : undefined,
      { timeoutMs: 22000 },
    );
    expect(adb.getCommandCalls()[0]).toMatchObject({ timeoutMs: 22000, signal: controller.signal });
    expect(assertions).toBe(fenced ? 1 : 0);
  });
});
