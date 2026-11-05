import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GetEventReader } from "../../../../src/features/record/android/GetEventReader";
import { KernelTimeLineMerge } from "../../../../src/features/record/android/KernelTimeLineMerge";
import { buildScaler } from "../../../../src/features/record/android/AxisRanges";
import type { GestureEvent } from "../../../../src/features/record/android/types";
import type { AdbProcess } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbProcess } from "../../../fakes/FakeAdbProcess";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { buildPenSampleStep } from "../../../../src/features/record/android/penSampleStep";
import { TouchFrameReconstructor } from "../../../../src/features/record/android/TouchFrameReconstructor";
import { captureFrames } from "../../../helpers/touchNodeCaptures";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function setup(
  kernelReorderWindowMs = 0,
  shared?: { lineMerge: KernelTimeLineMerge; timer: FakeTimer; nodePath?: string },
) {
  const adb = new ReaderAdb();
  const proc = new FakeAdbProcess();
  adb.spawn.mockResolvedValue(proc);
  const timer = shared?.timer ?? new FakeTimer();
  if (!shared) {
    timer.advanceTime(1000);
  }
  const reader = new GetEventReader({
    adb,
    timer,
    kernelReorderWindowMs,
    lineMerge: shared?.lineMerge,
    density: 1,
    touchNode: {
      path: shared?.nodePath ?? "/dev/input/event2",
      name: "touch",
      kind: "touch",
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
  test.each([false, true])(
    "merges two fake process streams before their separate reconstructors (separate readers: %s)",
    async (separateReaders) => {
      const adb = new ReaderAdb();
      const touch = new FakeAdbProcess();
      const pen = new FakeAdbProcess();
      adb.spawn.mockResolvedValueOnce(touch).mockResolvedValueOnce(pen);
      const timer = new FakeTimer();
      const node = {
        path: "/dev/input/event1",
        name: "touch",
        kind: "touch" as const,
        axisXMin: 0,
        axisXMax: 1000,
        axisYMin: 0,
        axisYMax: 1000,
      };
      const scaler = { toScreenPoint: (x: number, y: number) => ({ x, y }) };
      const penNode = { ...node, path: "/dev/input/event12", kind: "pen" as const };
      const lineMerge = separateReaders ? new KernelTimeLineMerge({ timer }) : undefined;
      const reader = new GetEventReader({
        adb,
        timer,
        density: 1,
        touchNode: node,
        scaler,
        lineMerge,
        penNodes: separateReaders ? [] : [{ node: penNode, scaler }],
      });
      const penReader = separateReaders
        ? new GetEventReader({ adb, timer, density: 1, touchNode: penNode, scaler, lineMerge })
        : undefined;
      const frames = captureFrames(
        readFileSync(
          join(
            __dirname,
            "../../../fixtures/android-uinput-pen/stroke-varying-pressure-getevent-lt-emulator-5610.txt",
          ),
          "utf8",
        ),
      );
      // Split an unmodified capture between two processes to isolate the merge before parsing.
      const nodeText = (text: string): string => text.replaceAll("/dev/input/event12: ", "");
      const earlier = nodeText(frames[0].text);
      const later = nodeText(frames[1].text);
      const seen: { owner: TouchFrameReconstructor; line: string; arrivedAt: number }[] = [];
      const original = TouchFrameReconstructor.prototype.feedLine;
      spyOn(TouchFrameReconstructor.prototype, "feedLine").mockImplementation(function (
        this: TouchFrameReconstructor,
        line: string,
        arrivedAt: number,
      ) {
        seen.push({ owner: this, line, arrivedAt });
        return original.call(this, line, arrivedAt);
      });
      reader.start(() => {});
      penReader?.start(() => {});
      await Promise.resolve();
      data(touch, later);
      timer.advanceTime(20);
      data(pen, earlier);
      expect(seen).toEqual([]);
      timer.advanceTime(30);
      const earlierLines = earlier.split("\n").filter(Boolean);
      expect(seen.map(({ line }) => line)).toEqual([
        ...earlierLines,
        ...later.split("\n").filter(Boolean),
      ]);
      expect(seen.map(({ arrivedAt }) => arrivedAt)).toEqual([
        ...earlierLines.map(() => 20),
        ...later
          .split("\n")
          .filter(Boolean)
          .map(() => 0),
      ]);
      expect(seen[0].owner).not.toBe(seen.at(-1)?.owner);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.getSleepHistory()).toEqual([]);
      reader.stop();
      penReader?.stop();
    },
  );

  test.each(["stop", "error", "exit"] as const)(
    "a shared reader's %s drops its pending lines without clearing another reader",
    async (reason) => {
      const clock = new FakeTimer();
      const lineMerge = new KernelTimeLineMerge({ timer: clock });
      const primary = setup(50, { lineMerge, timer: clock });
      const pen = setup(50, { lineMerge, timer: clock, nodePath: "/dev/input/event12" });
      const penReader = pen.reader;
      primary.reader.start(primary.onGesture, primary.onError);
      penReader.start(pen.onGesture, pen.onError);
      await Promise.resolve();
      data(primary.proc, KEY_BACK);
      data(pen.proc, KEY_BACK);
      if (reason === "stop") {
        penReader.stop();
      } else if (reason === "error") {
        pen.proc.emit("error", new Error("read failed"));
      } else {
        pen.proc.emit("exit", 1, null);
      }
      const next = new FakeAdbProcess();
      pen.adb.spawn.mockResolvedValue(next);
      penReader.start(pen.onGesture, pen.onError);
      await Promise.resolve();
      clock.advanceTime(50);
      expect(primary.onGesture).toHaveBeenCalledTimes(1);
      expect(pen.onGesture).not.toHaveBeenCalled();
      data(pen.proc, KEY_BACK);
      expect(pen.onGesture).not.toHaveBeenCalled();
      data(next, KEY_BACK);
      clock.advanceTime(50);
      expect(pen.onGesture).toHaveBeenCalledTimes(1);
      expect(pen.onError).toHaveBeenCalledTimes(reason === "stop" ? 0 : 1);
      primary.reader.stop();
      penReader.stop();
      expect(clock.getPendingTimeoutCount()).toBe(0);
      expect(clock.getSleepHistory()).toEqual([]);
    },
  );

  test.each(["stop", "error", "exit"] as const)(
    "%s drops pending lines and isolates a restarted generation",
    async (reason) => {
      const { adb, proc, timer, reader, onGesture, onError } = setup(50);
      reader.start(onGesture, onError);
      await Promise.resolve();
      data(proc, KEY_BACK);
      expect(onGesture).not.toHaveBeenCalled();
      if (reason === "stop") {
        reader.stop();
      } else if (reason === "error") {
        proc.emit("error", new Error("read failed"));
      } else {
        proc.emit("exit", 1, null);
      }
      timer.advanceTime(100);
      expect(onGesture).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(reason === "stop" ? 0 : 1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      const next = new FakeAdbProcess();
      adb.spawn.mockResolvedValue(next);
      reader.start(onGesture, onError);
      await Promise.resolve();
      data(next, KEY_BACK);
      expect(onGesture).not.toHaveBeenCalled();
      timer.advanceTime(50);
      expect(onGesture).toHaveBeenCalledTimes(1);
      expect(onGesture).toHaveBeenCalledWith({
        type: "pressButton",
        button: "back",
        arrivedAt: 1100,
      });
      reader.stop();
      expect(timer.getSleepHistory()).toEqual([]);
    },
  );

  test.each(["stroke", "hover"] as const)(
    "preserves %s kernel timing through scaling when stdout batches frames",
    async (type) => {
      const adb = new ReaderAdb();
      const proc = new FakeAdbProcess();
      adb.spawn.mockResolvedValue(proc);
      const reader = new GetEventReader({
        adb,
        timer: new FakeTimer(),
        kernelReorderWindowMs: 0,
        density: 1,
        touchNode: {
          path: "/dev/input/event5",
          name: "pen",
          kind: "pen",
          axisXMin: 0,
          axisXMax: 1000,
          axisYMin: 0,
          axisYMax: 1000,
          pressureMin: 0,
          pressureMax: 1000,
          distanceRange: { min: 0, max: 1000 },
        },
        scaler: { toScreenPoint: (x, y) => ({ x: x * 2, y: y * 2 }) },
      });
      const events: GestureEvent[] = [];
      reader.start((event) => events.push(event));
      await Promise.resolve();
      const lines = [
        "[ 78826.389007] EV_KEY BTN_TOOL_PEN DOWN",
        "[ 78826.389007] EV_ABS ABS_X 00000010",
        "[ 78826.389007] EV_ABS ABS_Y 00000020",
        "[ 78826.389007] EV_ABS ABS_PRESSURE 000000c8",
        "[ 78826.389007] EV_ABS ABS_DISTANCE 00000064",
        ...(type === "stroke" ? ["[ 78826.389007] EV_KEY BTN_TOUCH DOWN"] : []),
        "[ 78826.389007] EV_SYN SYN_REPORT 00000000",
        "[ 78826.489007] EV_ABS ABS_X 00000030",
        "[ 78826.489007] EV_ABS ABS_PRESSURE 00000320",
        "[ 78826.489007] EV_SYN SYN_REPORT 00000000",
        ...(type === "stroke" ? ["[ 78826.499007] EV_KEY BTN_TOUCH UP"] : []),
        "[ 78826.499007] EV_KEY BTN_TOOL_PEN UP",
        "[ 78826.499007] EV_SYN SYN_REPORT 00000000",
      ];
      data(proc, lines.join("\n") + "\n");
      reader.stop();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(type);
      const samples = type === "stroke" ? events[0].path : events[0].hover;
      expect(samples?.map((sample) => sample.arrivedAt)).toEqual([0, 0]);
      expect(samples?.map((sample) => sample.kernelAtMs)).toEqual([78826389.007, 78826489.007]);
      expect(buildPenSampleStep(events[0])?.params.points).toEqual([
        { x: 32, y: 64, ...(type === "stroke" ? { pressure: 0.2 } : { distance: 0.1 }) },
        {
          x: 96,
          y: 64,
          ...(type === "stroke" ? { pressure: 0.8 } : { distance: 0.1 }),
          durationMs: 100,
        },
      ]);
    },
  );

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
