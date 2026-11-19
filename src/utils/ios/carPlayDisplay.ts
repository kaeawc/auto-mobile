import { ActionableError } from "../../models/ActionableError";
import type { Timer } from "../SystemTimer";
import type { CarPlayProjectionProbe, CarPlayProjectionState } from "./carPlayProjection";
import type { CarPlayScreenPowerer } from "./carPlayScreenPower";

/** What startDevice reports once the simulator's CarPlay screen is the car display. */
export interface CarPlayDisplayReport {
  /** The probe's display identity, e.g. `Car[2]`. */
  display: string;
  /** The simulator screen id of the car display, as the probe reports it. */
  displayId: number;
}

export interface CarPlayDisplayDependencies {
  powerer: CarPlayScreenPowerer;
  probe: CarPlayProjectionProbe;
  timer: Pick<Timer, "now" | "sleep">;
}

export interface CarPlayDisplayBounds {
  signal?: AbortSignal;
  /** Absolute deadline on `timer.now()`'s clock. */
  deadlineMs: number;
}

/** The display can take a moment to take the car tag after the mode change returns. */
export const CAR_DISPLAY_PROBE_INTERVAL_MS = 500;
export const CAR_DISPLAY_PROBE_ATTEMPTS = 10;

function isCarDisplay(state: CarPlayProjectionState): state is CarPlayProjectionState & {
  found: true;
} {
  return state.found && state.isCarDisplay;
}

function notCarMessage(udid: string, state: CarPlayProjectionState): string {
  const seen = state.found
    ? `the CarPlay screen is ${state.identity} (${state.name}), not the car display`
    : "no CarPlay screen (TVOut or AirPlay display) was found";
  return `CarPlay power-on finished on ${udid}, but ${seen}. Reboot the simulator and request carPlay again; it needs an iOS 26.x iPhone simulator from Xcode 26.x.`;
}

/**
 * Makes an iOS 26.x simulator's TVOut screen the CarPlay car display (#18820) and confirms it
 * with the projection probe. CoreSimulator resets the display config on every boot, so this runs
 * on each request, after the device is ready; running it on a display that is already the car
 * display is harmless. Helper failures (including `[unsupported-runtime]` on iOS 27+) propagate
 * with their message unchanged.
 */
export async function activateCarPlayDisplay(
  udid: string,
  dependencies: CarPlayDisplayDependencies,
  bounds: CarPlayDisplayBounds,
): Promise<CarPlayDisplayReport> {
  bounds.signal?.throwIfAborted();
  await dependencies.powerer.powerOn(udid);
  let state: CarPlayProjectionState | undefined;
  for (let attempt = 1; attempt <= CAR_DISPLAY_PROBE_ATTEMPTS; attempt++) {
    bounds.signal?.throwIfAborted();
    state = await dependencies.probe.probe(udid);
    if (isCarDisplay(state)) {
      return { display: state.identity, displayId: state.displayId };
    }
    const lastAttempt = attempt === CAR_DISPLAY_PROBE_ATTEMPTS;
    if (
      lastAttempt ||
      dependencies.timer.now() + CAR_DISPLAY_PROBE_INTERVAL_MS > bounds.deadlineMs
    ) {
      break;
    }
    await dependencies.timer.sleep(CAR_DISPLAY_PROBE_INTERVAL_MS);
  }
  throw new ActionableError(notCarMessage(udid, state as CarPlayProjectionState));
}
