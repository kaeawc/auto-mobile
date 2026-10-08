import { z } from "zod/v4";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  NETWORK_FILTER_APPROVAL_STEPS,
  NETWORK_FILTER_INSTALL_COMMAND,
  NETWORK_FILTER_RESTART_STEPS,
  type NetworkFilterInstallState,
  controllerPath,
} from "./networkFilterApp";
import type { NetworkFilterCommandOutcome, NetworkFilterCommandRunner } from "./networkFilterHost";

/**
 * The controller's own deadline is 8 s (`NetworkFilterController/main.swift`);
 * this outer bound only catches a controller that never exits.
 */
export const NETWORK_FILTER_CONTROLLER_TIMEOUT_MS = 30_000;

/** `ControllerResult` as encoded by `network-filter-controller` (one JSON line on stdout). */
const ControllerResultSchema = z.object({
  version: z.number().optional(),
  state: z.string(),
  detail: z.string(),
});

export type NetworkFilterControllerCommand = "activate" | "status";

export interface NetworkFilterControllerReport {
  state: NetworkFilterInstallState;
  /** The controller's raw `state`, or null when it produced no parseable result. */
  controllerState: string | null;
  detail: string;
  /** What the person has to do next, when anything. */
  nextSteps?: string;
}

function parseControllerResult(stdout: string): z.infer<typeof ControllerResultSchema> | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  const last = lines.at(-1);
  if (last === undefined) {
    return null;
  }
  try {
    const parsed = ControllerResultSchema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    // Non-JSON output falls through to the "no parseable result" failure reported by the caller.
    logger.debug(`[NETWORK_FILTER] controller output is not JSON: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Map the controller's JSON `state` to an install state, mirroring
 * `scripts/ios/build-network-filter-probe.sh activate` (#6897, #7041): the
 * controller exits 0 for both pending-approval cases and reports a pending
 * restart as `approval_required` whose detail mentions the restart.
 */
export function mapControllerOutcome(
  outcome: NetworkFilterCommandOutcome,
): NetworkFilterControllerReport {
  if (outcome.timedOut) {
    return {
      state: "unavailable",
      controllerState: null,
      detail:
        "network-filter-controller did not exit in time; activation may still have completed.",
      nextSteps: `Run \`${NETWORK_FILTER_INSTALL_COMMAND}\` again to reconcile.`,
    };
  }
  const result = parseControllerResult(outcome.stdout);
  if (result === null) {
    return {
      state: "failed",
      controllerState: null,
      detail:
        `network-filter-controller exited ${outcome.exitCode} without a JSON result` +
        (outcome.stderr.trim() ? `: ${outcome.stderr.trim()}` : "."),
    };
  }
  const report = { controllerState: result.state, detail: result.detail };
  switch (result.state) {
    case "ready":
      return outcome.exitCode === 0
        ? { ...report, state: "ready" }
        : { ...report, state: "failed" };
    case "approval_required":
      return /restart/i.test(result.detail)
        ? { ...report, state: "restart_required", nextSteps: NETWORK_FILTER_RESTART_STEPS }
        : { ...report, state: "approval_required", nextSteps: NETWORK_FILTER_APPROVAL_STEPS };
    case "unavailable":
      return { ...report, state: "unavailable" };
    default:
      // installation_required: the installed copy lacks its signing/provisioning.
      return { ...report, state: "failed" };
  }
}

export async function runNetworkFilterController(
  runner: NetworkFilterCommandRunner,
  appPath: string,
  command: NetworkFilterControllerCommand,
  timeoutMs: number = NETWORK_FILTER_CONTROLLER_TIMEOUT_MS,
): Promise<NetworkFilterControllerReport> {
  const outcome = await runner.run(controllerPath(appPath), [command], { timeoutMs });
  return mapControllerOutcome(outcome);
}
