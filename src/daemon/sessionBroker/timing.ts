/** Idle interval between recovery passes, including adoption of restart handoffs. */
export const SESSION_BROKER_RECOVERY_INTERVAL_MS = 5_000;

/** Give the successor daemon a recovery opportunity before retrying a transient refusal. */
export const SESSION_BROKER_RETRY_AFTER_MS = SESSION_BROKER_RECOVERY_INTERVAL_MS;
