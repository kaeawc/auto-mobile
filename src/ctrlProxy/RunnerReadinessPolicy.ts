export const READINESS_RETRY_DELAY_MS = 250;

export const IOS_RUNNER_SETUP_MAX_ATTEMPTS = 3;

// A fresh XCUITest snapshot can be slow: allow more than the 2s steady-state
// readiness probe, while leaving room for retries in the default 30s health window.
export const IOS_POST_SETUP_FIRST_PROBE_TIMEOUT_MS = 8_000;
export const IOS_POST_SETUP_RESTART_MIN_FAILED_PROBES = 3;

export const CTRL_PROXY_ENABLEMENT_VERIFY_BUDGET_MS = 5_000;

export const RUNNER_CONNECT_DIAGNOSTIC_TIMEOUT_MS = 2_000;

export const CTRL_PROXY_REBIND_RECOVERY_POLL_MS = 1_000;

/**
 * Minimum time to give a just-rebound accessibility service before escalating
 * to a full process restart (issue #7533 follow-up). A freshly re-bound
 * service on a loaded emulator can take well over a couple of seconds to
 * serve its first hierarchy; without this grace period the 1s rebind-recovery
 * cooldown alone let one slow-but-healthy probe (~2.3s after the rebind, once
 * the probe timeout is included) force-stop the service that had just been
 * repaired.
 */
export const CTRL_PROXY_POST_REBIND_RESTART_GRACE_MS = 5_000;

/**
 * Minimum number of consecutive failed health probes since the last rebind
 * before escalating to a full process restart (issue #7533 follow-up).
 * Pairs with the grace period above so a single unlucky probe miss cannot
 * trigger a restart on its own.
 */
export const CTRL_PROXY_RESTART_MIN_FAILED_PROBES = 2;

// Keep this aligned with ios/control-proxy/project.yml. The Swift rewrite uses
// iOS-17-only APIs, so trying to launch it on an older runtime can never make
// the runner healthy and must fail before setup/restart begins.
export const IOS_CTRL_PROXY_MINIMUM_IOS_VERSION = "17.0";
