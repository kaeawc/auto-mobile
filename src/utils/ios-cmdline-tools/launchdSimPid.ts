import { errorMessage } from "../describeUnknownError";
import type { HostCommandExecutor } from "../HostCommandExecutor";
import { logger } from "../logger";
import { LAUNCHD_SIM_PROBE_TIMEOUT_MS } from "./SimCtlSupport";

/**
 * The `pgrep -f` pattern for a booted simulator's `launchd_sim`, whose command line names the
 * device's bootstrap plist. Every process inside the device descends from it.
 */
export function launchdSimPattern(udid: string): string {
  return `launchd_sim .*CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap[.]plist`;
}

/** The first PID in `pgrep` output, or undefined when there is none. */
export function parsePgrepPid(stdout: string): number | undefined {
  const pid = Number(stdout.trim().match(/^\d+$/m)?.[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** The PID of a booted simulator's `launchd_sim`, or undefined when it is not running. */
export async function findLaunchdSimPid(
  udid: string,
  executor: Pick<HostCommandExecutor, "executeCommand">,
): Promise<number | undefined> {
  try {
    const result = await executor.executeCommand("pgrep", ["-f", launchdSimPattern(udid)], {
      timeoutMs: LAUNCHD_SIM_PROBE_TIMEOUT_MS,
    });
    return parsePgrepPid(result.stdout);
  } catch (error) {
    // pgrep exits 1 when nothing matches: the simulator is not booted on this host.
    logger.debug(`[iOS] no launchd_sim process for ${udid}: ${errorMessage(error)}`);
    return undefined;
  }
}
