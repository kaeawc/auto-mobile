import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { ActionableError, type BootedDevice, type ExecResult } from "../../models";
import { redactAndroidCommandOutput } from "./redactAndroidCommandOutput";
import type {
  BootedDeviceScan,
  ReadinessDiagnostic,
  ReadinessDiagnosticPhase,
} from "./AndroidDeviceInventoryScanner";

/**
 * Pure readiness evaluation and diagnostics for AndroidEmulatorClient.waitForEmulatorReady.
 * No I/O, clocks or client state: moved verbatim out of the client (#11851).
 */

const READINESS_NAME_CANDIDATES_PER_ITERATION = 4;
const MAX_READINESS_DIAGNOSTIC_CHARS = 512;

export type TargetReadinessState = "absent" | "offline" | "not-ready";

export function readinessTimeoutError(
  avdName: string,
  timeoutMs: number,
  processExitError: ActionableError | null,
  correlationFailure?: string,
  diagnostic?: ReadinessDiagnostic,
  target?: { deviceId: string; state: TargetReadinessState },
): ActionableError {
  if (processExitError) {
    return processExitError;
  }
  const details = [
    correlationFailure ?? `Emulator '${avdName}' failed to become ready within ${timeoutMs}ms`,
    target ? `target=${target.deviceId}; state=${target.state}` : "",
    diagnostic
      ? `Last readiness diagnostic: phase=${diagnostic.phase}; summary=${diagnostic.summary}`
      : "",
  ].filter(Boolean);
  return new ActionableError(details.join("\n"));
}

export function readinessDiagnostic(
  phase: ReadinessDiagnosticPhase,
  error: unknown,
  deviceId?: string,
): ReadinessDiagnostic {
  const redacted = redactAndroidCommandOutput(errorMessage(error)).replace(/\s+/g, " ").trim();
  const summary =
    redacted.length <= MAX_READINESS_DIAGNOSTIC_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_READINESS_DIAGNOSTIC_CHARS - 16)} [... truncated]`;
  return { phase, summary, deviceId };
}

export function readinessTarget(
  deviceId: string | undefined,
  tracker: { state?: TargetReadinessState },
): { deviceId: string; state: TargetReadinessState } | undefined {
  return deviceId && tracker.state ? { deviceId, state: tracker.state } : undefined;
}

export function nextReadinessNameCandidates(
  devices: BootedDevice[],
  probedSerials: Set<string>,
  unresolvedSerials: Set<string>,
): BootedDevice[] {
  const emulatorCandidates = devices.filter((device) => device.deviceId.startsWith("emulator-"));
  let unprobed = emulatorCandidates.filter((device) => !probedSerials.has(device.deviceId));
  if (unprobed.length === 0) {
    probedSerials.clear();
    unresolvedSerials.clear();
    unprobed = emulatorCandidates;
  }
  // A failed name can be retried while discovery advances, but it may occupy
  // only one slot so new serials cannot be starved by unresolved names.
  const retry = emulatorCandidates.find((device) => unresolvedSerials.has(device.deviceId));
  const selected = unprobed.slice(0, READINESS_NAME_CANDIDATES_PER_ITERATION - (retry ? 1 : 0));
  if (retry) {
    selected.push(retry);
    unresolvedSerials.delete(retry.deviceId);
  }
  for (const device of selected) {
    probedSerials.add(device.deviceId);
  }
  return selected;
}

export function retryUnresolvedReadinessNames(
  devices: BootedDevice[],
  unresolvedSerials: Set<string>,
): void {
  for (const device of devices) {
    if (device.name === unknownEmulatorName(device.deviceId)) {
      unresolvedSerials.add(device.deviceId);
    }
  }
}

export function relevantScanDiagnostic(
  scan: BootedDeviceScan,
  targetDeviceId: string | undefined,
): ReadinessDiagnostic | undefined {
  return scan.diagnostics.findLast(
    (diagnostic) => !targetDeviceId || diagnostic.deviceId === targetDeviceId,
  );
}

/**
 * Returns the first readiness predicate the probed device fails, or undefined when
 * every required Android readiness signal is satisfied.
 */
export function unmetReadinessPredicate(
  deviceId: string,
  stateOutput: string,
  packageManager: ExecResult,
  sysBootCompleted: string,
  bootAnimationState: string,
): ReadinessDiagnostic | undefined {
  if (!stateOutput.includes("device")) {
    return unmetReadinessDiagnostic(
      "device-state",
      "adb get-state did not report 'device'",
      stateOutput,
      deviceId,
    );
  }
  // Only an explicit package-manager "Failure" blocks readiness. A non-empty stderr
  // on its own is routinely benign (linker and ART warnings on a healthy device) and
  // used to keep a fully booted emulator not-ready forever. See #6818.
  // Checked BEFORE the empty-listing branch: the real failure shape is an empty
  // stdout plus the reason on stderr, and reporting that as `observed=""` would
  // throw away the only actionable detail the timeout error carries.
  if (packageManager.stderr.includes("Failure")) {
    return unmetReadinessDiagnostic(
      "package-manager",
      "pm list packages reported a failure",
      packageManager.stderr.trim(),
      deviceId,
    );
  }
  if (!packageManager.stdout.includes("package:")) {
    // With no listing on stdout there is nothing benign for stderr to be noise
    // about, and the boot-time shape carries the reason there — e.g.
    // `cmd: Can't find service: package` while the package service is still
    // coming up. Prefer it over the vacuous `observed=""` (#6818).
    const stderr = packageManager.stderr.trim();
    return unmetReadinessDiagnostic(
      "package-manager",
      "pm list packages returned no 'package:' entries",
      stderr.length > 0 ? stderr : packageManager.stdout.trim(),
      deviceId,
    );
  }
  if (sysBootCompleted !== "1") {
    return unmetReadinessDiagnostic(
      "system-boot-complete",
      "sys.boot_completed is not 1",
      sysBootCompleted,
      deviceId,
    );
  }
  if (bootAnimationState && bootAnimationState !== "stopped") {
    return unmetReadinessDiagnostic(
      "boot-animation",
      "init.svc.bootanim has not stopped",
      bootAnimationState,
      deviceId,
    );
  }
  return undefined;
}

/**
 * Records an unmet readiness predicate with the value actually observed, so the
 * readiness timeout error names the exact check that never passed (#6818).
 */
export function unmetReadinessDiagnostic(
  phase: ReadinessDiagnosticPhase,
  check: string,
  observed: string,
  deviceId: string,
): ReadinessDiagnostic {
  const diagnostic = readinessDiagnostic(phase, `${check}; observed="${observed}"`, deviceId);
  logger.debug(`[PARALLEL] ❌ ${deviceId} not ready: ${diagnostic.summary}`);
  return diagnostic;
}

export function rejectedReadinessDiagnostic(
  checks: Array<[ReadinessDiagnosticPhase, PromiseSettledResult<ExecResult>]>,
): ReadinessDiagnostic | undefined {
  const rejected = checks.findLast((entry) => entry[1].status === "rejected");
  if (!rejected || rejected[1].status !== "rejected") {
    return undefined;
  }
  return readinessDiagnostic(rejected[0], rejected[1].reason);
}

export function unknownEmulatorName(deviceId: string): string {
  return `Unknown (${deviceId})`;
}

export function isUnknownEmulatorName(name: string, deviceId: string): boolean {
  return name === unknownEmulatorName(deviceId);
}

export function matchesRequestedAvdOrUnknown(
  emulator: BootedDevice,
  avdName: string,
  targetDeviceId?: string,
): boolean {
  if (targetDeviceId === emulator.deviceId && !targetDeviceId.startsWith("emulator-")) {
    return true;
  }

  return (
    emulator.name === avdName ||
    isUnknownEmulatorName(emulator.name, emulator.deviceId) ||
    (targetDeviceId === emulator.deviceId && isUnknownEmulatorName(avdName, targetDeviceId))
  );
}
