import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DualTrackRecorder } from "../../../../src/features/record/android/DualTrackRecorder";
import { GetEventReader } from "../../../../src/features/record/android/GetEventReader";
import { TouchFrameReconstructor } from "../../../../src/features/record/android/TouchFrameReconstructor";
import { parseInputNodes } from "../../../../src/features/record/android/InputNodeDiscovery";
import type {
  A11ySource,
  DisplayChange,
  GestureEvent,
} from "../../../../src/features/record/android/types";
import type { ExecResult } from "../../../../src/models";
import { defaultAdbClientFactory } from "../../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbProcess } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../../src/utils/logger";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbProcess } from "../../../fakes/FakeAdbProcess";
import { captureFrames } from "../../../helpers/touchNodeCaptures";
import { FakeTimer } from "../../../fakes/FakeTimer";

const capture = (name: string): string =>
  readFileSync(join(__dirname, "../../../fixtures/android-uinput-pen", name), "utf8");
const capabilities = capture("pen-present-during-uinput-stroke-getevent-lp-emulator-5610.txt");
const hotplug = capture("pen-hotplug-add-remove-getevent-lt-all-nodes-emulator-5610.txt");
const stroke = capture("stroke-varying-pressure-getevent-lt-emulator-5610.txt");
const fingerTap =
  readFileSync(
    join(__dirname, "../../../fixtures/android-getevent/same-coordinate-taps-api36.txt"),
    "utf8",
  )
    .split("\n")
    .slice(0, 6)
    .join("\n") + "\n";
const penPath = "/dev/input/event12";
const penAdd = hotplug.slice(hotplug.indexOf(`add device 13: ${penPath}`), hotplug.indexOf("["));
const penRemove = hotplug.slice(hotplug.lastIndexOf("remove device"));
const initialCapabilities = capabilities.slice(capabilities.indexOf("add device 2:"));
const touchPath = parseInputNodes(initialCapabilities).touch!.path;

function result(stdout: string): ExecResult {
  return createExecResult(stdout, "");
}

class HotplugAdb extends FakeAdbExecutor {
  readonly spawn = mock<(args: string[]) => Promise<AdbProcess>>();
}

const noA11y: A11ySource = {
  ensureConnected: async () => true,
  getSupportedCommands: async () => [],
  onInteraction: () => () => {},
};

// Drain only fake command/spawn continuations; no clocks or real sleeps.
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

const active: DualTrackRecorder[] = [];
afterEach(async () => {
  for (const recorder of active.splice(0)) {
    await recorder.stop({ hostOnly: true });
  }
  mock.restore();
});

async function setup({ present = false, monitorFailure = false, penOnly = false } = {}) {
  const adb = new HotplugAdb();
  adb.setCommandResponse(
    "getevent -p",
    result(
      penOnly
        ? capabilities.slice(0, capabilities.indexOf("add device 2:"))
        : present
          ? capabilities
          : initialCapabilities,
    ),
  );
  adb.setCommandResponse(`getevent -lp ${penPath}`, result(capabilities));
  adb.setCommandResponse("wm size", result("Physical size: 1080x2340"));
  adb.setCommandResponse("dumpsys window displays", result("mRotation=ROTATION_0"));
  const touch = new FakeAdbProcess();
  const pen = new FakeAdbProcess();
  const monitor = new FakeAdbProcess();
  adb.spawn.mockImplementation(async (args) => {
    if (args.length === 3) {
      if (monitorFailure) {
        throw new Error("monitor unavailable");
      }
      return monitor;
    }
    return args.at(-1) === penPath ? pen : touch;
  });
  spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const gestures: GestureEvent[] = [];
  const originalStart = GetEventReader.prototype.start;
  spyOn(GetEventReader.prototype, "start").mockImplementation(function (
    this: GetEventReader,
    onGesture,
    onError,
  ) {
    originalStart.call(
      this,
      (event) => {
        gestures.push(event);
        onGesture(event);
      },
      onError,
    );
  });
  let displayChanged: ((event: DisplayChange) => void) | undefined;
  const timer = new FakeTimer();
  const recorder = new DualTrackRecorder(
    { deviceId: "fake-pen-hotplug", name: "fake", platform: "android" },
    undefined,
    noA11y,
    {
      timer,
      displaySource: {
        onDisplayChange(listener) {
          displayChanged = listener;
          return () => {};
        },
      },
    },
  );
  active.push(recorder);
  await recorder.start();
  await settle();
  const send = (proc: FakeAdbProcess, text: string): void => {
    proc.stdout.emit("data", Buffer.from(text));
  };
  const add = async (): Promise<void> => {
    send(monitor, penAdd);
    await settle();
  };
  const feedStroke = (): void => {
    let previous = captureFrames(stroke)[0].deviceMs;
    for (const frame of captureFrames(stroke)) {
      timer.advanceTime(frame.deviceMs - previous);
      previous = frame.deviceMs;
      send(pen, frame.text.replaceAll(`${penPath}: `, ""));
    }
    timer.advanceTime(50);
  };
  const penSpawns = (): number =>
    adb.spawn.mock.calls.filter(([args]) => args.at(-1) === penPath).length;
  return {
    adb,
    recorder,
    timer,
    touch,
    pen,
    monitor,
    send,
    add,
    penSpawns,
    gestures,
    warn,
    feedStroke,
    rotate: (rotation: number) => displayChanged?.({ displayId: 0, change: "changed", rotation }),
  };
}

describe("recording a hotplugged uinput pen", () => {
  test.each([false, true])(
    "primary and pen readers share kernel ordering (initially present: %s)",
    async (present) => {
      const ctx = await setup({ present });
      if (!present) {
        await ctx.add();
      }
      const frames = captureFrames(stroke);
      const earlier = frames[0].text.replaceAll(`${penPath}: `, "");
      const later = frames[1].text.replaceAll(`${penPath}: `, "");
      const seen: string[] = [];
      const original = TouchFrameReconstructor.prototype.feedLine;
      spyOn(TouchFrameReconstructor.prototype, "feedLine").mockImplementation(function (
        this: TouchFrameReconstructor,
        line,
        arrivedAt,
      ) {
        seen.push(line);
        return original.call(this, line, arrivedAt);
      });
      ctx.send(ctx.touch, later);
      ctx.timer.advanceTime(20);
      ctx.send(ctx.pen, earlier);
      expect(seen).toEqual([]);
      ctx.timer.advanceTime(30);
      expect(seen).toEqual([
        ...earlier.split("\n").filter(Boolean),
        ...later.split("\n").filter(Boolean),
      ]);
      expect(ctx.timer.getSleepHistory()).toEqual([]);
    },
  );

  test("a pen added after start uses captured axes and emits a stroke with point pressures", async () => {
    const ctx = await setup();
    expect(ctx.penSpawns()).toBe(0);
    await ctx.add();
    expect(ctx.penSpawns()).toBe(1);
    ctx.feedStroke();
    expect(ctx.gestures).toHaveLength(1);
    const gesture = ctx.gestures[0];
    expect(gesture.type).toBe("stroke");
    expect(gesture.path?.[0]).toMatchObject({ x: 300, y: 900, pressure: 0.2 });
    expect(gesture.path?.at(-1)?.pressure).toBeCloseTo(0.95, 3);
    expect(new Set(gesture.path?.map((point) => point.pressure)).size).toBeGreaterThan(2);
    expect((await ctx.recorder.stop({ hostOnly: true })).steps[0].tool).toBe("dragPath");
    expect(ctx.timer.getSleepHistory()).toEqual([]);
    expect(ctx.monitor.killed).toBe(true);
  });

  test("removing the pen stops its reader and detaches late events", async () => {
    const ctx = await setup();
    await ctx.add();
    expect(ctx.penSpawns()).toBe(1);
    ctx.send(ctx.monitor, penRemove);
    expect(ctx.pen.killed).toBe(true);
    ctx.feedStroke();
    ctx.pen.emit("error", new Error("late removed-node error"));
    expect(ctx.gestures).toEqual([]);
    expect(ctx.touch.killed).toBe(false);
  });

  test("a virtio multitouch add is probed but never starts a pen reader", async () => {
    const ctx = await setup();
    ctx.adb.setCommandResponse(`getevent -lp ${touchPath}`, result(capabilities));
    // Choose another captured virtio node so this is not just the primary-path exclusion.
    const otherPath = "/dev/input/event10";
    ctx.adb.setCommandResponse(`getevent -lp ${otherPath}`, result(capabilities));
    ctx.send(
      ctx.monitor,
      hotplug.slice(hotplug.indexOf("add device 2:"), hotplug.indexOf("add device 3:")),
    );
    await settle();
    expect(
      ctx.adb.getCommandCalls().some((call) => call.command.includes(`getevent -lp ${otherPath}`)),
    ).toBe(true);
    expect(ctx.adb.spawn.mock.calls.map(([args]) => args)).toEqual([
      ["shell", "getevent", "-lt", touchPath],
      ["shell", "getevent", "-lt"],
    ]);
  });

  test("monitor spawn failure logs and leaves finger recording running", async () => {
    const ctx = await setup({ monitorFailure: true });
    expect(
      ctx.warn.mock.calls.some(([message]) => String(message).includes("monitor unavailable")),
    ).toBe(true);
    ctx.send(ctx.touch, fingerTap);
    ctx.timer.advanceTime(50);
    expect(ctx.gestures.map((event) => event.type)).toEqual(["tap"]);
    expect(ctx.recorder.touchTrackFailure).toBeUndefined();
    expect(ctx.touch.killed).toBe(false);
    expect((await ctx.recorder.stop({ hostOnly: true })).steps.map((step) => step.tool)).toEqual([
      "tapAt",
    ]);
  });

  test("an initially present pen is not duplicated by the monitor and is removed cleanly", async () => {
    const ctx = await setup({ present: true });
    await ctx.add();
    expect(ctx.penSpawns()).toBe(1);
    ctx.feedStroke();
    expect(ctx.gestures[0]?.type).toBe("stroke");
    ctx.send(ctx.monitor, penRemove);
    expect(ctx.pen.killed).toBe(true);
  });

  test("removal during a capability probe prevents a stale reader", async () => {
    const ctx = await setup();
    const pending = Promise.withResolvers<ExecResult>();
    const execute = spyOn(ctx.adb, "execute").mockReturnValue(pending.promise);
    ctx.send(ctx.monitor, penAdd);
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    ctx.send(ctx.monitor, penRemove);
    pending.resolve(result(capabilities));
    await settle();
    expect(ctx.penSpawns()).toBe(0);
  });

  test("removal while the pen spawn is pending kills the late child", async () => {
    const ctx = await setup();
    const pending = Promise.withResolvers<AdbProcess>();
    ctx.adb.spawn.mockReturnValueOnce(pending.promise);
    await ctx.add();
    expect(ctx.penSpawns()).toBe(1);
    ctx.send(ctx.monitor, penRemove);
    pending.resolve(ctx.pen);
    await settle();
    expect(ctx.pen.killed).toBe(true);
    ctx.feedStroke();
    expect(ctx.gestures).toEqual([]);
  });

  test("a new pen starts with current display geometry and follows later changes", async () => {
    const ctx = await setup();
    ctx.rotate(1);
    await settle();
    ctx.timer.advanceTime(1000);
    await ctx.add();
    ctx.feedStroke();
    expect(ctx.gestures[0]?.path?.[0]).toMatchObject({ x: 900, y: 779 });
    ctx.rotate(2);
    await settle();
    ctx.timer.advanceTime(1000);
    ctx.feedStroke();
    expect(ctx.gestures[1]?.path?.[0]).toMatchObject({ x: 779, y: 1439 });
  });

  test("chunked notifications are buffered and monitor event lines are ignored", async () => {
    const ctx = await setup();
    ctx.send(ctx.monitor, penAdd.slice(0, 17));
    await settle();
    expect(ctx.penSpawns()).toBe(0);
    ctx.send(ctx.monitor, penAdd.slice(17));
    await settle();
    expect(ctx.penSpawns()).toBe(1);
    ctx.send(
      ctx.monitor,
      stroke
        .split("\n")
        .filter((line) => line.startsWith("["))
        .join("\n") + "\n",
    );
    await settle();
    expect(ctx.penSpawns()).toBe(1);
    expect(ctx.gestures).toEqual([]);
    ctx.feedStroke();
    expect(ctx.gestures[0]?.type).toBe("stroke");
  });

  test.each(["error", "exit"] as const)(
    "monitor %s is logged without failing the finger track",
    async (event) => {
      const ctx = await setup();
      ctx.monitor.stderr.emit("data", Buffer.from("monitor diagnostics"));
      if (event === "error") {
        ctx.monitor.emit("error", new Error("stream lost"));
      } else {
        ctx.monitor.emit("exit", 0, null);
      }
      expect(ctx.monitor.killed).toBe(true);
      expect(
        ctx.warn.mock.calls.some(([message]) => String(message).includes("monitor diagnostics")),
      ).toBe(true);
      ctx.send(ctx.touch, "[ 1.0] EV_KEY KEY_BACK DOWN\n");
      ctx.timer.advanceTime(50);
      expect(ctx.gestures[0]?.type).toBe("pressButton");
      expect(ctx.recorder.touchTrackFailure).toBeUndefined();
      ctx.send(ctx.monitor, penAdd);
      await settle();
      expect(ctx.penSpawns()).toBe(0);
    },
  );

  test("a rejected capability probe logs and allows a later add at the same path", async () => {
    const ctx = await setup();
    const execute = spyOn(ctx.adb, "execute").mockRejectedValueOnce(new Error("node vanished"));
    await ctx.add();
    expect(ctx.penSpawns()).toBe(0);
    expect(ctx.warn.mock.calls.some(([message]) => String(message).includes("node vanished"))).toBe(
      true,
    );
    execute.mockRestore();
    await ctx.add();
    expect(ctx.penSpawns()).toBe(1);
  });

  test("stop cancels probes and ignores late monitor data", async () => {
    const ctx = await setup();
    const pending = Promise.withResolvers<ExecResult>();
    const execute = spyOn(ctx.adb, "execute").mockReturnValue(pending.promise);
    ctx.send(ctx.monitor, penAdd);
    await settle();
    await ctx.recorder.stop({ hostOnly: true });
    expect(execute.mock.calls[0][1]?.signal?.aborted).toBe(true);
    pending.resolve(result(capabilities));
    ctx.send(ctx.monitor, penAdd);
    await settle();
    expect(ctx.penSpawns()).toBe(0);
    expect(ctx.timer.getSleepHistory()).toEqual([]);
  });

  test("a pen-only primary is removed and can return at the same path", async () => {
    const ctx = await setup({ penOnly: true });
    ctx.send(ctx.monitor, penRemove);
    expect(ctx.pen.killed).toBe(true);
    ctx.feedStroke();
    expect(ctx.gestures).toEqual([]);
    const next = new FakeAdbProcess();
    ctx.adb.spawn.mockResolvedValueOnce(next);
    await ctx.add();
    expect(ctx.penSpawns()).toBe(2);
    for (const frame of captureFrames(stroke)) {
      ctx.timer.advanceTime(16);
      ctx.send(next, frame.text.replaceAll(`${penPath}: `, ""));
    }
    ctx.timer.advanceTime(50);
    expect(ctx.gestures[0]?.type).toBe("stroke");
  });
});
