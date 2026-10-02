import type { SwipeOnOptions } from "../../../models";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import type { BoomerangConfig } from "./types";

export const SWIPE_APEX_PAUSE_MIN_MS = 0;
export const SWIPE_RETURN_SPEED_EXCLUSIVE_MIN = 0;

type BoomerangOptions = Pick<SwipeOnOptions, "boomerang" | "apexPause" | "returnSpeed">;

/** Keep the speed presets in geometry, including its unset-speed default. */
export function resolveSwipeDuration(
  options: Pick<SwipeOnOptions, "duration" | "speed"> & {
    geometry: Pick<ElementGeometry, "getSwipeDurationFromSpeed">;
  },
): number {
  if (options.duration !== undefined) {
    return options.duration;
  }
  return options.geometry.getSwipeDurationFromSpeed(options.speed);
}

export function resolveBoomerangConfig(options: BoomerangOptions): BoomerangConfig | undefined {
  return options.boomerang
    ? { apexPauseMs: options.apexPause ?? 100, returnSpeed: options.returnSpeed ?? 1 }
    : undefined;
}

export function getReturnDuration(options: {
  forwardDuration: number;
  returnSpeed: number;
}): number {
  return Math.max(1, Math.round(options.forwardDuration / options.returnSpeed));
}

export function validateSwipeTimingOptions(
  options: BoomerangOptions & Pick<SwipeOnOptions, "lookFor">,
): string | null {
  if (options.boomerang && options.lookFor) {
    return "boomerang cannot be used with lookFor";
  }
  if (
    !options.boomerang &&
    (options.apexPause !== undefined || options.returnSpeed !== undefined)
  ) {
    return "apexPause/returnSpeed require boomerang=true";
  }
  if (options.apexPause !== undefined && options.apexPause < SWIPE_APEX_PAUSE_MIN_MS) {
    return "apexPause must be >= 0";
  }
  if (
    options.returnSpeed !== undefined &&
    options.returnSpeed <= SWIPE_RETURN_SPEED_EXCLUSIVE_MIN
  ) {
    return "returnSpeed must be > 0";
  }
  return null;
}
