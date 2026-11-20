import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";

/** simctl verbs whose failures this classifier understands. */
export type SimctlLifecycleVerb = "boot" | "shutdown" | "erase";

/**
 * A simctl failure, classified by its message text. The numeric code is not used:
 * the "current state" error has surfaced as 405, 163 and 165 across Xcode versions.
 */
export type SimctlFailure =
  /** The device is already in the state the verb asks for (e.g. boot on Booted). */
  | { kind: "already-in-target-state"; verb: SimctlLifecycleVerb; state: string }
  /** The device's state forbids the verb (e.g. erase on Booted). */
  | { kind: "state-conflict"; verb: SimctlLifecycleVerb; state: string }
  /** The device's data directory is gone; only erase (or delete) recovers it. */
  | { kind: "device-data-missing" }
  /** simctl does not know the device id or name. */
  | { kind: "unknown-device" }
  /**
   * CoreSimulator refused to boot another simulator because the host ran out of a
   * system resource (typically the `maxfiles` limit). Host-wide: other simulators
   * are affected too, so recovery is never automatic.
   */
  | { kind: "resource-exhaustion" }
  /**
   * The runtime's `launchd_sim` could not bind to its session, a runtime-version-dependent
   * boot timeout with no reliable trigger. Detected and reported, never induced.
   */
  | { kind: "launchd-sim-bind-failure" }
  | { kind: "unclassified" };

const TARGET_STATE: Partial<Record<SimctlLifecycleVerb, string>> = {
  boot: "Booted",
  shutdown: "Shutdown",
};

const CURRENT_STATE_PATTERN = /Unable to .+? in current state: (\w+)/;
const DATA_MISSING_PATTERN = /cannot be located on disk/;
const UNKNOWN_DEVICE_PATTERN = /^Invalid device or device pair: /m;
const RESOURCE_EXHAUSTION_PATTERN = /not sufficient to allow booting additional simulators/;
const LAUNCHD_SIM_BIND_PATTERN = /could not bind to session/;

/** Classify the text (stderr and/or message) of a failed simctl lifecycle command. */
export function classifySimctlFailure(verb: SimctlLifecycleVerb, output: string): SimctlFailure {
  if (DATA_MISSING_PATTERN.test(output)) {
    return { kind: "device-data-missing" };
  }
  if (RESOURCE_EXHAUSTION_PATTERN.test(output)) {
    return { kind: "resource-exhaustion" };
  }
  if (LAUNCHD_SIM_BIND_PATTERN.test(output)) {
    return { kind: "launchd-sim-bind-failure" };
  }
  const state = CURRENT_STATE_PATTERN.exec(output)?.[1];
  if (state) {
    return TARGET_STATE[verb] === state
      ? { kind: "already-in-target-state", verb, state }
      : { kind: "state-conflict", verb, state };
  }
  if (UNKNOWN_DEVICE_PATTERN.test(output)) {
    return { kind: "unknown-device" };
  }
  return { kind: "unclassified" };
}

export interface SimctlRecoveryOptions {
  /**
   * Allow recoveries that wipe the simulator's contents (erase). Off by default:
   * a caller must opt in, because erase destroys the device's apps and data.
   */
  allowDestructive: boolean;
}

export type SimctlRecoveryPlan =
  | { action: "treat-as-success"; state: string }
  | { action: "erase-and-retry" }
  | { action: "fail"; reason: string };

/** Map a classified failure to the recovery the harness should take. */
export function planSimctlRecovery(
  failure: SimctlFailure,
  options: SimctlRecoveryOptions,
): SimctlRecoveryPlan {
  switch (failure.kind) {
    case "already-in-target-state":
      return { action: "treat-as-success", state: failure.state };
    case "device-data-missing":
      return options.allowDestructive
        ? { action: "erase-and-retry" }
        : {
            action: "fail",
            reason:
              "the simulator's data is missing on disk; erasing it would recover the device, " +
              "but destructive recovery was not enabled",
          };
    case "state-conflict":
      return {
        action: "fail",
        reason: `simctl ${failure.verb} is not allowed while the simulator is ${failure.state}`,
      };
    case "unknown-device":
      return { action: "fail", reason: "simctl does not know this simulator" };
    case "resource-exhaustion":
      return {
        action: "fail",
        reason:
          "the host does not have enough resources (maxfiles) to boot another simulator; " +
          "relaunching CoreSimulatorService is host-wide and is never done automatically",
      };
    case "launchd-sim-bind-failure":
      return {
        action: "fail",
        reason:
          "launchd_sim could not bind to its session (a known simulator runtime boot timeout)",
      };
    case "unclassified":
      return { action: "fail", reason: "unrecognized simctl failure" };
  }
}

/** The simctl calls recovery needs. */
export interface SimctlRecoveryPort {
  run(verb: SimctlLifecycleVerb, udid: string): Promise<void>;
  erase(udid: string): Promise<void>;
}

export type SimctlRecoveryOutcome =
  | { status: "ok" }
  | { status: "already-in-target-state"; state: string }
  | { status: "recovered-by-erase" };

/** The stderr of an exec failure when present, followed by its message. */
export function simctlFailureText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const stderrText =
    typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : "";
  const message = errorMessage(error);
  return stderrText ? `${stderrText}\n${message}` : message;
}

const BOOT_FAILURE_GUIDANCE: Partial<Record<SimctlFailure["kind"], (udid: string) => string>> = {
  "device-data-missing": (udid) =>
    `Simulator ${udid} cannot boot because its data is missing on disk. ` +
    `Run 'xcrun simctl erase ${udid}' to recreate it (this deletes the simulator's apps and data), ` +
    "or delete the simulator and create a new one.",
  "resource-exhaustion": (udid) =>
    `Simulator ${udid} cannot boot because the host does not have enough resources to boot ` +
    "another simulator (CoreSimulator reported the maxfiles limit). Shut down simulators you are " +
    "not using ('xcrun simctl shutdown <udid>'), or raise the limit ('launchctl limit maxfiles'). " +
    "If the limit is already raised, relaunch the service with " +
    "'killall -9 com.apple.CoreSimulator.CoreSimulatorService'; this interrupts every simulator on the host.",
  "launchd-sim-bind-failure": (udid) =>
    `Simulator ${udid} failed to boot because launchd_sim could not bind to its session. ` +
    "This is a known simulator runtime boot timeout, not a problem with the device's data. " +
    `Shut it down ('xcrun simctl shutdown ${udid}') and boot it again; if it keeps failing, ` +
    "restart the host or try a different simulator runtime.",
};

/**
 * An actionable error naming the recovery for a boot failure this classifier recognizes
 * (missing on-disk data, host resource exhaustion, a `launchd_sim` bind failure), or
 * undefined for any other failure. Boot paths never apply these recoveries on their own:
 * erase destroys the device's apps and data, and relaunching CoreSimulatorService breaks
 * every simulator on the host, so the message tells the caller what to run instead.
 */
export function bootFailureGuidanceError(
  udid: string,
  error: unknown,
): ActionableError | undefined {
  const guidance =
    BOOT_FAILURE_GUIDANCE[classifySimctlFailure("boot", simctlFailureText(error)).kind];
  return guidance ? new ActionableError(guidance(udid), { cause: error }) : undefined;
}

/**
 * Run a simctl lifecycle verb and apply the recovery its failure text maps to:
 * an already-reached target state is success, and missing on-disk data is
 * erased and retried once when destructive recovery is enabled.
 */
export async function runSimctlWithRecovery(
  port: SimctlRecoveryPort,
  verb: SimctlLifecycleVerb,
  udid: string,
  options: SimctlRecoveryOptions,
): Promise<SimctlRecoveryOutcome> {
  // Resolve to the failure (or undefined) so the benign outcome is a plain return.
  const error = await port.run(verb, udid).then(
    () => undefined,
    (failure: unknown) => failure ?? new Error(`simctl ${verb} rejected without a reason`),
  );
  if (error === undefined) {
    return { status: "ok" };
  }
  const plan = planSimctlRecovery(classifySimctlFailure(verb, simctlFailureText(error)), options);
  if (plan.action === "treat-as-success") {
    return { status: "already-in-target-state", state: plan.state };
  }
  if (plan.action === "fail") {
    throw new ActionableError(`simctl ${verb} ${udid} failed: ${plan.reason}`, { cause: error });
  }
  logger.warn(`[simctl recovery] ${verb} ${udid}: device data missing on disk; erasing`, error);
  await port.erase(udid);
  try {
    await port.run(verb, udid);
  } catch (error) {
    throw new ActionableError(`simctl ${verb} ${udid} failed again after erase`, {
      cause: error,
    });
  }
  return { status: "recovered-by-erase" };
}
