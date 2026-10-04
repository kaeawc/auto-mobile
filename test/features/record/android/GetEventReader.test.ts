import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GetEventReader } from "../../../../src/features/record/android/GetEventReader";
import { buildScaler } from "../../../../src/features/record/android/AxisRanges";
import type { GestureEvent } from "../../../../src/features/record/android/types";
import type { AdbProcess } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbProcess } from "../../../fakes/FakeAdbProcess";
import { FakeTimer } from "../../../fakes/FakeTimer";

// Format probes (hand-written, shape defined by TouchFrameReconstructor's regex;
// not captured device output). Reused from TouchFrameReconstructor.test.ts.
const DOWN =
  [
    "[  1.000000] EV_ABS    ABS_MT_TRACKING_ID   00000001",
    "[  1.000001] EV_ABS    ABS_MT_POSITION_X    000001a4",
    "[  1.000002] EV_ABS    ABS_MT_POSITION_Y    000002b0",
    "[  1.000003] EV_KEY    BTN_TOUCH            DOWN",
    "[  1.000004] EV_SYN    SYN_REPORT           00000000",
  ].join("\n") + "\n";
const UP =
  [
    "[  1.100000] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
    "[  1.100001] EV_KEY    BTN_TOUCH            UP",
    "[  1.100002] EV_SYN    SYN_REPORT           00000000",
  ].join("\n") + "\n";
const KEY_BACK = "[  5.000000] EV_KEY    KEY_BACK             DOWN\n";

// Keep spawn control local: the shared executor fake has no streaming support.
class ReaderAdb extends FakeAdbExecutor {
  readonly spawn = mock<(args: string[]) => Promise<AdbProcess>>();
}

function setup() {
  const adb = new ReaderAdb();
  const proc = new FakeAdbProcess();
  adb.spawn.mockResolvedValue(proc);
  const timer = new FakeTimer();
  timer.advanceTime(1000);
  const reader = new GetEventReader({
    adb,
    timer,
    density: 1,
    touchNode: {
      path: "/dev/input/event2",
      name: "touch",
      axisXMin: 0,
      axisXMax: 1079,
      axisYMin: 0,
      axisYMax: 1919,
    },
    scaler: buildScaler({
      xMin: 0,
      xMax: 1079,
      yMin: 0,
      yMax: 1919,
      displayWidth: 1080,
      displayHeight: 1920,
      rotation: 0,
    }),
  });
  const onGesture = mock<(event: GestureEvent) => void>();
  const onError = mock<(error: Error) => void>();
  return { adb, proc, timer, reader, onGesture, onError };
}

function data(proc: FakeAdbProcess, text: string): void {
  proc.stdout.emit("data", Buffer.from(text));
}

function expectCleaned(proc: FakeAdbProcess): void {
  expect(proc.stdout.listenerCount("data")).toBe(0);
  expect(proc.stderr.listenerCount("data")).toBe(0);
  expect(proc.listenerCount("exit")).toBe(0);
  expect(proc.listenerCount("error")).toBe(1);
}

afterEach(() => mock.restore());

describe("GetEventReader", () => {
  test("spawns exact argv once while pending and running", async () => {
    const { adb, reader, onGesture } = setup();
    reader.start(onGesture);
    reader.start(onGesture);
    expect(adb.spawn).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    reader.start(onGesture);
    expect(adb.spawn).toHaveBeenCalledTimes(1);
    expect(adb.spawn).toHaveBeenCalledWith(["shell", "getevent", "-lt", "/dev/input/event2"]);
    reader.stop();
  });

  test("pipes touch and key probes through with injected arrival timestamps", async () => {
    const { reader, proc, timer, onGesture } = setup();
    reader.start(onGesture);
    await Promise.resolve();
    data(proc, DOWN);
    timer.advanceTime(50);
    data(proc, UP);
    expect(onGesture).toHaveBeenNthCalledWith(1, {
      type: "tap",
      arrivedAt: 1050,
      screenX: 420,
      screenY: 688,
    });
    timer.advanceTime(20);
    data(proc, KEY_BACK);
    expect(onGesture).toHaveBeenNthCalledWith(2, {
      type: "pressButton",
      button: "back",
      arrivedAt: 1070,
    });
    reader.stop();
  });

  test("reassembles split lines and skips blanks without reading the clock", async () => {
    const { reader, proc, timer, onGesture } = setup();
    const now = spyOn(timer, "now");
    reader.start(onGesture);
    await Promise.resolve();
    data(proc, "\n \t\n" + KEY_BACK.slice(0, 30));
    expect(now).not.toHaveBeenCalled();
    expect(onGesture).not.toHaveBeenCalled();
    timer.advanceTime(42);
    data(proc, KEY_BACK.slice(30) + "\n  \n");
    expect(now).toHaveBeenCalledTimes(1);
    expect(onGesture).toHaveBeenCalledWith({
      type: "pressButton",
      button: "back",
      arrivedAt: 1042,
    });
    reader.stop();
  });

  test("stop before spawn resolves kills the eventual child once", async () => {
    const { adb, proc, reader, onGesture, onError } = setup();
    const pending = Promise.withResolvers<AdbProcess>();
    adb.spawn.mockReturnValue(pending.promise);
    const kill = spyOn(proc, "kill");
    reader.start(onGesture, onError);
    reader.stop();
    reader.stop();
    pending.resolve(proc);
    await Promise.resolve();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(adb.spawn).toHaveBeenCalledTimes(1);
    expect(() => proc.emit("error", new Error("late cancellation error"))).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  test("stop is idempotent and detaches listeners before kill emits exit", async () => {
    const { reader, proc, onGesture, onError } = setup();
    reader.start(onGesture, onError);
    await Promise.resolve();
    const kill = spyOn(proc, "kill").mockImplementation(() => {
      proc.emit("exit", null, "SIGTERM");
      proc.emit("error", new Error("caller shutdown"));
      return true;
    });
    reader.stop();
    reader.stop();
    expect(kill).toHaveBeenCalledTimes(1);
    expectCleaned(proc);
    proc.emit("exit", 0, null);
    data(proc, KEY_BACK);
    expect(onError).not.toHaveBeenCalled();
    expect(onGesture).not.toHaveBeenCalled();
  });

  test("spawn rejection reports the error and allows retry", async () => {
    const { adb, reader, onGesture, onError } = setup();
    const error = new Error("spawn failed");
    adb.spawn.mockRejectedValueOnce(error);
    reader.start(onGesture, onError);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error);
    reader.start(onGesture, onError);
    await Promise.resolve();
    expect(adb.spawn).toHaveBeenCalledTimes(2);
    reader.stop();
  });

  test("child error cleans up, makes stop harmless, and isolates the restarted child", async () => {
    const { adb, reader, proc, onGesture, onError } = setup();
    const kill = spyOn(proc, "kill");
    reader.start(onGesture, onError);
    await Promise.resolve();
    const error = new Error("process failed");
    proc.emit("error", error);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
    expectCleaned(proc);
    expect(() => reader.stop()).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
    const next = new FakeAdbProcess();
    adb.spawn.mockResolvedValue(next);
    reader.start(onGesture, onError);
    await Promise.resolve();
    expect(() => proc.emit("error", new Error("late error"))).not.toThrow();
    proc.emit("exit", 9, null);
    data(proc, KEY_BACK);
    reader.start(onGesture, onError);
    expect(adb.spawn).toHaveBeenCalledTimes(2);
    data(next, KEY_BACK);
    expect(onGesture).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    reader.stop();
    expect(next.killed).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  test.each([
    [7, null, "code 7"],
    [null, "SIGTERM", "signal SIGTERM"],
  ] as const)(
    "unexpected exit (%s, %s) warns, reports, and permits restart",
    async (code, signal, message) => {
      const { adb, reader, proc, onGesture, onError } = setup();
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      reader.start(onGesture, onError);
      await Promise.resolve();
      proc.emit("exit", code, signal);
      expect(warn).toHaveBeenCalledWith(`[GetEventReader] getevent exited with ${message}`);
      expect(onError.mock.calls[0][0].message).toContain(message);
      expectCleaned(proc);
      reader.stop();
      expect(proc.killed).toBe(false);
      adb.spawn.mockResolvedValue(new FakeAdbProcess());
      reader.start(onGesture, onError);
      await Promise.resolve();
      expect(adb.spawn).toHaveBeenCalledTimes(2);
      reader.stop();
    },
  );

  test.each([
    [1, null],
    [null, "SIGPIPE"],
  ] as const)(
    "exit reports code/signal and a bounded stderr tail (%s, %s)",
    async (code, signal) => {
      const { reader, proc, onGesture, onError } = setup();
      reader.start(onGesture, onError);
      await Promise.resolve();
      proc.stderr.emit("data", Buffer.from("discarded-prefix" + "x".repeat(4096)));
      proc.stderr.emit("data", Buffer.from("permission denied\n"));
      proc.emit("exit", code, signal);
      const message = onError.mock.calls[0][0].message;
      expect(message).toContain(signal ? `signal ${signal}` : `code ${code}`);
      expect(message).toContain("permission denied");
      expect(message).not.toContain("discarded-prefix");
      expect(message.length).toBeLessThan(4200);
      expect(onError).toHaveBeenCalledTimes(1);
      expectCleaned(proc);
    },
  );

  test("process error includes the stderr tail when available", async () => {
    const { reader, proc, onGesture, onError } = setup();
    reader.start(onGesture, onError);
    await Promise.resolve();
    proc.stderr.emit("data", Buffer.from("adb disconnected"));
    proc.emit("error", new Error("read failed"));
    expect(onError.mock.calls[0][0].message).toContain("read failed");
    expect(onError.mock.calls[0][0].message).toContain("adb disconnected");
  });

  test("spawn rejection after caller stop is not reported", async () => {
    const { adb, reader, onGesture, onError } = setup();
    const pending = Promise.withResolvers<AdbProcess>();
    adb.spawn.mockReturnValue(pending.promise);
    reader.start(onGesture, onError);
    reader.stop();
    pending.reject(new Error("spawn cancelled"));
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  test("code-zero exit before stop is unexpected", async () => {
    const { adb, reader, proc, onGesture, onError } = setup();
    reader.start(onGesture, onError);
    await Promise.resolve();
    proc.emit("exit", 0, null);
    expectCleaned(proc);
    expect(onError.mock.calls[0][0].message).toContain("code 0");
    adb.spawn.mockResolvedValue(new FakeAdbProcess());
    reader.start(onGesture, onError);
    await Promise.resolve();
    expect(adb.spawn).toHaveBeenCalledTimes(2);
    reader.stop();
  });

  test.each(["error", "exit"] as const)("discards a partial line after child %s", async (event) => {
    const { adb, reader, proc, onGesture, onError } = setup();
    reader.start(onGesture, onError);
    await Promise.resolve();
    data(proc, KEY_BACK.slice(0, 30));
    if (event === "error") {
      proc.emit("error", new Error("failed"));
    } else {
      proc.emit("exit", 1, null);
    }
    const next = new FakeAdbProcess();
    adb.spawn.mockResolvedValue(next);
    reader.start(onGesture, onError);
    await Promise.resolve();
    data(next, KEY_BACK);
    expect(onGesture).toHaveBeenCalledTimes(1);
    expect(onGesture).toHaveBeenCalledWith({
      type: "pressButton",
      button: "back",
      arrivedAt: 1000,
    });
    reader.stop();
  });

  test("an old spawn rejection does not clear a newer pending start", async () => {
    const { adb, reader, proc, onGesture, onError } = setup();
    const old = Promise.withResolvers<AdbProcess>();
    const next = Promise.withResolvers<AdbProcess>();
    adb.spawn.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    reader.start(onGesture, onError);
    reader.stop();
    reader.start(onGesture, onError);
    const error = new Error("old spawn failed");
    old.reject(error);
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    reader.start(onGesture, onError);
    expect(adb.spawn).toHaveBeenCalledTimes(2);
    next.resolve(proc);
    await Promise.resolve();
    data(proc, KEY_BACK);
    expect(onGesture).toHaveBeenCalledTimes(1);
    reader.stop();
  });

  test("an old pending spawn cannot replace a newer process after stop and restart", async () => {
    const { adb, reader, proc, onGesture, onError } = setup();
    const pending = Promise.withResolvers<AdbProcess>();
    adb.spawn.mockReturnValueOnce(pending.promise);
    reader.start(onGesture, onError);
    reader.stop();
    const next = new FakeAdbProcess();
    adb.spawn.mockResolvedValue(next);
    reader.start(onGesture, onError);
    await Promise.resolve();
    pending.resolve(proc);
    await Promise.resolve();
    expect(proc.killed).toBe(true);
    expect(next.killed).toBe(false);
    data(next, KEY_BACK);
    expect(onGesture).toHaveBeenCalledTimes(1);
    reader.stop();
    expect(next.killed).toBe(true);
  });
});
