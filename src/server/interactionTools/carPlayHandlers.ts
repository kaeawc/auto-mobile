import { validateRotarySteps, isRotaryButton } from "../../features/action/RotaryInput";
import { ActionableError, type BootedDevice } from "../../models";
import {
  type CarPlayInput,
  type CarPlayInputDependencies,
  DefaultCarPlayInputSender,
  sendCarPlayInput,
} from "../../utils/ios/carPlayInput";
import { DefaultCarPlayProjectionProbe } from "../../utils/ios/carPlayProjection";
import {
  type CarPlayTapDependencies,
  DefaultCarPlayTapper,
  tapCarPlayScreen,
} from "../../utils/ios/carPlayTap";
import { createStructuredToolResponse } from "../../utils/toolUtils";
import type { PressButtonArgs, TapAtArgs } from "../interactionToolTypes";

/** tapAt's display value for the iOS simulator's CarPlay car screen (#18730). */
export const CARPLAY_DISPLAY = "carPlay";

export type CarPlayTapFactory = () => CarPlayTapDependencies;

export const defaultCarPlayTapFactory: CarPlayTapFactory = () => ({
  probe: new DefaultCarPlayProjectionProbe(),
  tapper: new DefaultCarPlayTapper(),
});

/** tapAt fields with no CarPlay HID equivalent, and whether a call set them. */
const UNSUPPORTED_TAP_AT_FIELDS: readonly [string, (args: TapAtArgs) => boolean][] = [
  ["image", (args) => args.image !== undefined],
  [
    "coordinateSpace",
    (args) => args.coordinateSpace !== undefined && args.coordinateSpace !== "absolute",
  ],
  ["action", (args) => args.action !== undefined && args.action !== "tap"],
  ["durationMs", (args) => args.durationMs !== undefined],
  ["snapshotId", (args) => args.snapshotId !== undefined],
  ["pointer", (args) => args.pointer !== undefined],
  ["layer", (args) => args.layer !== undefined],
];

function carPlayTapPoint(device: BootedDevice, args: TapAtArgs): { x: number; y: number } {
  if (device.platform !== "ios") {
    throw new ActionableError(
      `tapAt display "${CARPLAY_DISPLAY}" is for an iOS iPhone simulator's CarPlay screen, not ${device.platform}. Android phones use display "headUnit".`,
    );
  }
  const unsupported = UNSUPPORTED_TAP_AT_FIELDS.flatMap(([field, isSet]) =>
    isSet(args) ? [field] : [],
  );
  if (unsupported.length > 0) {
    throw new ActionableError(
      `tapAt display "${CARPLAY_DISPLAY}" takes x and y in CarPlay screen pixels and a plain tap; ${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} not supported there.`,
    );
  }
  if (args.x === undefined || args.y === undefined) {
    throw new ActionableError(`tapAt display "${CARPLAY_DISPLAY}" requires x and y.`);
  }
  return { x: args.x, y: args.y };
}

/**
 * tapAt on the CarPlay screen: refused unless the probe reports the car display; the helper then
 * sends one touch down and up to the CarPlay HID service. It reports what was sent, not what the
 * screen did; observe the CarPlay screen to see the effect.
 */
export async function carPlayTapAtHandler(
  device: BootedDevice,
  args: TapAtArgs,
  factory: CarPlayTapFactory = defaultCarPlayTapFactory,
  signal?: AbortSignal,
) {
  const point = carPlayTapPoint(device, args);
  const { display, tap } = await tapCarPlayScreen(device.deviceId, point, factory(), signal);
  return createStructuredToolResponse({
    message: `Tapped the CarPlay screen ${display.identity} at (${tap.x}, ${tap.y}) of ${tap.width}x${tap.height}`,
    success: true,
    action: "tap",
    x: tap.x,
    y: tap.y,
    carPlay: {
      display: display.identity,
      displayId: display.displayId,
      width: tap.width,
      height: tap.height,
    },
    deviceId: device.deviceId,
    platform: device.platform,
  });
}

export type CarPlayInputFactory = () => CarPlayInputDependencies;

export const defaultCarPlayInputFactory: CarPlayInputFactory = () => ({
  probe: new DefaultCarPlayProjectionProbe(),
  sender: new DefaultCarPlayInputSender(),
});

/** pressButton buttons the CarPlay screen takes, and the helper input each sends (#19059). */
const CARPLAY_BUTTON_INPUTS: Readonly<Partial<Record<PressButtonArgs["button"], CarPlayInput>>> = {
  back: "back",
  home: "home",
  siri: "siri",
  rotary_select: "knob-select",
  rotary_nudge_up: "knob-up",
  rotary_nudge_down: "knob-down",
  rotary_nudge_left: "knob-left",
  rotary_nudge_right: "knob-right",
  rotary_rotate_cw: "knob-cw",
  rotary_rotate_ccw: "knob-ccw",
};

/** Buttons only the CarPlay screen has; every other display refuses them. */
const CARPLAY_ONLY_BUTTONS: ReadonlySet<string> = new Set(["siri"]);

/** Refuses a CarPlay-only button sent anywhere but display "carPlay". */
export function refuseCarPlayOnlyButton(args: PressButtonArgs): void {
  if (CARPLAY_ONLY_BUTTONS.has(args.button)) {
    throw new ActionableError(
      `pressButton ${args.button} is a CarPlay head-unit button; pass display "${CARPLAY_DISPLAY}" on an iOS 26.x simulator.`,
    );
  }
}

function carPlayInput(
  device: BootedDevice,
  args: PressButtonArgs,
): { name: CarPlayInput; count: number } {
  if (device.platform !== "ios") {
    throw new ActionableError(
      `pressButton display "${CARPLAY_DISPLAY}" is for an iOS iPhone simulator's CarPlay screen, not ${device.platform}. Android phones use display "headUnit".`,
    );
  }
  const name = CARPLAY_BUTTON_INPUTS[args.button];
  if (name === undefined) {
    throw new ActionableError(
      `pressButton display "${CARPLAY_DISPLAY}" takes ${Object.keys(CARPLAY_BUTTON_INPUTS).join(", ")}; ${args.button} is not a CarPlay head-unit input.`,
    );
  }
  if (args.durationMs !== undefined) {
    throw new ActionableError(
      `pressButton display "${CARPLAY_DISPLAY}" sends a single press; durationMs is not supported there.`,
    );
  }
  const count = isRotaryButton(args.button)
    ? validateRotarySteps(args.button, args.steps)
    : rejectSteps(args);
  return { name, count };
}

function rejectSteps(args: PressButtonArgs): number {
  if (args.steps !== undefined) {
    throw new ActionableError(
      `steps applies to rotary_rotate_cw and rotary_rotate_ccw only; ${args.button} is a single event.`,
    );
  }
  return 1;
}

/**
 * pressButton on the CarPlay screen: back, home, Siri and the knob (rotate, nudge, select) go to
 * the CarPlay HID service once the probe reports the car display. The knob and the buttons need
 * startDevice carPlay with headUnitInputs. It reports what was sent, not what the screen did.
 */
export async function carPlayPressButtonHandler(
  device: BootedDevice,
  args: PressButtonArgs,
  factory: CarPlayInputFactory = defaultCarPlayInputFactory,
  signal?: AbortSignal,
) {
  const input = carPlayInput(device, args);
  const { display, sent } = await sendCarPlayInput(device.deviceId, input, factory(), signal);
  const times = sent.count > 1 ? ` x${sent.count}` : "";
  return createStructuredToolResponse({
    message: `Sent ${args.button}${times} to the CarPlay screen ${display.identity} as ${sent.input}`,
    success: true,
    button: args.button,
    carPlay: {
      display: display.identity,
      displayId: display.displayId,
      input: sent.input,
      count: sent.count,
      target: sent.target,
      ...(sent.usagePage !== undefined && { usagePage: sent.usagePage }),
      ...(sent.usage !== undefined && { usage: sent.usage }),
      ...(sent.scrollDelta !== undefined && { scrollDelta: sent.scrollDelta }),
    },
    deviceId: device.deviceId,
    platform: device.platform,
  });
}
