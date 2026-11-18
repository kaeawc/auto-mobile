import { deviceFrameGeometryProblems } from "../deviceFrameRules";
import { normalizeDeviceFrame } from "../deviceFrames";
import type { DeviceFrame, DeviceFrameEntry } from "../deviceFrameSchema";
import { PrototypeWebInputError } from "../prototypeWebInputError";

/**
 * Checks a frame object passed as the library's `frame` option (#16453) against the same strict
 * rules as a `deviceFrames.json` entry (`deviceFrameSchema.ts`), without zod, so the browser
 * bundle stays small. A unit test keeps the two in agreement over the registry and its mutations.
 */
interface PrototypeFrameInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

type PrototypeFrameCutout =
  | { readonly type: "none" }
  | {
      readonly type: "punchHole";
      readonly centerXDp: number;
      readonly centerYDp: number;
      readonly radiusDp: number;
    }
  | {
      readonly type: "notch" | "island";
      readonly centerXDp: number;
      readonly centerYDp: number;
      readonly widthDp: number;
      readonly heightDp: number;
    };

interface PrototypeFramePanelFields {
  readonly screen: {
    readonly widthDp: number;
    readonly heightDp: number;
    readonly density: number;
  };
  readonly cornerRadiusDp: number;
  readonly cutout: PrototypeFrameCutout;
  readonly statusBarDp: number;
  readonly navBar:
    | { readonly type: "none" }
    | { readonly type: "gesture" | "buttons"; readonly heightDp: number };
  readonly safeArea: {
    readonly portrait: PrototypeFrameInsets;
    readonly landscape: PrototypeFrameInsets;
  };
}

type PrototypeFramePanelRole = "inner" | "cover" | "rear" | "external";
type PrototypeFramePosture =
  | "closed"
  | "half_opened"
  | "opened"
  | "rear_display"
  | "flipped"
  | "tent";

/**
 * A custom device frame: an entry as the renderer's `deviceFrames.json` writes one. It is checked
 * as strictly as the registry, and an invalid one is refused with `invalidOption` naming its path.
 */
export interface PrototypeWebFrame extends PrototypeFramePanelFields {
  readonly id: string;
  readonly platform: "android" | "ios";
  readonly label: string;
  readonly formFactor?: "phone" | "tablet" | "foldable" | "tv" | "watch" | "automotive";
  /** The panels besides the `inner` one the top-level fields describe. */
  readonly panels?: readonly ({
    readonly role: Exclude<PrototypeFramePanelRole, "inner">;
  } & PrototypeFramePanelFields)[];
  readonly hinge?: {
    readonly axis: "vertical" | "horizontal";
    readonly panel?: PrototypeFramePanelRole;
    readonly positionDp: number;
    readonly widthDp: number;
    readonly occluding: boolean;
  };
  readonly postures?: readonly {
    readonly posture: PrototypeFramePosture;
    readonly panel: PrototypeFramePanelRole;
    readonly hingeDegrees: number;
  }[];
  readonly mask?: "rect" | "round";
  readonly input?: "touch" | "dpad" | "rotary";
  readonly frame: { readonly bezelDp: number; readonly color: string };
}

type Check = (value: unknown, path: string) => string[];

interface Field {
  readonly check: Check;
  readonly optional?: boolean;
}

const problem = (path: string, message: string) => [`${path}: ${message}`];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberIn(min: number, max: number, exclusiveMin = false): Check {
  return (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return problem(path, "expected a finite number");
    }
    const below = exclusiveMin ? value <= min : value < min;
    return below || value > max
      ? problem(path, `expected a number ${exclusiveMin ? "above" : "from"} ${min} to ${max}`)
      : [];
  };
}

const dp = numberIn(0, 4096);
const positiveDp = numberIn(0, 4096, true);

function oneOf(values: readonly string[]): Check {
  return (value, path) =>
    typeof value === "string" && values.includes(value)
      ? []
      : problem(path, `expected one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);
}

function matching(pattern: RegExp, description: string): Check {
  return (value, path) =>
    typeof value === "string" && pattern.test(value)
      ? []
      : problem(path, `expected ${description}`);
}

const boolean: Check = (value, path) =>
  typeof value === "boolean" ? [] : problem(path, "expected a boolean");

/** A strict object: every field checked, a missing required field or an unknown key refused. */
function object(fields: Readonly<Record<string, Field | Check>>): Check {
  return (value, path) => {
    if (!isRecord(value)) {
      return problem(path, "expected an object");
    }
    const known = Object.entries(fields).flatMap(([key, entry]) => {
      const field = typeof entry === "function" ? { check: entry } : entry;
      if (value[key] === undefined) {
        return field.optional ? [] : problem(`${path}.${key}`, "required");
      }
      return field.check(value[key], `${path}.${key}`);
    });
    const unknown = Object.keys(value)
      .filter((key) => !(key in fields))
      .flatMap((key) => problem(`${path}.${key}`, "unknown field"));
    return [...known, ...unknown];
  };
}

/** An object whose `type` picks its shape. */
function byType(shapes: Readonly<Record<string, Readonly<Record<string, Check>>>>): Check {
  const types = oneOf(Object.keys(shapes));
  return (value, path) => {
    if (!isRecord(value)) {
      return problem(path, "expected an object");
    }
    const typeProblems = types(value.type, `${path}.type`);
    if (typeProblems.length > 0) {
      return typeProblems;
    }
    return object({ type: types, ...shapes[value.type as string] })(value, path);
  };
}

function arrayOf(item: Check, max: number): Check {
  return (value, path) => {
    if (!Array.isArray(value)) {
      return problem(path, "expected an array");
    }
    const tooLong = value.length > max ? problem(path, `expected at most ${max} entries`) : [];
    // Array.from visits a sparse array's holes as undefined, which flatMap would skip.
    const entries = Array.from(value as unknown[], (entry, index) =>
      item(entry, `${path}[${index}]`),
    );
    return [...tooLong, ...entries.flat()];
  };
}

const optional = (check: Check): Field => ({ check, optional: true });

const insets = object({ top: dp, bottom: dp, left: dp, right: dp });
const box = { centerXDp: dp, centerYDp: dp, widthDp: dp, heightDp: dp };

const panelFields: Readonly<Record<string, Check>> = {
  screen: object({ widthDp: positiveDp, heightDp: positiveDp, density: numberIn(0, 8, true) }),
  cornerRadiusDp: dp,
  cutout: byType({
    none: {},
    punchHole: { centerXDp: dp, centerYDp: dp, radiusDp: dp },
    notch: box,
    island: box,
  }),
  statusBarDp: dp,
  navBar: byType({ none: {}, gesture: { heightDp: dp }, buttons: { heightDp: dp } }),
  safeArea: object({ portrait: insets, landscape: insets }),
};

const POSTURES = ["closed", "half_opened", "opened", "rear_display", "flipped", "tent"];
const panelRole = oneOf(["inner", "cover", "rear", "external"]);

const frameEntry = object({
  id: matching(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a lowercase kebab-case id"),
  platform: oneOf(["android", "ios"]),
  label: (value, path) =>
    typeof value === "string" && value.length >= 1 && value.length <= 64
      ? []
      : problem(path, "expected a label of 1 to 64 characters"),
  formFactor: optional(oneOf(["phone", "tablet", "foldable", "tv", "watch", "automotive"])),
  ...panelFields,
  panels: optional(
    arrayOf(object({ role: oneOf(["cover", "rear", "external"]), ...panelFields }), 3),
  ),
  hinge: optional(
    object({
      axis: oneOf(["vertical", "horizontal"]),
      panel: optional(panelRole),
      positionDp: dp,
      widthDp: dp,
      occluding: boolean,
    }),
  ),
  postures: optional(
    arrayOf(
      object({ posture: oneOf(POSTURES), panel: panelRole, hingeDegrees: numberIn(0, 360) }),
      POSTURES.length,
    ),
  ),
  mask: optional(oneOf(["rect", "round"])),
  input: optional(oneOf(["touch", "dpad", "rotary"])),
  frame: object({ bezelDp: dp, color: matching(/^#[0-9a-fA-F]{6}$/, "a #rrggbb color") }),
});

/** Every reason `value` is not a drawable frame object; empty when it is one. */
export function customDeviceFrameProblems(value: unknown): string[] {
  const shape = frameEntry(value, "frame");
  if (shape.length > 0) {
    return shape;
  }
  return deviceFrameGeometryProblems(normalizeDeviceFrame(value as DeviceFrameEntry), "frame");
}

/** The frame `value` describes, with the registry's defaults; throws when it is invalid. */
export function customDeviceFrame(value: unknown): DeviceFrame {
  const problems = customDeviceFrameProblems(value);
  if (problems.length > 0) {
    throw new PrototypeWebInputError(`Invalid frame object. ${problems.join("; ")}`);
  }
  return normalizeDeviceFrame(value as DeviceFrameEntry);
}
