const WATCH_OS_RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.watchOS-";

/**
 * Whether a CoreSimulator runtime identifier (a `simctl list devices --json` key) is an Apple
 * Watch runtime. Watch simulators are `platform: "watchos"`, never iOS
 * (docs/decisions/watchos-platform.md).
 */
export function isWatchOsSimulatorRuntime(runtimeId: string): boolean {
  return runtimeId.startsWith(WATCH_OS_RUNTIME_PREFIX);
}
