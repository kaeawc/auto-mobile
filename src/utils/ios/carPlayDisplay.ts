import { ActionableError } from "../../models/ActionableError";
import { raceWithDeadline } from "../raceWithDeadline";
import type { Timer } from "../SystemTimer";
import type { CarPlayProjectionProbe, CarPlayProjectionState } from "./carPlayProjection";
import type { CarPlayHelperCallOptions, CarPlayScreenPowerer } from "./carPlayScreenPower";

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
  timer: Pick<Timer, "now" | "sleep" | "setTimeout" | "clearTimeout">;
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
 * Runs one helper call inside the request's bounds: the helper gets the signal and the remaining
 * budget (so its child is killed), and the race returns on abort or at the deadline even when a
 * helper does not honor them.
 */
async function withinBounds<T>(
  timer: CarPlayDisplayDependencies["timer"],
  bounds: CarPlayDisplayBounds,
  label: string,
  call: (options: CarPlayHelperCallOptions) => Promise<T>,
): Promise<T> {
  const remainingMs = bounds.deadlineMs - timer.now();
  if (remainingMs <= 0) {
    throw new ActionableError(`${label} timed out: the startDevice deadline has passed`);
  }
  return await raceWithDeadline(() => call({ signal: bounds.signal, timeoutMs: remainingMs }), {
    timer,
    timeoutMs: remainingMs,
    signal: bounds.signal,
    label,
  });
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
  await withinBounds(dependencies.timer, bounds, `CarPlay power-on on ${udid}`, (options) =>
    dependencies.powerer.powerOn(udid, options),
  );
  let state: CarPlayProjectionState | undefined;
  for (let attempt = 1; attempt <= CAR_DISPLAY_PROBE_ATTEMPTS; attempt++) {
    bounds.signal?.throwIfAborted();
    state = await withinBounds(dependencies.timer, bounds, `CarPlay probe on ${udid}`, (options) =>
      dependencies.probe.probe(udid, options),
    );
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
