import { describe, expect, test } from "bun:test";
import { normalizeDeviceFrame } from "../../../../../src/features/prototype/web/deviceFrames";
import {
  deviceFrameProblems,
  type DeviceFrameEntry,
} from "../../../../../src/features/prototype/web/deviceFrameSchema";
import rawRegistry from "../../../../../src/features/prototype/web/deviceFrames.json";
import {
  customDeviceFrame,
  customDeviceFrameProblems,
} from "../../../../../src/features/prototype/web/embed/prototypeWebFrameObject";
import { PrototypeWebInputError } from "../../../../../src/features/prototype/web/prototypeWebInputError";

const entries = rawRegistry.frames as readonly Record<string, unknown>[];
const SOURCE = { screen: "test", insets: "test", hinge: "test" };

/** What the registry's zod schema says of `entry` as the only frame, with a full source. */
const zodAccepts = (entry: unknown) =>
  deviceFrameProblems({
    frames: [typeof entry === "object" && entry !== null ? { ...entry, source: SOURCE } : entry],
  }).length === 0;

const pixel = () => structuredClone(entries[0]);
const foldable = () =>
  structuredClone(entries.find((entry) => entry.hinge !== undefined) ?? entries[0]);

/** Each mutation names a way to break, or keep, a valid entry. */
const MUTATIONS: Readonly<Record<string, (entry: Record<string, unknown>) => unknown>> = {
  "no id": ({ id: _id, ...rest }) => rest,
  "upper-case id": (entry) => ({ ...entry, id: "Pixel" }),
  "unknown platform": (entry) => ({ ...entry, platform: "symbian" }),
  "empty label": (entry) => ({ ...entry, label: "" }),
  "long label": (entry) => ({ ...entry, label: "x".repeat(65) }),
  "unknown field": (entry) => ({ ...entry, shiny: true }),
  "a source": (entry) => ({ ...entry, source: SOURCE }),
  "zero width": (entry) => ({ ...entry, screen: { widthDp: 0, heightDp: 800, density: 2 } }),
  "huge density": (entry) => ({ ...entry, screen: { widthDp: 400, heightDp: 800, density: 9 } }),
  "string corner": (entry) => ({ ...entry, cornerRadiusDp: "8" }),
  "negative status bar": (entry) => ({ ...entry, statusBarDp: -1 }),
  "infinite bezel": (entry) => ({ ...entry, frame: { bezelDp: Infinity, color: "#000000" } }),
  "short color": (entry) => ({ ...entry, frame: { bezelDp: 8, color: "#000" } }),
  "unknown cutout": (entry) => ({ ...entry, cutout: { type: "teardrop" } }),
  "notch without height": (entry) => ({
    ...entry,
    cutout: { type: "notch", centerXDp: 100, centerYDp: 10, widthDp: 40 },
  }),
  "cutout off screen": (entry) => ({
    ...entry,
    cutout: { type: "punchHole", centerXDp: 5, centerYDp: 5, radiusDp: 20 },
  }),
  "no cutout": (entry) => ({ ...entry, cutout: { type: "none" } }),
  "button nav": (entry) => ({ ...entry, navBar: { type: "buttons", heightDp: 48 } }),
  "nav with extra": (entry) => ({ ...entry, navBar: { type: "none", heightDp: 48 } }),
  "insets fill screen": (entry) => ({
    ...entry,
    safeArea: {
      portrait: { top: 500, bottom: 500, left: 0, right: 0 },
      landscape: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  }),
  "unknown form factor": (entry) => ({ ...entry, formFactor: "pager" }),
  "round mask": (entry) => ({ ...entry, mask: "round" }),
  "unknown input": (entry) => ({ ...entry, input: "stylus" }),
  "inner panel listed": (entry) => ({
    ...entry,
    panels: [{ role: "inner", ...panelOf(entry) }],
  }),
  "cover panel": (entry) => ({ ...entry, panels: [{ role: "cover", ...panelOf(entry) }] }),
  "duplicate panel": (entry) => ({
    ...entry,
    panels: [
      { role: "cover", ...panelOf(entry) },
      { role: "cover", ...panelOf(entry) },
    ],
  }),
  "too many panels": (entry) => ({
    ...entry,
    panels: ["cover", "rear", "external", "cover"].map((role) => ({ role, ...panelOf(entry) })),
  }),
  "hinge off panel": (entry) => ({
    ...entry,
    hinge: { axis: "vertical", positionDp: 0, widthDp: 0, occluding: false },
  }),
  "hinge on missing panel": (entry) => ({
    ...entry,
    hinge: { axis: "vertical", panel: "rear", positionDp: 100, widthDp: 0, occluding: false },
  }),
  "hinge without occluding": (entry) => ({
    ...entry,
    hinge: { axis: "vertical", positionDp: 100, widthDp: 0 },
  }),
  "posture on missing panel": (entry) => ({
    ...entry,
    postures: [{ posture: "opened", panel: "rear", hingeDegrees: 180 }],
  }),
  "duplicate posture": (entry) => ({
    ...entry,
    postures: [
      { posture: "opened", panel: "inner", hingeDegrees: 180 },
      { posture: "opened", panel: "inner", hingeDegrees: 170 },
    ],
  }),
  "posture over 360": (entry) => ({
    ...entry,
    postures: [{ posture: "opened", panel: "inner", hingeDegrees: 400 }],
  }),
  "not an object": () => "pixel-9",
  "an array": () => [],
};

function panelOf(entry: Record<string, unknown>) {
  const { screen, cornerRadiusDp, cutout, statusBarDp, navBar, safeArea } = entry;
  return { screen, cornerRadiusDp, cutout, statusBarDp, navBar, safeArea };
}

describe("frame object check (#16453)", () => {
  test("accepts every registry entry, as the registry schema does", () => {
    const rejected = entries.filter((entry) => customDeviceFrameProblems(entry).length > 0);
    expect(rejected.map((entry) => entry.id)).toEqual([]);
  });

  test("agrees with the registry schema on every mutation of a phone and a foldable", () => {
    const verdicts = [pixel(), foldable()].flatMap((entry) =>
      Object.entries(MUTATIONS)
        .filter(([name]) => name !== "a source")
        .map(([name, mutate]) => {
          const mutated = mutate(structuredClone(entry));
          const mine = customDeviceFrameProblems(mutated).length === 0;
          return { name: `${String(entry.id)}: ${name}`, mine, zod: zodAccepts(mutated) };
        }),
    );
    expect(verdicts.filter(({ mine, zod }) => mine !== zod)).toEqual([]);
    // Both verdicts occur, so agreement is not a schema that accepts or refuses everything.
    expect(new Set(verdicts.map(({ zod }) => zod))).toEqual(new Set([true, false]));
  });

  test("refuses a source, which only the registry's sources file carries", () => {
    expect(customDeviceFrameProblems({ ...pixel(), source: SOURCE })).toEqual([
      "frame.source: unknown field",
    ]);
  });

  test("refuses a sparse panels or postures array instead of normalizing its hole", () => {
    // Index 0 is a hole: assigning only index 1 leaves it unset, not undefined.
    const sparse: unknown[] = [];
    sparse[1] = { posture: "opened", panel: "inner", hingeDegrees: 180 };
    expect(customDeviceFrameProblems({ ...pixel(), panels: new Array(1) })).toEqual([
      "frame.panels[0]: expected an object",
    ]);
    expect(customDeviceFrameProblems({ ...pixel(), postures: sparse })).toEqual([
      "frame.postures[0]: expected an object",
    ]);
  });

  test("names the path of each problem", () => {
    expect(customDeviceFrameProblems({ ...pixel(), frame: { bezelDp: -1 }, mask: "oval" })).toEqual(
      [
        'frame.mask: expected one of "rect", "round"',
        "frame.frame.bezelDp: expected a number from 0 to 4096",
        "frame.frame.color: required",
      ],
    );
  });

  test("fills the registry's defaults, as a registry entry is filled", () => {
    const entry = { ...pixel(), id: "my-phone", label: "My phone" };
    expect(customDeviceFrame(entry)).toEqual(normalizeDeviceFrame(entry as DeviceFrameEntry));
  });

  test("throws a renderer input error listing the problems", () => {
    expect(() => customDeviceFrame({ ...pixel(), id: "" })).toThrow(PrototypeWebInputError);
    expect(() => customDeviceFrame({ ...pixel(), id: "" })).toThrow(
      "Invalid frame object. frame.id: expected a lowercase kebab-case id",
    );
  });
});
