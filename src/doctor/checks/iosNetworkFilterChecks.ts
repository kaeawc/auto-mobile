/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CheckResult, DoctorProbeOptions } from "../types";
import { awaitDoctorProbe, remainingDoctorProbe } from "../deadline";
import { errorMessage } from "../../utils/describeUnknownError";
import { DOCTOR_EXEC_TIMEOUT_MS } from "../../utils/diagnosticTimeouts";
import type { NetworkFilterHostStatus } from "../../features/networkFilter/NetworkFilterInstaller";
import { NETWORK_FILTER_INSTALL_COMMAND } from "../../features/networkFilter/networkFilterApp";
import { detectMdmEnrollment } from "./macMdmEnrollment";
import { createIosDoctorDependencies, type IosDoctorDependencies } from "./iosDoctorDependencies";

const IOS_NETWORK_FILTER_CHECK = "iOS Network Filter";

/**
 * Report the opt-in Network Extension app's state (#10588): not installed,
 * installed with a version mismatch, pending approval/restart, or ready. This
 * check is read-only; installing stays an explicit command.
 */
export async function checkIosNetworkFilter(
  dependencies: Pick<
    IosDoctorDependencies,
    "platform" | "logger" | "networkFilterInspector" | "execFile"
  > = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  const name = IOS_NETWORK_FILTER_CHECK;
  if (dependencies.platform() !== "darwin") {
    return { name, status: "skip", message: "Network Extension app only available on macOS" };
  }
  const inspector = dependencies.networkFilterInspector;
  if (!inspector) {
    return { name, status: "skip", message: "Network Extension status inspector not configured" };
  }
  let status: NetworkFilterHostStatus;
  try {
    const currentProbe = remainingDoctorProbe(probe);
    status = await awaitDoctorProbe(currentProbe, () =>
      inspector.inspect({
        timeoutMs: currentProbe.timeoutMs ?? DOCTOR_EXEC_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    dependencies.logger.warn(`Network filter check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "warn",
      message: `Network Extension status check failed: ${errorMessage(error)}`,
      recommendation: `Run \`${NETWORK_FILTER_INSTALL_COMMAND}\` to reinstall and reactivate it.`,
    };
  }
  return classifyNetworkFilterStatus(status, () => isMdmEnrolled(dependencies, probe));
}

/** Best-effort: a failed probe means "unknown", which is treated as not managed. */
async function isMdmEnrolled(
  dependencies: Pick<IosDoctorDependencies, "logger" | "execFile">,
  probe: DoctorProbeOptions,
): Promise<boolean> {
  try {
    const currentProbe = remainingDoctorProbe(probe);
    const enrollment = await awaitDoctorProbe(currentProbe, () =>
      detectMdmEnrollment(dependencies.execFile, {
        signal: currentProbe.signal,
        timeoutMs: currentProbe.timeoutMs ?? DOCTOR_EXEC_TIMEOUT_MS,
      }),
    );
    return enrollment.enrolled;
  } catch (error) {
    // Enrollment only tailors the hint; fall back to the generic System Settings steps.
    dependencies.logger.debug(`MDM enrollment probe failed: ${errorMessage(error)}`);
    return false;
  }
}

async function classifyNetworkFilterStatus(
  status: NetworkFilterHostStatus,
  isManaged: () => Promise<boolean>,
): Promise<CheckResult> {
  const name = IOS_NETWORK_FILTER_CHECK;
  if (!status.installed) {
    return {
      name,
      status: "skip",
      message: "Network Extension app not installed (optional; needed for iOS networkCondition)",
      value: "not_installed",
      detail: `Install it with \`${NETWORK_FILTER_INSTALL_COMMAND}\`.`,
    };
  }
  if (status.installedVersion !== status.expectedVersion) {
    return networkFilterVersionMismatch(status);
  }
  if (status.report?.state === "ready") {
    return {
      name,
      status: "pass",
      message: `Network Extension app ${status.expectedVersion} is active`,
      value: "ready",
    };
  }
  const state = status.report?.state;
  // `unavailable` is what the controller reports while approval is still pending.
  const pendingApproval = state === "approval_required" || state === "unavailable";
  return networkFilterNotReady(status.report, pendingApproval ? await isManaged() : null);
}

function networkFilterVersionMismatch(status: NetworkFilterHostStatus): CheckResult {
  const controllerState = status.report?.controllerState ?? status.report?.state;
  return {
    name: IOS_NETWORK_FILTER_CHECK,
    status: "warn",
    message:
      `Installed Network Extension app is version ${status.installedVersion ?? "unknown"}, ` +
      `expected ${status.expectedVersion}`,
    value: "version_mismatch",
    detail: controllerState ? `Controller state: ${controllerState}` : undefined,
    recommendation: `Run \`${NETWORK_FILTER_INSTALL_COMMAND} --upgrade\`.`,
  };
}

const NETWORK_FILTER_MANAGED_MACS_URL = "https://kaeawc.github.io/auto-mobile/using/managed-macs/";
const NETWORK_FILTER_MDM_PROFILE_PATH = "docs/assets/mdm/automobile-network-filter.mobileconfig";

/** `managed` is null when the state cannot be waiting on approval. */
function networkFilterNotReady(
  report: NetworkFilterHostStatus["report"],
  managed: boolean | null,
): CheckResult {
  const state = report?.state ?? "unknown";
  const base =
    report?.nextSteps ??
    `Run \`${NETWORK_FILTER_INSTALL_COMMAND}\` to activate it; macOS may then ask for approval in System Settings.`;
  let recommendation = base;
  if (managed === true) {
    recommendation =
      "This Mac is MDM-enrolled: ask your admin to pre-approve the filter with the " +
      `${NETWORK_FILTER_MDM_PROFILE_PATH} profile (see ${NETWORK_FILTER_MANAGED_MACS_URL}). ` +
      `Otherwise: ${base}`;
  } else if (managed === false) {
    recommendation = `${base} Managed Macs can pre-approve it via MDM: ${NETWORK_FILTER_MANAGED_MACS_URL}`;
  }
  return {
    name: IOS_NETWORK_FILTER_CHECK,
    status: "warn",
    message: `Network Extension app installed but not ready (${state})`,
    value: state,
    detail: report?.detail,
    recommendation,
  };
}
