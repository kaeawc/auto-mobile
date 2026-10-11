import type { BootedDevice } from "./DeviceInfo";

/** The `simctl` states a simulator passes through between `Shutdown` and `Booted`. */
export type TransitionalSimulatorState = "Booting" | "Shutting Down";

/**
 * A simulator `simctl list` reports mid-transition. It is not booted, so booted discovery omits
 * it, but a session that holds it (or a pool that tracks it) still owns it: inventory surfaces
 * show it with this state and count it as assigned, never idle (#11573).
 */
export interface TransitionalSimulator {
  device: BootedDevice;
  state: TransitionalSimulatorState;
}

export function isTransitionalSimulatorState(
  state: string | undefined,
): state is TransitionalSimulatorState {
  return state === "Booting" || state === "Shutting Down";
}
