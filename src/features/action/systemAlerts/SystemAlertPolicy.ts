export const SYSTEM_ALERT_POLICIES = ["report", "allow", "deny", "allowOnce"] as const;

/**
 * How AutoMobile answers an OS permission or system alert found before an interaction (#14106):
 * `report` never taps and only surfaces it, `allow`/`deny` tap the grant/refuse button, and
 * `allowOnce` prefers a one-time grant where the alert offers one.
 */
export type SystemAlertPolicyName = (typeof SYSTEM_ALERT_POLICIES)[number];

/** Answers a specific alert: tap the `buttonText` button, only on alerts containing `textContains`. */
export interface SystemAlertMatch {
  textContains?: string;
  buttonText: string;
}

export interface SystemAlertPolicy {
  policy: SystemAlertPolicyName;
  match: SystemAlertMatch[];
  /** The session whose release clears the policy; undefined for a sessionless policy. */
  owner?: string;
}

/**
 * The per-device system-alert policy (#14106). In memory only: a daemon restart drops it. A policy
 * set under a session belongs to that session and is cleared when it releases or moves off the
 * device; a sessionless policy stays until `clear` or the device is retired.
 */
export class SystemAlertPolicyRegistry {
  private readonly policies = new Map<string, SystemAlertPolicy>();

  set(deviceId: string, policy: SystemAlertPolicy): void {
    this.policies.set(deviceId, { ...policy, match: [...policy.match] });
  }

  get(deviceId: string): SystemAlertPolicy | undefined {
    return this.policies.get(deviceId);
  }

  clear(deviceId: string): boolean {
    return this.policies.delete(deviceId);
  }

  /** Clear the device's policy if `sessionId` set it; returns whether one was cleared. */
  clearOwnedBy(deviceId: string, sessionId: string): boolean {
    if (this.policies.get(deviceId)?.owner !== sessionId) {
      return false;
    }
    return this.policies.delete(deviceId);
  }

  /** The device is gone (or its serial now names another device). */
  retireDevice(deviceId: string): void {
    this.policies.delete(deviceId);
  }
}

export const defaultSystemAlertPolicyRegistry = new SystemAlertPolicyRegistry();
