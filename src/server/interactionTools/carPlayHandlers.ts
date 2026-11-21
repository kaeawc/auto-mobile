import { ActionableError, type BootedDevice } from "../../models";
import { DefaultCarPlayProjectionProbe } from "../../utils/ios/carPlayProjection";
import {
  type CarPlayTapDependencies,
  DefaultCarPlayTapper,
  tapCarPlayScreen,
} from "../../utils/ios/carPlayTap";
import { createStructuredToolResponse } from "../../utils/toolUtils";
import type { TapAtArgs } from "../interactionToolTypes";

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
