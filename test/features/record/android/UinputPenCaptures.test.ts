import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInputNodes } from "../../../../src/features/record/android/InputNodeDiscovery";
import { strokeRequest } from "../../../../src/features/action/pointer/richStylus";
import { uinputPenScript } from "../../../../src/features/action/pointer/uinputPenScript";
import type { StylusButton } from "../../../../src/models/PointerOption";
import { captureFrames } from "../../../helpers/touchNodeCaptures";

const DIRECTORY = join(__dirname, "../../../fixtures/android-uinput-pen");
const PEN_PATH = "/dev/input/event12";

function readCapture(stroke: string, mode: "lt" | "lp-during"): string {
  return readFileSync(join(DIRECTORY, `${stroke}-getevent-${mode}-emulator-5610.txt`), "utf8");
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
