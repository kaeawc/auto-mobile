import { describe, expect, test } from "bun:test";
import {
  UINPUT_REGISTRATION_SETTLE_MS,
  uinputPenScript,
  uinputRawPoint,
  uinputTiltAxes,
} from "../../../../src/features/action/pointer/uinputPenScript";
import type { PointerRequest } from "../../../../src/features/action/pointer/PointerInjector";

const PORTRAIT = { width: 1080, height: 2400, rotation: 0 };
// Event type and code numbers from linux/input-event-codes.h.
const [EV_SYN, EV_KEY, EV_ABS] = [0, 1, 3];
const [ABS_X, ABS_Y, ABS_PRESSURE, ABS_DISTANCE] = [0, 1, 24, 25];
const [BTN_TOOL_PEN, BTN_TOUCH] = [320, 330];
const SYN = [EV_SYN, 0, 0];

type Command = {
  id?: number;
  command: string;
  events?: number[];
  duration?: number;
  abs_info?: unknown[];
};

function commands(request: PointerRequest, geometry = PORTRAIT): Command[] {
  return uinputPenScript(request, geometry)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Command);
}

describe("uinputRawPoint", () => {
  test("maps a screen point to natural-orientation digitizer coordinates", () => {
    const size = { width: 1080, height: 2400 };
    const point = { x: 100, y: 200 };
    expect(uinputRawPoint(point, { ...size, rotation: 0 })).toEqual({ x: 100, y: 200 });
    // 90: screen x runs along raw y and screen y along inverted raw x.
    expect(uinputRawPoint(point, { ...size, rotation: 1 })).toEqual({ x: 879, y: 100 });
    expect(uinputRawPoint(point, { ...size, rotation: 2 })).toEqual({ x: 979, y: 2199 });
    expect(uinputRawPoint(point, { ...size, rotation: 3 })).toEqual({ x: 200, y: 2299 });
  });

  test("clamps to the digitizer range", () => {
    expect(uinputRawPoint({ x: -5, y: 9999 }, PORTRAIT)).toEqual({ x: 0, y: 2399 });
  });
});

describe("uinputPenScript", () => {
  const stroke: PointerRequest = {
    features: { toolType: "stylus", variablePressure: true },
    points: [
      { x: 100, y: 200, pressure: 0.5 },
      { x: 100, y: 232, durationMs: 32, pressure: 1 },
    ],
  };

  test("registers a direct pen sized to the natural display, then waits for it to attach", () => {
    const [register, settle] = commands(stroke, { width: 1080, height: 2400, rotation: 1 });
    expect(register).toMatchObject({
      command: "register",
      configuration: [
        { type: 100, data: [EV_SYN, EV_KEY, EV_ABS] },
        { type: 101, data: [320, 321, 330, 331, 332] },
        { type: 103, data: [0, 1, 24, 25, 26, 27] },
        { type: 110, data: [1] },
      ],
    });
    expect(register.abs_info).toContainEqual({
      code: ABS_X,
      info: { value: 0, minimum: 0, maximum: 1079, fuzz: 0, flat: 0, resolution: 0 },
    });
    expect(register.abs_info).toContainEqual({
      code: ABS_Y,
      info: { value: 0, minimum: 0, maximum: 2399, fuzz: 0, flat: 0, resolution: 0 },
    });
    expect(settle).toEqual({ id: 1, command: "delay", duration: UINPUT_REGISTRATION_SETTLE_MS });
  });

  test("plays a stroke as pen down, interpolated moves every 16 ms, then touch up and pen out", () => {
    const [, , down, gap1, move1, gap2, move2, up] = commands(stroke);
    expect(down.events).toEqual([
      ...[EV_KEY, BTN_TOOL_PEN, 1, EV_KEY, BTN_TOUCH, 1],
      ...[EV_ABS, ABS_X, 100, EV_ABS, ABS_Y, 200, EV_ABS, ABS_PRESSURE, 2048],
      ...[EV_ABS, ABS_DISTANCE, 0],
      ...SYN,
    ]);
    expect(gap1).toEqual({ id: 1, command: "delay", duration: 16 });
    expect(move1.events).toEqual([
      ...[EV_ABS, ABS_X, 100, EV_ABS, ABS_Y, 216, EV_ABS, ABS_PRESSURE, 3071],
      ...SYN,
    ]);
    expect(gap2).toEqual({ id: 1, command: "delay", duration: 16 });
    expect(move2.events).toEqual([
      ...[EV_ABS, ABS_X, 100, EV_ABS, ABS_Y, 232, EV_ABS, ABS_PRESSURE, 4095],
      ...SYN,
    ]);
    expect(up.events).toEqual([
      ...[EV_KEY, BTN_TOUCH, 0, EV_ABS, ABS_PRESSURE, 0],
      ...SYN,
      ...[EV_KEY, BTN_TOOL_PEN, 0],
      ...SYN,
    ]);
  });

  test("defaults stroke pressure to full and a segment to 200 ms", () => {
    const script = commands({
      features: { toolType: "stylus", path: true },
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 26 },
      ],
    });
    expect(script[2].events).toContain(4095);
    // 200 ms in 16 ms frames: 13 moves, each after its own delay.
    expect(script.filter((entry) => entry.command === "delay").slice(1, -1)).toHaveLength(13);
    expect(script.filter((entry) => entry.command === "inject")).toHaveLength(15);
  });

  test("plays a hover as pen in range without touch, with the hover distance", () => {
    const script = commands({
      features: { toolType: "stylus", hover: true },
      points: [
        { x: 10, y: 20 },
        { x: 10, y: 20, durationMs: 16, distance: 1 },
      ],
    });
    const injects = script.filter((entry) => entry.command === "inject");
    expect(injects[0].events).toEqual([
      ...[EV_KEY, BTN_TOOL_PEN, 1],
      ...[EV_ABS, ABS_X, 10, EV_ABS, ABS_Y, 20, EV_ABS, ABS_DISTANCE, 128],
      ...[EV_ABS, ABS_PRESSURE, 0],
      ...SYN,
    ]);
    expect(injects[1].events).toEqual([
      ...[EV_ABS, ABS_X, 10, EV_ABS, ABS_Y, 20, EV_ABS, ABS_DISTANCE, 255],
      ...SYN,
    ]);
    expect(injects.at(-1)?.events).toEqual([EV_KEY, BTN_TOOL_PEN, 0, ...SYN]);
    expect(injects.flatMap((entry) => entry.events ?? [])).not.toContain(BTN_TOUCH);
  });

  test("ends with a short delay so the last events are read before the device closes", () => {
    expect(commands(stroke).at(-1)).toMatchObject({ command: "delay" });
  });
});

describe("uinputPenScript eraser (#13105)", () => {
  const BTN_TOOL_RUBBER = 321;
  const eraser: PointerRequest = {
    features: { toolType: "eraser", path: true },
    points: [
      { x: 100, y: 200 },
      { x: 100, y: 232, durationMs: 32 },
    ],
  };
  const keyEvents = (request: PointerRequest) =>
    commands(request)
      .flatMap((command) => command.events ?? [])
      .reduce<number[][]>((triples, value, index, all) => {
        if (index % 3 === 0 && all[index] === EV_KEY) {
          triples.push(all.slice(index, index + 3));
        }
        return triples;
      }, []);

  test("an eraser stroke puts the rubber end down and lifts it, never the pen tip", () => {
    const keys = keyEvents(eraser);
    expect(keys[0]).toEqual([EV_KEY, BTN_TOOL_RUBBER, 1]);
    expect(keys.at(-1)).toEqual([EV_KEY, BTN_TOOL_RUBBER, 0]);
    expect(keys.some(([, code]) => code === BTN_TOOL_PEN)).toBe(false);
    expect(keys).toContainEqual([EV_KEY, BTN_TOUCH, 1]);
  });

  test("a stylus stroke keeps the pen tip", () => {
    const keys = keyEvents({ ...eraser, features: { toolType: "stylus", path: true } });
    expect(keys[0]).toEqual([EV_KEY, BTN_TOOL_PEN, 1]);
    expect(keys.some(([, code]) => code === BTN_TOOL_RUBBER)).toBe(false);
  });
});

describe("uinput extended axes", () => {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const pairs = [
    [30, 0, 0, 30],
    [30, 90, -30, 0],
    [30, -90, 30, 0],
    [60, 45, -45, 45],
    [45, 180, 0, -45],
    [45, -180, 0, -45],
    [90, 45, -90, 90],
    [0, 90, 0, 0],
  ];

  test("inverts Android tilt and orientation into integer evdev degrees", () => {
    for (const [tilt, orientation, x, y] of pairs) {
      const axes = uinputTiltAxes(radians(tilt), radians(orientation));
      expect(axes).toEqual({ x, y });
      const tx = radians(axes.x);
      const ty = radians(axes.y);
      expect(Math.abs(Math.acos(Math.cos(tx) * Math.cos(ty)) - radians(tilt))).toBeLessThan(
        radians(1),
      );
      if (tilt > 0) {
        const actual = Math.atan2(-Math.sin(tx), Math.sin(ty));
        const difference = actual - radians(orientation);
        expect(Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference)))).toBeLessThan(
          radians(1),
        );
      }
    }
  });

  test("emits the converted pair with position on every contact frame, including open", () => {
    for (const [tilt, orientation, x, y] of pairs) {
      const frames = commands({
        features: { toolType: "stylus", extendedAxes: true },
        points: [
          { x: 10, y: 20, tilt: radians(tilt), orientation: radians(orientation) },
          { x: 10, y: 20, durationMs: 16, tilt: radians(tilt), orientation: radians(orientation) },
        ],
      }).filter((command) => command.command === "inject");
      for (const frame of frames.slice(0, -1)) {
        const events = frame.events ?? [];
        const index = events.findIndex(
          (value, i) => i % 3 === 0 && value === EV_ABS && events[i + 1] === 26,
        );
        expect(events.slice(index, index + 6)).toEqual([EV_ABS, 26, x, EV_ABS, 27, y]);
      }
    }
  });

  test("interpolates tilt and orientation and defaults omitted waypoint axes to zero", () => {
    const frames = commands({
      features: { toolType: "stylus", extendedAxes: true },
      points: [
        { x: 0, y: 0, tilt: 0, orientation: 0 },
        { x: 20, y: 20, durationMs: 32, tilt: Math.PI / 3, orientation: Math.PI / 2 },
        { x: 30, y: 30, durationMs: 16 },
      ],
    }).filter((command) => command.command === "inject");
    for (const [index, tilt, orientation] of [
      [0, 0, 0],
      [1, 30, 45],
      [2, 60, 90],
      [3, 0, 0],
    ]) {
      const events = frames[index].events ?? [];
      const start = events.findIndex(
        (value, i) => i % 3 === 0 && value === EV_ABS && events[i + 1] === 26,
      );
      const { x, y } = uinputTiltAxes(radians(tilt), radians(orientation));
      expect(events.slice(start, start + 6)).toEqual([EV_ABS, 26, x, EV_ABS, 27, y]);
    }
  });

  test("defaults missing tilt or orientation to zero", () => {
    for (const [point, expected] of [
      [{ tilt: Math.PI / 6 }, [EV_ABS, 26, 0, EV_ABS, 27, 30]],
      [{ orientation: Math.PI / 2 }, [EV_ABS, 26, 0, EV_ABS, 27, 0]],
    ] as const) {
      const events =
        commands({
          features: { toolType: "stylus", extendedAxes: true },
          points: [{ x: 0, y: 0, ...point }],
        })[2].events ?? [];
      expect(events.slice(15, 21)).toEqual([...expected]);
    }
  });

  test("starts at zero when axes first appear at a later waypoint", () => {
    const frames = commands({
      features: { toolType: "stylus", extendedAxes: true },
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 0, durationMs: 32, tilt: Math.PI / 3 },
      ],
    }).filter((command) => command.command === "inject");
    for (const [index, y] of [
      [0, 0],
      [1, 30],
      [2, 60],
    ]) {
      expect(frames[index].events?.slice(index === 0 ? 15 : 9, index === 0 ? 21 : 15)).toEqual([
        EV_ABS,
        26,
        0,
        EV_ABS,
        27,
        y,
      ]);
    }
  });

  test("no axes or buttons keeps the legacy script even when extendedAxes is set", () => {
    const request: PointerRequest = {
      features: { toolType: "stylus" },
      points: [{ x: 10, y: 20 }],
    };
    expect(
      uinputPenScript(
        { ...request, features: { ...request.features, extendedAxes: true }, buttons: 0 },
        PORTRAIT,
      ),
    ).toBe(uinputPenScript(request, PORTRAIT));
    expect(
      commands(request)
        .filter((command) => command.command === "inject")
        .map((command) => command.events),
    ).toEqual([
      [
        EV_KEY,
        BTN_TOOL_PEN,
        1,
        EV_KEY,
        BTN_TOUCH,
        1,
        EV_ABS,
        ABS_X,
        10,
        EV_ABS,
        ABS_Y,
        20,
        EV_ABS,
        ABS_PRESSURE,
        4095,
        EV_ABS,
        ABS_DISTANCE,
        0,
        ...SYN,
      ],
      [EV_KEY, BTN_TOUCH, 0, EV_ABS, ABS_PRESSURE, 0, ...SYN, EV_KEY, BTN_TOOL_PEN, 0, ...SYN],
    ]);
  });

  test("presses selected barrel keys only on open and releases them before touch up", () => {
    for (const [buttons, codes] of [
      [32, [331]],
      [64, [332]],
      [96, [331, 332]],
    ] as const) {
      const frames = commands({
        features: { toolType: "stylus", extendedAxes: true },
        buttons,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1, durationMs: 16 },
        ],
      }).filter((command) => command.command === "inject");
      expect(frames[0].events).toEqual([
        EV_KEY,
        BTN_TOOL_PEN,
        1,
        EV_KEY,
        BTN_TOUCH,
        1,
        EV_ABS,
        ABS_X,
        0,
        EV_ABS,
        ABS_Y,
        0,
        EV_ABS,
        ABS_PRESSURE,
        4095,
        EV_ABS,
        ABS_DISTANCE,
        0,
        ...codes.flatMap((code) => [EV_KEY, code, 1]),
        ...SYN,
      ]);
      expect(frames[1].events).toEqual([
        EV_ABS,
        ABS_X,
        1,
        EV_ABS,
        ABS_Y,
        1,
        EV_ABS,
        ABS_PRESSURE,
        4095,
        ...SYN,
      ]);
      expect(frames[2].events).toEqual([
        ...codes.flatMap((code) => [EV_KEY, code, 0]),
        EV_KEY,
        BTN_TOUCH,
        0,
        EV_ABS,
        ABS_PRESSURE,
        0,
        ...SYN,
        EV_KEY,
        BTN_TOOL_PEN,
        0,
        ...SYN,
      ]);
    }
  });
});
