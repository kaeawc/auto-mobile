/**
 * Runner environment variable holding XCTest's per-attempt live-query timeout in
 * seconds, or "off" to keep XCTest's 30 s default. The runner defaults to 2 s
 * when it is unset, so a query against a suspended app fails in seconds instead
 * of holding the runner for about 92 s (#10640).
 */
export const RUNNER_QUERY_TIMEOUT_ENV = "CTRL_PROXY_IOS_QUERY_TIMEOUT";

/**
 * Forwards the daemon's `CTRL_PROXY_IOS_QUERY_TIMEOUT` into the runner's
 * xctestrun environment. The runner cannot see the host env, so an override
 * only reaches it through this entry; unset or blank adds nothing.
 */
export function runnerQueryTimeoutEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const value = env[RUNNER_QUERY_TIMEOUT_ENV]?.trim();
  return value ? { [RUNNER_QUERY_TIMEOUT_ENV]: value } : {};
}
