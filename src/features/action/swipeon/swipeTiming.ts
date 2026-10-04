import type { SwipeOnOptions } from "../../../models";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import type { BoomerangConfig } from "./types";

import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../../observe/shared/SharedGestureDelegate";
import { HOLD_DURATION_MAX_MS } from "../DragAndDrop";
import { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "../gestureTransportTimeout";
import { DefaultElementGeometry } from "../../utility/ElementGeometry";
import { ActionableError } from "../../../models/ActionableError";

// Leave transport headroom; every adb leg also stays below its 15s command timeout.
export const SWIPE_BOOMERANG_MAX_MS = DEFAULT_GESTURE_REQUEST_TIMEOUT_MS;
export const SWIPE_RETURN_DURATION_MAX_MS =
  DEFAULT_GESTURE_REQUEST_TIMEOUT_MS - LONG_PRESS_TIMEOUT_HEADROOM_MS;
export const SWIPE_APEX_PAUSE_MAX_MS = HOLD_DURATION_MAX_MS;
// Multipliers beyond this already collapse a maximum-length return leg to 1ms.
export const SWIPE_RETURN_SPEED_MAX = SWIPE_RETURN_DURATION_MAX_MS / 1;

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

/** The one rounding/minimum rule used by preflight validation and dispatch. */
function calculateReturnDuration(forwardDuration: number, returnSpeed: number): number {
  return Math.max(1, Math.round(forwardDuration / returnSpeed));
}

function returnDurationError(forwardDuration: number, returnSpeed: number): string | null {
  const duration = calculateReturnDuration(forwardDuration, returnSpeed);
  if (
    !Number.isFinite(forwardDuration) ||
    forwardDuration < 0 ||
    !Number.isFinite(returnSpeed) ||
    returnSpeed <= SWIPE_RETURN_SPEED_EXCLUSIVE_MIN ||
    returnSpeed > SWIPE_RETURN_SPEED_MAX ||
    !Number.isFinite(duration) ||
    duration > SWIPE_RETURN_DURATION_MAX_MS
  ) {
    return `returnSpeed must be finite, > 0 and <= ${SWIPE_RETURN_SPEED_MAX}, and produce a finite return duration <= ${SWIPE_RETURN_DURATION_MAX_MS}ms; increase returnSpeed or shorten the forward duration`;
  }
  return null;
}

export function getReturnDuration(options: {
  forwardDuration: number;
  returnSpeed: number;
}): number {
  const error = returnDurationError(options.forwardDuration, options.returnSpeed);
  if (error) {
    throw new ActionableError(error);
  }
  return calculateReturnDuration(options.forwardDuration, options.returnSpeed);
}

function validateBoomerangDuration(
  boomerang: BoomerangConfig,
  forwardDuration: number,
): string | null {
  if (
    !Number.isFinite(boomerang.apexPauseMs) ||
    boomerang.apexPauseMs < SWIPE_APEX_PAUSE_MIN_MS ||
    boomerang.apexPauseMs > SWIPE_APEX_PAUSE_MAX_MS
  ) {
    return `apexPause must be finite and >= 0 and <= ${SWIPE_APEX_PAUSE_MAX_MS}ms; shorten the apex pause`;
  }
  const error = returnDurationError(forwardDuration, boomerang.returnSpeed);
  if (error) {
    return error;
  }
  const returnDuration = getReturnDuration({ forwardDuration, returnSpeed: boomerang.returnSpeed });
  if (forwardDuration + boomerang.apexPauseMs + returnDuration > SWIPE_BOOMERANG_MAX_MS) {
    return `boomerang duration must be <= ${SWIPE_BOOMERANG_MAX_MS}ms; shorten duration/apexPause or increase returnSpeed`;
  }
  return null;
}

export function validateSwipeTimingOptions(
  options: BoomerangOptions & Pick<SwipeOnOptions, "lookFor" | "duration" | "speed">,
  forwardDuration = resolveSwipeDuration({ ...options, geometry: new DefaultElementGeometry() }),
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
  const boomerang = resolveBoomerangConfig(options);
  return boomerang ? validateBoomerangDuration(boomerang, forwardDuration) : null;
}
