import {
  DAEMON_INSTANCE_CHANGED_CODE,
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
} from "../types";
import type { ReportedOwnerHold } from "../proxyLivenessRecovery";

/** The owner's hold a conflict refusal reports (#10701); absent from an older daemon. */
export function reportedOwnerHold(error: unknown): ReportedOwnerHold | undefined {
  if (error === null || typeof error !== "object" || !("livenessOwnerHold" in error)) {
    return undefined;
  }
  const hold = error.livenessOwnerHold;
  return hold !== null &&
    typeof hold === "object" &&
    "holdRemainingMs" in hold &&
    typeof hold.holdRemainingMs === "number"
    ? { holdRemainingMs: hold.holdRemainingMs }
    : undefined;
}

export function isLivenessOwnerConflictError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === DAEMON_LIVENESS_OWNER_CONFLICT_CODE
  );
}

/** A probe heartbeat reached a daemon process other than the one that stalled (#10989). */
export function isDaemonInstanceChangedError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === DAEMON_INSTANCE_CHANGED_CODE
  );
}

/** The daemon process a heartbeat acknowledgement reports, when it reports one (#10989). */
export function ackDaemonInstance(ack: unknown): string | undefined {
  return ack !== null &&
    typeof ack === "object" &&
    "daemonInstance" in ack &&
    typeof ack.daemonInstance === "string" &&
    ack.daemonInstance.length > 0
    ? ack.daemonInstance
    : undefined;
}

/** The daemon answered that this token no longer owns liveness (#10050, #10260). */
export function isLivenessOwnershipLostError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE ||
      error.code === DAEMON_LIVENESS_OWNER_UNOWNED_CODE)
  );
}
