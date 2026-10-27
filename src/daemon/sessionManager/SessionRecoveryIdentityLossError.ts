import { ActionableError } from "../../models/ActionableError";
import { DEVICE_OWNED_BY_OTHER_DAEMON_CODE } from "../../models/deviceAcquisitionRefusals";
import {
  type SessionRecoveryFailureReason,
  type SessionRecoveryForeignOwner,
  type SessionRecoveryTarget,
} from "../sessionManager";
/**
 * The persisted target cannot be recovered without assigning an unrelated
 * device. SessionManager fences the UUID when this reaches it.
 */
export class SessionRecoveryIdentityLossError extends ActionableError {
  readonly terminalReleaseReason: string;
  /** Wire code when another live daemon holds the target (`device_owned_by_other_daemon`). */
  readonly code: string | undefined;
  readonly deviceId: string | undefined;
  readonly ownerPid: number | undefined;

  constructor(
    readonly sessionUuid: string,
    readonly target: SessionRecoveryTarget,
    readonly reason: SessionRecoveryFailureReason,
    foreignOwner?: SessionRecoveryForeignOwner,
  ) {
    super(
      `Cannot safely recover session ${sessionUuid}: ${target.platform} device ` +
        `'${target.stableDeviceId}' ${recoveryFailureDetail(reason, foreignOwner)} ` +
        `(recovery reason: ${reason}). ` +
        "The persisted session is terminal; " +
        "acquire a new device with getAndroid or getApple.",
    );
    this.name = "SessionRecoveryIdentityLossError";
    this.terminalReleaseReason = `identity-recovery-${reason}`;
    this.code = reason === "owned-by-other-daemon" ? DEVICE_OWNED_BY_OTHER_DAEMON_CODE : undefined;
    this.deviceId = foreignOwner?.deviceId;
    this.ownerPid = foreignOwner?.ownerPid;
  }
}
function recoveryFailureDetail(
  reason: SessionRecoveryFailureReason,
  foreignOwner: SessionRecoveryForeignOwner | undefined,
): string {
  switch (reason) {
    case "target-busy":
      return "is already in use";
    case "identity-continuity-lost":
      return "lost identity continuity";
    case "owned-by-other-daemon":
      return (
        "is claimed by another AutoMobile daemon" +
        (foreignOwner?.ownerPid === undefined ? "" : ` (PID ${foreignOwner.ownerPid})`) +
        ` (code ${DEVICE_OWNED_BY_OTHER_DAEMON_CODE})`
      );
    case "target-absent":
      return "is unavailable";
  }
}
