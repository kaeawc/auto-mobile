import type { PointerPoint, PointerRequest } from "./PointerInjector";

/**
 * The command script Android's `uinput` tool (`/system/bin/uinput -`) reads on stdin: one JSON
 * command per line that registers a virtual pen, then plays the request as evdev events (#13105).
 * The registration matches the pen the #13105 device probe verified: an `INPUT_PROP_DIRECT` device
 * the framework classifies as `SOURCE_STYLUS` without an idc or keylayout file.
 */

/** Event types and codes from linux/input-event-codes.h. */
const EV_SYN = 0;
const EV_KEY = 1;
const EV_ABS = 3;
const SYN_REPORT = 0;
const ABS_X = 0;
const ABS_Y = 1;
const ABS_PRESSURE = 24;
const ABS_DISTANCE = 25;
const ABS_TILT_X = 26;
const ABS_TILT_Y = 27;
const BTN_TOOL_PEN = 0x140;
const BTN_TOOL_RUBBER = 0x141;
const BTN_TOUCH = 0x14a;
const BTN_STYLUS = 0x14b;
const BTN_STYLUS2 = 0x14c;
const INPUT_PROP_DIRECT = 1;
/** uinput.h ioctl numbers the tool's `configuration` entries name. */
const UI_SET_EVBIT = 100;
const UI_SET_KEYBIT = 101;
const UI_SET_ABSBIT = 103;
const UI_SET_PROPBIT = 110;

const PRESSURE_MAX = 4095;
const DISTANCE_MAX = 255;
const TILT_RANGE_DEGREES = 90;
const DEVICE_ID = 1;

/** Gap between interpolated frames, the same as the instrumentation route. */
const FRAME_INTERVAL_MS = 16;
/** The segment time a point without `durationMs` takes (the same default as `dragPath`). */
const DEFAULT_SEGMENT_MS = 200;
/** A hover with no distance of its own sits halfway out, like the instrumentation route. */
const DEFAULT_HOVER_DISTANCE = 0.5;
/** How long the probe waited for the new input device to attach before injecting. */
export const UINPUT_REGISTRATION_SETTLE_MS = 4000;
/** Keeps the device open long enough for the reader to consume the last events. */
const CLOSE_SETTLE_MS = 50;

/** The default display in its current rotation; `width` and `height` are its size in rotation 0. */
export interface UinputDisplayGeometry {
  width: number;
  height: number;
  /** Surface rotation 0-3. */
  rotation: number;
}

/**
 * A screen point in the current rotation as natural-orientation digitizer coordinates: the inverse
 * of the recorder's touch mapping (`buildScaler`), with the digitizer range equal to the display.
 */
export function uinputRawPoint(
  point: { x: number; y: number },
  geometry: UinputDisplayGeometry,
): { x: number; y: number } {
  const maxX = geometry.width - 1;
  const maxY = geometry.height - 1;
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  const raw =
    geometry.rotation === 1
      ? { x: maxX - y, y: x }
      : geometry.rotation === 2
        ? { x: maxX - x, y: maxY - y }
        : geometry.rotation === 3
          ? { x: y, y: maxY - x }
          : { x, y };
  return { x: clamp(raw.x, maxX), y: clamp(raw.y, maxY) };
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

interface Frame {
  atMs: number;
  x: number;
  y: number;
  pressure: number;
  distance: number;
}

/** Waypoints as timed frames: the first point, then interpolated frames every 16 ms per segment. */
function planFrames(request: PointerRequest): Frame[] {
  const hover = request.features.hover === true;
  const first = request.points[0];
  let pressure = first.pressure ?? (hover ? 0 : 1);
  let distance = first.distance ?? (hover ? DEFAULT_HOVER_DISTANCE : 0);
  const frames: Frame[] = [{ atMs: 0, x: first.x, y: first.y, pressure, distance }];
  let elapsed = 0;
  request.points.slice(1).forEach((to, index) => {
    const from = request.points[index];
    const durationMs = to.durationMs ?? DEFAULT_SEGMENT_MS;
    const count = Math.max(1, Math.ceil(durationMs / FRAME_INTERVAL_MS));
    const start = { pressure, distance };
    for (let frame = 1; frame <= count; frame++) {
      const fraction = frame / count;
      pressure = lerp(start.pressure, to.pressure ?? start.pressure, fraction);
      distance = lerp(start.distance, to.distance ?? start.distance, fraction);
      frames.push({
        atMs: elapsed + Math.floor((durationMs * frame) / count),
        x: frame === count ? to.x : lerp(from.x, to.x, fraction),
        y: frame === count ? to.y : lerp(from.y, to.y, fraction),
        pressure,
        distance,
      });
    }
    elapsed += durationMs;
  });
  return frames;
}

function lerp(from: number, to: number, fraction: number): number {
  return from + (to - from) * fraction;
}

function abs(code: number, value: number): number[] {
  return [EV_ABS, code, value];
}

function scaled(value: number, max: number): number {
  return Math.round(clamp(value, 1) * max);
}

function positionEvents(frame: Frame, geometry: UinputDisplayGeometry, hover: boolean): number[] {
  const raw = uinputRawPoint(frame, geometry);
  return [
    ...abs(ABS_X, raw.x),
    ...abs(ABS_Y, raw.y),
    ...(hover
      ? abs(ABS_DISTANCE, scaled(frame.distance, DISTANCE_MAX))
      : abs(ABS_PRESSURE, scaled(frame.pressure, PRESSURE_MAX))),
  ];
}

const SYN = [EV_SYN, SYN_REPORT, 0];

function openEvents(frame: Frame, geometry: UinputDisplayGeometry, hover: boolean): number[] {
  const tool = [EV_KEY, BTN_TOOL_PEN, 1];
  return hover
    ? [...tool, ...positionEvents(frame, geometry, true), ...abs(ABS_PRESSURE, 0), ...SYN]
    : [
        ...tool,
        EV_KEY,
        BTN_TOUCH,
        1,
        ...positionEvents(frame, geometry, false),
        ...abs(ABS_DISTANCE, 0),
        ...SYN,
      ];
}

function closeEvents(hover: boolean): number[] {
  const toolUp = [EV_KEY, BTN_TOOL_PEN, 0, ...SYN];
  return hover ? toolUp : [EV_KEY, BTN_TOUCH, 0, ...abs(ABS_PRESSURE, 0), ...SYN, ...toolUp];
}

function absInfo(code: number, minimum: number, maximum: number) {
  return { code, info: { value: 0, minimum, maximum, fuzz: 0, flat: 0, resolution: 0 } };
}

function registration(geometry: UinputDisplayGeometry) {
  return {
    id: DEVICE_ID,
    command: "register",
    name: "automobile-pen",
    vid: 0x18d1,
    pid: 0x4e11,
    bus: "usb",
    configuration: [
      { type: UI_SET_EVBIT, data: [EV_SYN, EV_KEY, EV_ABS] },
      {
        type: UI_SET_KEYBIT,
        data: [BTN_TOOL_PEN, BTN_TOOL_RUBBER, BTN_TOUCH, BTN_STYLUS, BTN_STYLUS2],
      },
      {
        type: UI_SET_ABSBIT,
        data: [ABS_X, ABS_Y, ABS_PRESSURE, ABS_DISTANCE, ABS_TILT_X, ABS_TILT_Y],
      },
      { type: UI_SET_PROPBIT, data: [INPUT_PROP_DIRECT] },
    ],
    abs_info: [
      absInfo(ABS_X, 0, geometry.width - 1),
      absInfo(ABS_Y, 0, geometry.height - 1),
      absInfo(ABS_PRESSURE, 0, PRESSURE_MAX),
      absInfo(ABS_DISTANCE, 0, DISTANCE_MAX),
      absInfo(ABS_TILT_X, -TILT_RANGE_DEGREES, TILT_RANGE_DEGREES),
      absInfo(ABS_TILT_Y, -TILT_RANGE_DEGREES, TILT_RANGE_DEGREES),
    ],
  };
}

const inject = (events: number[]) => ({ id: DEVICE_ID, command: "inject", events });
const delay = (duration: number) => ({ id: DEVICE_ID, command: "delay", duration });

/** The stdin script for a stylus stroke or hover; tilt, orientation and buttons are not encoded. */
export function uinputPenScript(request: PointerRequest, geometry: UinputDisplayGeometry): string {
  const hover = request.features.hover === true;
  const [first, ...rest] = planFrames(request);
  const commands: object[] = [
    registration(geometry),
    delay(UINPUT_REGISTRATION_SETTLE_MS),
    inject(openEvents(first, geometry, hover)),
  ];
  let previousMs = 0;
  for (const frame of rest) {
    if (frame.atMs > previousMs) {
      commands.push(delay(frame.atMs - previousMs));
      previousMs = frame.atMs;
    }
    commands.push(inject([...positionEvents(frame, geometry, hover), ...SYN]));
  }
  commands.push(inject(closeEvents(hover)), delay(CLOSE_SETTLE_MS));
  return `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`;
}

/** Time every uinput run spends before and after its events: the pen attach and close waits. */
export const UINPUT_FIXED_OVERHEAD_MS = UINPUT_REGISTRATION_SETTLE_MS + CLOSE_SETTLE_MS;

/** The planned event time of a request, for a transport timeout. */
export function uinputPlannedMs(points: readonly PointerPoint[]): number {
  return (
    UINPUT_FIXED_OVERHEAD_MS +
    points.slice(1).reduce((sum, point) => sum + (point.durationMs ?? DEFAULT_SEGMENT_MS), 0)
  );
}
