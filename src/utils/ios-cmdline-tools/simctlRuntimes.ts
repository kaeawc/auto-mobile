import type { AppleDeviceRuntime } from "./SimCtlClient";

/**
 * Which runtimes survive parsing. `listed` keeps everything simctl returned,
 * `not-unavailable` drops only an explicit `isAvailable: false`, and `available`
 * requires a truthy `isAvailable`.
 */
export type SimctlRuntimeFilter = "listed" | "not-unavailable" | "available";

/**
 * Parses `xcrun simctl list runtimes [iOS] --json`; the one place its stdout is parsed.
 * Throws on malformed JSON or a missing `runtimes` array so callers report the failure.
 */
export function parseSimctlRuntimes(
  stdout: string,
  filter: SimctlRuntimeFilter = "listed",
): AppleDeviceRuntime[] {
  const data = JSON.parse(stdout) as { runtimes?: unknown } | null;
  if (!Array.isArray(data?.runtimes)) {
    throw new Error("simctl runtimes response does not contain a runtimes array");
  }
  const runtimes = data.runtimes as AppleDeviceRuntime[];
  switch (filter) {
    case "not-unavailable":
      return runtimes.filter((runtime) => runtime.isAvailable !== false);
    case "available":
      return runtimes.filter((runtime) => runtime.isAvailable);
    case "listed":
      return runtimes;
  }
}
