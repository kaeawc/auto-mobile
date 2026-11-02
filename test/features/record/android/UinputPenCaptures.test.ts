import { TouchFrameReconstructor } from "../../../../src/features/record/android/TouchFrameReconstructor";
import { GestureClassifier } from "../../../../src/features/record/android/GestureClassifier";
import { GESTURE_THRESHOLDS } from "../../../../src/features/record/android/types";
import { GetEventReader } from "../../../../src/features/record/android/GetEventReader";
import { DualTrackRecorder } from "../../../../src/features/record/android/DualTrackRecorder";
import { buildScaler } from "../../../../src/features/record/android/AxisRanges";
import type { GestureEvent, GestureEmitter } from "../../../../src/features/record/android/types";
import type { BootedDevice } from "../../../../src/models";
import type { AdbProcess } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbProcess } from "../../../fakes/FakeAdbProcess";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { dragPathSchema } from "../../../../src/server/dragPathTool";
import { hoverAtSchema } from "../../../../src/server/hoverAtTool";
import { HoverAt } from "../../../../src/features/action/HoverAt";
import { dispatchRichStylus } from "../../../../src/features/action/pointer/richStylus";
import { defaultPointerRoutes } from "../../../../src/features/action/pointer/pointerRoutes";
import type {
  PointerEnvironment,
  PointerRequest,
} from "../../../../src/features/action/pointer/PointerInjector";
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInputNodes } from "../../../../src/features/record/android/InputNodeDiscovery";
import { strokeRequest } from "../../../../src/features/action/pointer/richStylus";
import { uinputPenScript } from "../../../../src/features/action/pointer/uinputPenScript";
import type { StylusButton } from "../../../../src/models/PointerOption";
import { captureFrames } from "../../../helpers/touchNodeCaptures";
import { buildPenSampleStep } from "../../../../src/features/record/android/penSampleStep";
import { exportLossWarning } from "../../../../src/features/record/android/penExportWarnings";

const DIRECTORY = join(__dirname, "../../../fixtures/android-uinput-pen");
const PEN_PATH = "/dev/input/event12";
const captures = new Map<string, string>();

function fixture(name: string): string {
  let text = captures.get(name);
  if (text === undefined) {
    text = readFileSync(join(DIRECTORY, name), "utf8");
    captures.set(name, text);
  }
  return text;
}

function readCapture(stroke: string, mode: "lt" | "lp-during"): string {
  return fixture(`${stroke}-getevent-${mode}-emulator-5610.txt`);
}

function penEvents(stroke: string): string[] {
  const capture = readCapture(stroke, "lt");
  expect(capture).toContain(`add device 13: ${PEN_PATH}\n  name:     "automobile-pen"`);
  // Keep exact raw codes/values: the reconstructor consumes node-less streams and
  // does not expose raw key transitions or ABS_DISTANCE samples to these assertions.
  return captureFrames(capture).flatMap((frame) =>
    frame.text.split("\n").flatMap((line) => {
      const event = line.split(`${PEN_PATH}: `)[1];
      return event === undefined ? [] : [event.trim().split(/\s+/).join(" ")];
    }),
  );
}

describe("real uinput pen captures", () => {
  test.each([
    "tap-stylus-pressure-0.2",
    "tap-eraser-pressure-0.5",
    "swipe-stylus-pressure-0.6",
    "hover-stylus",
  ])("%s capabilities identify the direct pen and its ranges", (stroke) => {
    const capture = readCapture(stroke, "lp-during");
    const { pen } = parseInputNodes(capture);
    expect(pen).toHaveLength(1);
    expect(pen[0]).toMatchObject({
      path: PEN_PATH,
      name: "automobile-pen",
      kind: "pen",
      pressureMin: 0,
      pressureMax: 4095,
    });
    // Discovery's typed model does not retain distance or input properties.
    const section = capture
      .split("add device ")
      .find((block) => block.includes('"automobile-pen"'));
    expect(section).toContain("ABS_DISTANCE          : value 0, min 0, max 255,");
    expect(section).toContain("\n    INPUT_PROP_DIRECT\n");
  });

  test("the 0.5 stylus tap reports 00000800 and touch DOWN then UP", () => {
    const events = penEvents("tap-stylus-pressure-0.5");
    expect(events).toContain("EV_ABS ABS_PRESSURE 00000800");
    expect(events.filter((event) => event.startsWith("EV_KEY BTN_TOUCH "))).toEqual([
      "EV_KEY BTN_TOUCH DOWN",
      "EV_KEY BTN_TOUCH UP",
    ]);
  });

  test("the 0.2 stylus tap reports 00000333", () => {
    expect(penEvents("tap-stylus-pressure-0.2")).toContain("EV_ABS ABS_PRESSURE 00000333");
  });

  test("the eraser uses BTN_TOOL_RUBBER without a pen tool event", () => {
    const events = penEvents("tap-eraser-pressure-0.5");
    expect(events).toContain("EV_KEY BTN_TOOL_RUBBER DOWN");
    expect(events.some((event) => event.startsWith("EV_KEY BTN_TOOL_PEN "))).toBe(false);
    // getevent labels BTN_TOOL_PEN's Linux code 0x140 as BTN_DIGI on this emulator.
    expect(events.some((event) => event.startsWith("EV_KEY BTN_DIGI "))).toBe(false);
  });

  test("the swipe changes ABS_Y starting at 00000578", () => {
    const values = penEvents("swipe-stylus-pressure-0.6")
      .filter((event) => event.startsWith("EV_ABS ABS_Y "))
      .map((event) => event.split(" ")[2]);
    expect(values[0]).toBe("00000578");
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  test("hover reports distance 00000080 without touching down", () => {
    const events = penEvents("hover-stylus");
    expect(events).toContain("EV_ABS ABS_DISTANCE 00000080");
    expect(events).not.toContain("EV_KEY BTN_TOUCH DOWN");
  });
});

const TILTED_STROKES = [
  {
    stroke: "tap-stylus-tilt-45deg-orientation-30deg",
    tilt: Math.PI / 4,
    orientation: Math.PI / 6,
    buttons: [],
    axes: [-22, 40],
  },
  {
    stroke: "tap-stylus-tilt-30deg-orientation-minus90deg",
    tilt: Math.PI / 6,
    orientation: -Math.PI / 2,
    buttons: [],
    axes: [30, 0],
  },
  {
    stroke: "tap-stylus-tilt-45deg-orientation-0-barrel-both",
    tilt: Math.PI / 4,
    orientation: 0,
    buttons: ["primary", "secondary"],
    axes: [0, 45],
  },
  { stroke: "tap-stylus-barrel-primary", buttons: ["primary"], axes: [0, 0] },
  { stroke: "tap-stylus-barrel-secondary", buttons: ["secondary"], axes: [0, 0] },
  {
    stroke: "swipe-stylus-tilt-45deg-orientation-30deg-barrel-primary",
    tilt: Math.PI / 4,
    orientation: Math.PI / 6,
    buttons: ["primary"],
    axes: [-22, 40],
  },
] satisfies Array<{
  stroke: string;
  tilt?: number;
  orientation?: number;
  buttons: StylusButton[];
  axes: number[];
}>;

/** getevent's 32-bit hexadecimal ABS values are signed two's complement. */
function signedValue(value: string): number {
  return Number.parseInt(value, 16) | 0;
}

const EXTENDED_CODES = new Map([
  ["ABS_TILT_X", 26],
  ["ABS_TILT_Y", 27],
  ["BTN_STYLUS", 331],
  ["BTN_STYLUS2", 332],
]);

describe("real uinput tilt and barrel button captures", () => {
  test.each(TILTED_STROKES)(
    "$stroke has captured axes and ordered buttons",
    ({ stroke, axes, buttons }) => {
      const events = penEvents(stroke);
      for (const [index, code] of ["ABS_TILT_X", "ABS_TILT_Y"].entries()) {
        const values = events
          .filter((event) => event.startsWith(`EV_ABS ${code} `))
          .map((event) => signedValue(event.split(" ")[2]));
        // A fresh virtual pen starts at zero; getevent omits unchanged values.
        expect(values).toEqual(axes[index] === 0 ? [] : [axes[index]]);
      }
      const frames = captureFrames(readCapture(stroke, "lt"));
      const down = frames.find((frame) => /BTN_TOUCH\s+DOWN/.test(frame.text));
      expect(down).toBeDefined();
      const pressure = stroke.startsWith("swipe-") ? "00000999" : "00000800";
      expect(down!.text).toMatch(new RegExp(`ABS_PRESSURE\\s+${pressure}`));
      for (const code of ["ABS_TILT_X", "ABS_TILT_Y"]) {
        const event = events.find((entry) => entry.startsWith(`EV_ABS ${code} `));
        if (event) {
          expect(down!.text).toMatch(new RegExp(`${code}\\s+${event.split(" ")[2]}`));
        }
      }
      for (const [button, code] of [
        ["primary", "BTN_STYLUS"],
        ["secondary", "BTN_STYLUS2"],
      ] as const) {
        const transitions = events.filter((event) => event.startsWith(`EV_KEY ${code} `));
        if (buttons.some((entry) => entry === button)) {
          expect(transitions).toEqual([`EV_KEY ${code} DOWN`, `EV_KEY ${code} UP`]);
          expect(down!.text).toMatch(new RegExp(`${code}\\s+DOWN`));
          expect(events.indexOf(`EV_KEY ${code} UP`)).toBeLessThan(
            events.indexOf("EV_KEY BTN_TOUCH UP"),
          );
        } else {
          expect(transitions).toEqual([]);
        }
      }
      const capabilities = readCapture(stroke, "lp-during");
      // These two capability snapshots missed the short-lived virtual pen.
      if (
        stroke === "tap-stylus-tilt-45deg-orientation-0-barrel-both" ||
        stroke === "tap-stylus-barrel-secondary"
      ) {
        expect(parseInputNodes(capabilities).pen).toEqual([]);
        expect(capabilities).not.toContain('"automobile-pen"');
        return;
      }
      expect(parseInputNodes(capabilities).pen[0]?.path).toBe(PEN_PATH);
      expect(capabilities).toMatch(/ABS_TILT_X\s+: value -?\d+, min -90, max 90/);
      expect(capabilities).toMatch(/ABS_TILT_Y\s+: value -?\d+, min -90, max 90/);
    },
  );

  test.each(TILTED_STROKES)("$stroke script matches captured extended event changes", (sample) => {
    const point = { x: 540, y: 1170 };
    const request = strokeRequest(
      {
        toolType: "stylus",
        pressure: 0.5,
        tilt: sample.tilt,
        orientation: sample.orientation,
        buttons: sample.buttons,
      },
      [point, { ...point, durationMs: sample.stroke.startsWith("swipe-") ? 800 : 40 }],
    );
    const script = uinputPenScript(request, { width: 1080, height: 2340, rotation: 0 });
    const changes: number[][] = [];
    const state = new Map<number, number>();
    for (const line of script.trim().split("\n")) {
      const command = JSON.parse(line) as { command: string; events?: number[] };
      if (command.command !== "inject") {
        continue;
      }
      const events = command.events!;
      for (let index = 0; index < events.length; index += 3) {
        const [type, code, value] = events.slice(index, index + 3);
        if ((type !== 1 && type !== 3) || ![...EXTENDED_CODES.values()].includes(code)) {
          continue;
        }
        if (value !== (state.get(code) ?? 0)) {
          changes.push([type, code, value]);
        }
        state.set(code, value);
      }
    }
    const captured = penEvents(sample.stroke).flatMap((event) => {
      const [type, name, value] = event.split(" ");
      const code = EXTENDED_CODES.get(name);
      return code === undefined
        ? []
        : [
            [
              type === "EV_ABS" ? 3 : 1,
              code,
              value === "DOWN" ? 1 : value === "UP" ? 0 : signedValue(value),
            ],
          ];
    });
    expect(changes).toEqual(captured);
  });

  test("Android derives tilt and orientation motion ranges from degree-valued tilt axes", () => {
    const capture = readFileSync(
      join(DIRECTORY, "stylus-tilt-swipe-dumpsys-input-device-emulator-5610.txt"),
      "utf8",
    );
    for (const line of [
      "TILT: source=TOUCHSCREEN | STYLUS, min=0.000, max=1.571",
      "ORIENTATION: source=TOUCHSCREEN | STYLUS, min=-3.142, max=3.142",
      "TiltX: min=-90, max=90, flat=0, fuzz=0, resolution=0",
      "TiltY: min=-90, max=90, flat=0, fuzz=0, resolution=0",
      "HaveTilt: true",
      "TiltXScale: 0.017",
      "TiltYScale: 0.017",
    ]) {
      expect(capture).toContain(line);
    }
  });
});

/** All-node captures include a path token; `getevent -lt <path>` omits that token. */
function asNodeSpecificGeteventOutput(capture: string): string {
  return capture.replaceAll(`${PEN_PATH}: `, "");
}

// Exercise the production reader/reconstructor/classifier/export path with a fake process.
// Host arrivals follow captured frame spacing, a single batch, or an artificial per-line delay.
async function recordedCapture(
  stroke: string,
  capture = readCapture(stroke, "lt"),
  batched = false,
  lineArrivalDelayMs = 0,
) {
  const node = parseInputNodes(readCapture(stroke, "lp-during")).pen[0];
  expect(node).toBeDefined();
  const timer = new FakeTimer();
  const adb = new CaptureAdb();
  const process = new FakeAdbProcess();
  adb.spawn.mockResolvedValue(process);
  const reader = new GetEventReader({
    adb,
    timer,
    touchNode: node,
    scaler: buildScaler({
      xMin: node.axisXMin,
      xMax: node.axisXMax,
      yMin: node.axisYMin,
      yMax: node.axisYMax,
      displayWidth: 1080,
      displayHeight: 2340,
      rotation: 0,
    }),
    density: 1,
  });
  const gestures: GestureEvent[] = [];
  const emitter: GestureEmitter = {
    start: (onGesture) =>
      reader.start((event) => {
        gestures.push(event);
        onGesture(event);
      }),
    stop: () => reader.stop(),
  };
  const recorder = new DualTrackRecorder(
    DEVICE,
    emitter,
    {
      ensureConnected: async () => true,
      getSupportedCommands: async () => [],
      onInteraction: () => () => {},
    },
    { timer },
  );
  await recorder.start();
  await Promise.resolve();
  expect(adb.spawn).toHaveBeenCalledWith(["shell", "getevent", "-lt", PEN_PATH]);
  const frames = captureFrames(capture);
  if (lineArrivalDelayMs > 0) {
    for (const frame of frames) {
      for (const line of asNodeSpecificGeteventOutput(frame.text).trimEnd().split("\n")) {
        timer.advanceTime(lineArrivalDelayMs);
        process.stdout.emit("data", Buffer.from(`${line}\n`));
      }
    }
  } else if (batched) {
    process.stdout.emit(
      "data",
      Buffer.from(asNodeSpecificGeteventOutput(frames.map((frame) => frame.text).join(""))),
    );
  } else {
    for (const frame of frames) {
      timer.advanceTime(Math.max(0, frame.deviceMs - timer.now()));
      process.stdout.emit("data", Buffer.from(asNodeSpecificGeteventOutput(frame.text)));
    }
  }
  return { gestures, result: await recorder.stop({ hostOnly: true }) };
}

class CaptureAdb extends FakeAdbExecutor {
  readonly spawn = mock<(args: string[]) => Promise<AdbProcess>>();
}
const DEVICE: BootedDevice = { deviceId: "fixture", name: "Fixture", platform: "android" };

describe("captured pen recording and strict replay", () => {
  test("node-specific 5 s capture uses kernel time with 500 ms between arriving lines", async () => {
    const { gestures, result } = await recordedCapture(
      "stroke-varying-pressure",
      fixture("stroke-5s-getevent-lt-api37.txt"),
      false,
      500,
    );
    expect(result.steps.map((step) => step.tool)).toEqual(["dragPath"]);
    const params = dragPathSchema.parse(result.steps[0].params);
    const totalMs = params.points.slice(1).reduce((total, point) => total + point.durationMs!, 0);
    expect(Math.abs(totalMs - 5000)).toBeLessThanOrEqual(2);
    expect(totalMs).toBe(5002);
    expect(gestures).toHaveLength(1);
    const path = gestures[0].path!;
    expect(path).toHaveLength(73);
    expect(path.every((point) => point.kernelAtMs !== undefined)).toBe(true);
    expect(path[0].kernelAtMs).toBeCloseTo(206402.369, 3);
    expect(path.at(-1)!.kernelAtMs).toBeCloseTo(211404.056, 3);
    expect(path.at(-1)!.arrivedAt - path[0].arrivedAt).toBeGreaterThan(600000);
    expect(result.exportWarnings ?? []).toEqual([]);
  });

  test.each([false, true])(
    "real 5 s stroke preserves kernel duration (batched arrival: %s)",
    async (batched) => {
      const capture = fixture("stroke-5s-getevent-lt-api37.txt");
      const { gestures, result } = await recordedCapture(
        "stroke-varying-pressure",
        capture,
        batched,
      );
      expect(gestures).toHaveLength(1);
      expect(gestures[0].type).toBe("stroke");
      const params = dragPathSchema.parse(result.steps[0]?.params);
      const totalMs = params.points.slice(1).reduce((total, point) => total + point.durationMs!, 0);
      // 206.402369 -> 211.404056: round the retained kernel span once, not each gap.
      expect(totalMs).toBe(5002);
      expect(totalMs).toBeGreaterThanOrEqual(4990);
      expect(totalMs).toBeLessThanOrEqual(5010);
      const path = gestures[0].path!;
      expect(path.every((point) => point.kernelAtMs !== undefined)).toBe(true);
      expect(path).toHaveLength(73);
      expect(params.points).toHaveLength(path.length);
      if (batched) {
        expect(new Set(path.map((point) => point.arrivedAt)).size).toBe(1);
      }
      expect(result.exportWarnings ?? []).toEqual([]);
    },
  );

  test.each(["21s", "22s", "22-5s"])("real %s stroke exceeds replay limit", async (duration) => {
    const { result } = await recordedCapture(
      "stroke-varying-pressure",
      fixture(`stroke-${duration}-getevent-lt-api37.txt`),
    );
    expect(result.steps.filter((step) => step.tool === "dragPath")).toHaveLength(0);
    expect(result.steps).toHaveLength(0);
    expect(result.exportWarnings).toEqual([
      expect.stringContaining("exceeds the 20 second replay limit"),
    ]);
  });

  test("varying pressure becomes one stroke and a stylus dragPath with sampled pressure", async () => {
    const { gestures, result } = await recordedCapture("stroke-varying-pressure");
    expect(gestures).toHaveLength(1);
    expect(gestures[0].type).toBe("stroke");
    const path = gestures[0].path!;
    expect(path.length).toBeGreaterThanOrEqual(4);
    expect(path[0].pressure).toBeCloseTo(0.2, 3);
    expect(path.at(-1)!.pressure).toBeCloseTo(0.95, 3);
    expect(path.every((point, i) => i === 0 || point.pressure >= path[i - 1].pressure)).toBe(true);
    expect(result.steps.map((step) => step.tool)).toEqual(["dragPath"]);
    const params = dragPathSchema.parse(result.steps[0].params);
    expect(params.pointer?.toolType).toBe("stylus");
    expect(params.points.map((point) => point.pressure)).toEqual(
      path.map((point) => point.pressure),
    );
    expect(result.exportWarnings ?? []).toEqual([]);
  });

  test("positioned hover exports hoverAt with distance and no loss warning", async () => {
    const { result } = await recordedCapture("hover-stylus");
    expect(result.steps.map((step) => step.tool)).toEqual(["hoverAt"]);
    expect(result.steps[0].params.toolType).toBe("stylus");
    const params = hoverAtSchema.parse(result.steps[0].params);
    expect(params.toolType).toBe("stylus");
    expect(params.points.length).toBeGreaterThan(1);
    expect(params.points.every((point) => Math.abs(point.distance! - 128 / 255) < 0.0001)).toBe(
      true,
    );
    expect(result.exportWarnings ?? []).toEqual([]);
  });

  test.each([
    ["swipe-stylus-pressure-0.6", "swipeAt"],
    ["tap-stylus-pressure-0.2", "tapAt"],
  ])("%s keeps its existing constant-pressure export", async (capture, tool) => {
    const { result } = await recordedCapture(capture);
    expect(result.steps.map((step) => step.tool)).toEqual([tool]);
    expect(result.steps[0].params.pointer).toEqual({
      toolType: "stylus",
      pressure: tool === "swipeAt" ? 0.6 : 0.2,
    });
  });

  test("exported stroke and hover refuse unsupported replay before any dispatch", async () => {
    const environment: PointerEnvironment = {
      platform: "android",
      apiLevel: 37,
      capabilities: new Set(),
    };
    const dispatched: PointerRequest[] = [];
    const dispatch = async (request: PointerRequest) => {
      dispatched.push(request);
    };
    const injectors = defaultPointerRoutes({
      a11y: dispatch,
      adbInputSource: dispatch,
      instrumentation: dispatch,
      uinput: dispatch,
    });
    const { result: stroke } = await recordedCapture("stroke-varying-pressure");
    const options = dragPathSchema.parse(stroke.steps[0].params);
    const request = strokeRequest(options.pointer!, options.points, { path: true });
    expect(request.features).toMatchObject({ toolType: "stylus", variablePressure: true });
    await expect(
      dispatchRichStylus(DEVICE, new FakeAdbExecutor(), request, {
        readEnvironment: async () => environment,
        injectors,
      }),
    ).rejects.toThrow("stylus_input_v1");
    const { result: hover } = await recordedCapture("hover-stylus");
    const replay = new HoverAt(DEVICE, new FakeAdbExecutor(), {
      timer: new FakeTimer(),
      readPointerEnvironment: async () => environment,
      pointerInjectors: injectors,
    });
    const refusal = await replay.execute(hoverAtSchema.parse(hover.steps[0].params));
    expect(refusal.success).toBe(false);
    expect(refusal.error).toContain("hover_input_v1");
    expect(refusal.error).toContain("No input was sent");
    expect(dispatched).toEqual([]);
  });
});

describe("pen sampling bounds and stroke threshold", () => {
  function drag(pressures: number[], finalMove = false, intervalMs = 16) {
    const reconstructor = new TouchFrameReconstructor({ singleTouch: true });
    const classifier = new GestureClassifier({ toScreenPoint: (x, y) => ({ x, y }) }, 1, {
      min: 0,
      max: 1000,
    });
    const events: GestureEvent[] = [];
    let largestPath = 0;
    let firstPath: readonly { x: number }[] | undefined;
    const line = (event: string, time: number) => {
      const frame = reconstructor.feedLine(`[ ${(1000 + time) / 1000}] ${event}`, time);
      if (frame && "activeSlots" in frame) {
        const path = frame.activeSlots[0]?.path;
        firstPath ??= path;
        largestPath = Math.max(largestPath, path?.length ?? 0);
        const gesture = classifier.feedFrame(frame);
        if (gesture) {
          events.push(gesture);
        }
      }
    };
    line("EV_KEY BTN_TOOL_PEN DOWN", 0);
    line("EV_KEY BTN_TOUCH DOWN", 0);
    pressures.forEach((pressure, i) => {
      line(`EV_ABS ABS_X ${(i * 20).toString(16)}`, i * intervalMs);
      line("EV_ABS ABS_Y 00000064", i * intervalMs);
      line(`EV_ABS ABS_PRESSURE ${pressure.toString(16)}`, i * intervalMs);
      line("EV_SYN SYN_REPORT 00000000", i * intervalMs);
    });
    const end = pressures.length * intervalMs;
    if (finalMove) {
      line("EV_ABS ABS_X 00002710", end);
    }
    line("EV_ABS ABS_PRESSURE 00000000", end);
    line("EV_KEY BTN_TOUCH UP", end);
    line("EV_SYN SYN_REPORT 00000000", end);
    return { event: events[0], largestPath, firstPath };
  }

  test.each([18000, 22500, 25000])(
    "a compacted %i ms stroke keeps its true duration",
    (duration) => {
      const pressures = Array.from({ length: 1500 }, (_, index) => 200 + (index % 700));
      const { event, largestPath } = drag(pressures, true, duration / pressures.length);
      expect(event.type).toBe("stroke");
      expect(largestPath).toBeLessThanOrEqual(GESTURE_THRESHOLDS.PEN_MAX_SAMPLES);
      expect(event.path!.length).toBeLessThan(pressures.length);
      const step = buildPenSampleStep(event);
      if (duration > 20000) {
        expect(step).toBeNull();
        expect(exportLossWarning(event, step)).toContain("exceeds the 20 second replay limit");
      } else {
        const params = dragPathSchema.parse(step?.params);
        expect(params.points.slice(1).reduce((total, point) => total + point.durationMs!, 0)).toBe(
          duration,
        );
        expect(exportLossWarning(event, step)).toBeUndefined();
      }
    },
  );

  test.each([
    [49, "swipe"],
    [50, "stroke"],
  ] as const)("raw pressure range %i/1000 classifies as %s", (delta, type) => {
    expect(drag([200, 200 + delta]).event.type).toBe(type);
  });

  test("compaction retains a brief pressure peak between temporal samples", () => {
    const pressures = Array.from({ length: 300 }, (_, i) => (i === 2 ? 900 : 200));
    const { event } = drag(pressures);
    expect(event.type).toBe("stroke");
    expect(event.path!.some((point) => point.pressure === 0.9)).toBe(true);
  });

  test("long contacts stay bounded, preserve endpoints and do not mutate earlier frames", () => {
    const { event, largestPath, firstPath } = drag(
      Array.from({ length: 300 }, (_, i) => 200 + i),
      true,
    );
    expect(largestPath).toBeLessThanOrEqual(GESTURE_THRESHOLDS.PEN_MAX_SAMPLES);
    expect(event.type).toBe("stroke");
    expect(event.path!.length).toBeLessThanOrEqual(GESTURE_THRESHOLDS.PEN_MAX_SAMPLES);
    expect(event.path![0]).toMatchObject({ x: 0, pressure: 0.2, arrivedAt: 0 });
    expect(event.path!.at(-1)).toMatchObject({ x: 10000, pressure: 0.499 });
    expect(firstPath).toHaveLength(1);
  });
});
