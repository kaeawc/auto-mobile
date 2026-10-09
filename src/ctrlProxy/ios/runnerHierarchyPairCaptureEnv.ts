/**
 * Runner environment variable naming a host directory where a simulator runner
 * writes each `(xcuitest, sdk)` pair it feeds to `HierarchyMerger` (#5837). The
 * Swift side is `HierarchyPairFileRecorder`; simulators share the host
 * filesystem, so the files land directly in that directory.
 */
export const RUNNER_HIERARCHY_PAIR_DIR_ENV = "CTRL_PROXY_IOS_HIERARCHY_PAIR_DIR";

/**
 * Forwards the daemon's `CTRL_PROXY_IOS_HIERARCHY_PAIR_DIR` into the simulator
 * runner's xctestrun environment; unset or blank adds nothing.
 */
export function runnerHierarchyPairCaptureEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const value = env[RUNNER_HIERARCHY_PAIR_DIR_ENV]?.trim();
  return value ? { [RUNNER_HIERARCHY_PAIR_DIR_ENV]: value } : {};
}
