import type { LivenessLeaseState } from "./livenessOwnerLease";
import { DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS } from "./inputDeviceOwnership";
import { DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS, SUSPECT_GRACE_MS } from "./sessionLivenessWindows";

/** Combine existing release evidence without changing ownership, timers or session clocks. */
export function holderReleaseRemainingMs(input: {
  disconnectRemainingMs: number | undefined;
  ownerLease: LivenessLeaseState | undefined;
  releasing: boolean;
}): number | undefined {
  const bounds = [
    input.disconnectRemainingMs,
    input.ownerLease?.phase === "suspect" ? input.ownerLease.remainingMs : undefined,
    input.releasing ? DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS : undefined,
  ].filter((bound): bound is number => bound !== undefined);
  if (bounds.length === 0) {
    return undefined;
  }
  return Math.max(
    1,
    Math.min(
      DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS,
      Math.ceil(Math.min(...bounds)),
    ),
  );
}
