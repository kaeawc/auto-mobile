import { describe, expect, test } from "bun:test";
import { resolveGestureCtrlProxyTimeoutMs } from "../../../src/features/action/gestureTransportTimeout";
import { dispatchAndroidLongPress } from "../../../src/features/action/androidLongPress";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const base = { x: 10, y: 20, durationMs: 1000, logTag: "Test" };

describe("dispatchAndroidLongPress", () => {
  test("sends the touchscreen swipe once with a duration-sized timeout", async () => {
    const adb = new FakeAdbExecutor();
    await dispatchAndroidLongPress({ ...base, adb });
    expect(adb.getExecutedCommands()).toEqual(["shell input touchscreen swipe 10 20 10 20 1000"]);
    expect(adb.getCommandCalls()[0].timeoutMs).toBe(resolveGestureCtrlProxyTimeoutMs(1000));
  });

  test("rounds fractional durations to an integer for Android's parser", async () => {
    const adb = new FakeAdbExecutor();
    await dispatchAndroidLongPress({ ...base, adb, durationMs: 0.4 });
    expect(adb.getExecutedCommands()[0]).toBe("shell input touchscreen swipe 10 20 10 20 1");
  });

  test("falls back to the generic input source when the touchscreen source reports an error", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("input touchscreen swipe", {
      stdout: "",
      stderr: "Error: unsupported",
    } as never);
    await dispatchAndroidLongPress({ ...base, adb });
    expect(adb.getExecutedCommands()).toEqual([
      "shell input touchscreen swipe 10 20 10 20 1000",
      "shell input swipe 10 20 10 20 1000",
    ]);
  });

  test("wraps a failure of both sources in an ActionableError", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("input", new Error("boom"));
    await expect(dispatchAndroidLongPress({ ...base, adb })).rejects.toBeInstanceOf(
      ActionableError,
    );
  });

  test("a stale display fence stops the dispatch before any command", async () => {
    const adb = new FakeAdbExecutor();
    await expect(
      dispatchAndroidLongPress({
        ...base,
        adb,
        assertCurrent: () => {
          throw new Error("stale");
        },
      }),
    ).rejects.toThrow();
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an aborted signal never reaches adb", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    controller.abort();
    await expect(
      dispatchAndroidLongPress({ ...base, adb, signal: controller.signal }),
    ).rejects.toThrow();
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
