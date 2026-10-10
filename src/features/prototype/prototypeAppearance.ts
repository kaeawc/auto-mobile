import {
  PROTOTYPE_APPEARANCE_CAPABILITY,
  type PrototypeAppearance,
  type PrototypeAppearanceOverride,
  type PrototypeAppearanceSource,
  type PrototypeResult,
} from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/** The `appearance` values a show accepts; `device` (the default) follows the device's setting. */
export const PROTOTYPE_APPEARANCE_INPUTS = ["device", "light", "dark"] as const;
export type PrototypeAppearanceInput = (typeof PROTOTYPE_APPEARANCE_INPUTS)[number];

export const PROTOTYPE_APPEARANCE_MODES = ["light", "dark"] as const;
/** Every `source` a device reports, in the order the tool output schema lists them. */
export const PROTOTYPE_APPEARANCE_SOURCES = [
  "explicit",
  "override",
  "roleLuminance",
  "authoredBackground",
  "system",
] as const satisfies readonly PrototypeAppearanceSource[];

/** The override to put on the wire: nothing for `device` or an omitted `appearance`. */
export function prototypeAppearanceOverride(
  appearance: PrototypeAppearanceInput | undefined,
): PrototypeAppearanceOverride | undefined {
  return appearance === "light" || appearance === "dark" ? appearance : undefined;
}

/** The refusal for a device that does not advertise the capability; nothing is sent to it. */
export function prototypeAppearanceUnsupportedMessage(
  appearance: PrototypeAppearanceOverride,
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_APPEARANCE_CAPABILITY}, so it would ignore appearance "${appearance}" and draw the prototype in the device's own light or dark setting. Nothing was shown. ${update}, or omit appearance to follow the device.`;
}

function isMode(value: unknown): value is PrototypeAppearance["mode"] {
  return PROTOTYPE_APPEARANCE_MODES.some((mode) => mode === value);
}

function isSource(value: unknown): value is PrototypeAppearanceSource {
  return PROTOTYPE_APPEARANCE_SOURCES.some((source) => source === value);
}

/**
 * A device-reported `{mode, source, deviceDark}`, or undefined when it is absent (a device without
 * `prototype_appearance_v1`) or not of that shape. The host never fills in a missing value.
 */
export function parsePrototypeAppearance(value: unknown): PrototypeAppearance | undefined {
  const fields = record(value);
  if (!fields) {
    return undefined;
  }
  const { mode, source, deviceDark } = fields;
  return isMode(mode) && isSource(source) && typeof deviceDark === "boolean"
    ? { mode, source, deviceDark }
    : undefined;
}

/** `result` with its `appearance` kept only when it has the reported shape. */
export function withParsedAppearance(result: PrototypeResult): PrototypeResult {
  if (result.appearance === undefined) {
    return result;
  }
  const { appearance: reported, ...rest } = result;
  const appearance = parsePrototypeAppearance(reported);
  return appearance ? { ...rest, appearance } : rest;
}

/** What a mutation's host record carries: the mode a show that landed reported, else nothing. */
export function shownAppearance(
  action: "show" | "dismiss",
  result: PrototypeResult,
): { appearance?: PrototypeAppearance } {
  return action === "show" && result.success && result.appearance
    ? { appearance: { ...result.appearance } }
    : {};
}

/**
 * The cached appearance after an `appearance_changed` event, whose payload is `{mode, source}`.
 * The event does not carry `deviceDark`: a `system` source means the device's own setting is the
 * new mode; any other source came from the prototype itself, so the last reported `deviceDark`
 * stands. With nothing cached and a non-system source there is no `deviceDark` to report, so the
 * result stays undefined. A payload of another shape leaves `previous` as it was.
 */
export function prototypeAppearanceAfterChange(
  previous: PrototypeAppearance | undefined,
  payload: unknown,
): PrototypeAppearance | undefined {
  const fields = record(payload);
  if (!fields || !isMode(fields.mode) || !isSource(fields.source)) {
    return previous;
  }
  const { mode, source } = fields;
  if (source === "system") {
    return { mode, source, deviceDark: mode === "dark" };
  }
  return previous ? { mode, source, deviceDark: previous.deviceDark } : undefined;
}
