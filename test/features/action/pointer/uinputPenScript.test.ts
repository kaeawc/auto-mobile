import { describe, expect, test } from "bun:test";
import {
  UINPUT_REGISTRATION_SETTLE_MS,
  uinputPenScript,
  uinputRawPoint,
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
