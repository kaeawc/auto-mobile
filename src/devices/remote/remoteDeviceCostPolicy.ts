/**
 * Spending guards for remote device rental (#14054). Remote minutes are billed to the caller's
 * Google Cloud project, so nothing is reserved without an explicit opt-in and a per-session cap.
 */
import { ActionableError } from "../../models/ActionableError";

/** Android Device Streaming pricing as cited in #14054 (2026-10). */
export const DEVICE_STREAMING_PRICING = {
  freeMinutesPerProjectPerMonth: 30,
  usdPerMinute: 0.15,
} as const;

export interface RemoteDeviceGuards {
  /** Must be true before any session is created. */
  optIn: boolean;
  /** Upper bound on one session's total length, extensions included. */
  maxSessionMinutes: number;
}

export interface RemoteDeviceCostEstimate {
  minutes: number;
  usdPerMinute: number;
  /** Cost if no free minutes remain. The provider does not report free minutes already used. */
  maxUsd: number;
  freeMinutesPerProjectPerMonth: number;
}

export function estimateRemoteDeviceCost(minutes: number): RemoteDeviceCostEstimate {
  const { usdPerMinute, freeMinutesPerProjectPerMonth } = DEVICE_STREAMING_PRICING;
  return {
    minutes,
    usdPerMinute,
    maxUsd: Math.round(minutes * usdPerMinute * 100) / 100,
    freeMinutesPerProjectPerMonth,
  };
}

/**
 * Throws unless the caller opted in and the session's total length stays within the cap.
 * `sessionMinutes` is the whole session after this request, not just the added minutes.
 */
export function assertRemoteDeviceRequestAllowed(
  guards: RemoteDeviceGuards,
  requestedMinutes: number,
  sessionMinutes: number = requestedMinutes,
): void {
  if (!guards.optIn) {
    throw new ActionableError(
      "Remote device rental is billed to your Google Cloud project and is off by default. " +
        "Opt in explicitly before reserving a remote device.",
    );
  }
  if (!Number.isInteger(requestedMinutes) || requestedMinutes <= 0) {
    throw new ActionableError(
      `Remote device minutes must be a positive whole number, got ${requestedMinutes}.`,
    );
  }
  if (sessionMinutes > guards.maxSessionMinutes) {
    throw new ActionableError(
      `A ${sessionMinutes}-minute remote session exceeds the ${guards.maxSessionMinutes}-minute cap ` +
        `(up to $${estimateRemoteDeviceCost(sessionMinutes).maxUsd}). Request fewer minutes or raise the cap.`,
    );
  }
}
