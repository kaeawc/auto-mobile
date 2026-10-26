/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CheckResult, DoctorProbeOptions } from "../types";
import { remainingDoctorProbe } from "../deadline";
import { errorMessage } from "../../utils/describeUnknownError";
import { resolveAssetVersion, resolvePinnedVersion } from "../../constants/release";
import { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { getRequiredIosRunnerFeatureFlags } from "../../features/observe/ios/IOSCtrlProxyClient";
import {
  getMissingIosRunnerFeatureCommands,
  type IosRunnerCommandRequirements,
} from "../../features/observe/ios/iosRunnerFeatureCommands";
import type { IosRunnerInspection, IosObserveRoundTripInspection } from "./iosRunnerInspectors";
import { createIosDoctorDependencies } from "./iosDoctorDependencies";

const IOS_RUNNER_REBUILD_RECOMMENDATION =
  "Rebuild and redeploy the iOS CtrlProxy runner: run scripts/ios/ctrl-proxy-build-for-testing.sh " +
  "— its output lands in the default derived-data path (set AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA " +
  "to the derived-data root only when building to a non-default location). Start the daemon with " +
  "AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD=true so a missing/mismatched cached bundle metadata does not " +
  "download the released runner over your build. Alternatively, run the iOS hot-reload watcher with " +
  "--manage-ios-runner.";

type IosRunnerVersionStatus = "compatible" | "stale" | "unknown";

interface IosRunnerClassification {
  status: IosRunnerVersionStatus;
  missingCommands: string[];
  missingFeatures: string[];
  line: string;
}

function classifyRunner(
  inspection: IosRunnerInspection,
  expectedVersion: string,
  requirements?: IosRunnerCommandRequirements,
): IosRunnerClassification {
  let status: IosRunnerVersionStatus;
  let missingCommands: string[] = [];
  let missingFeatures: string[] = [];

  if (!inspection.installed) {
    status = "unknown";
  } else if (!inspection.running) {
    status = "unknown";
  } else if (inspection.supportedCommands === null) {
    status = "unknown";
  } else {
    const advertised = new Set(inspection.supportedCommands);
    missingCommands = getMissingIosRunnerFeatureCommands(
      advertised,
      inspection.environment ?? "simulator",
      requirements,
    );
    // supportedFeatures === null is the immutable 0.0.66 IPA, which predates the
    // feature handshake and cannot advertise feature flags at all. Grandfather
    // it: the required-flag gate (getRequiredIosRunnerFeatureFlags, min release
    // 0.0.67) applies to runners built from handshake-aware source, which report
    // a (possibly empty) feature list. Treating null as "advertises nothing"
    // would wrongly flag every pre-handshake runner stale the moment the
    // pipeline cut 0.0.67.
    if (inspection.supportedFeatures !== null) {
      const advertisedFeatures = new Set(inspection.supportedFeatures);
      missingFeatures = getRequiredIosRunnerFeatureFlags().filter(
        (feature) => !advertisedFeatures.has(feature),
      );
    }
    status = missingCommands.length === 0 && missingFeatures.length === 0 ? "compatible" : "stale";
  }

  const parts = [
    "platform=ios",
    `device=${inspection.deviceId}`,
    `installed=${inspection.installed}`,
    `running=${inspection.running}`,
    `expectedVersion=${expectedVersion}`,
    `versionStatus=${status}`,
  ];
  if (missingCommands.length > 0) {
    parts.push(`missingCommands=${missingCommands.join(",")}`);
  }
  if (missingFeatures.length > 0) {
    parts.push(`missingFeatures=${missingFeatures.join(",")}`);
  }

  return { status, missingCommands, missingFeatures, line: parts.join("; ") };
}

interface IosObserveRoundTripClassification {
  failed: boolean;
  /** No runner was running to ask, so nothing was probed on this simulator (#15310). */
  notProbed: boolean;
  line: string;
}

function classifyObserveRoundTrip(
  inspection: IosObserveRoundTripInspection,
  targetDeviceId: string | undefined,
): IosObserveRoundTripClassification {
  const hasDegenerateScreen = inspection.screenSize.width <= 0 || inspection.screenSize.height <= 0;
  const hasHierarchyError =
    inspection.hierarchyError !== null && inspection.hierarchyError.trim().length > 0;
  const hasNoElements = inspection.elementCount < 1;
  // A per-device host port legitimately differs from the runner's self-reported
  // internal port when multiple simulators each run their own CtrlProxy (issue
  // #5636): the runner always advertises its fixed on-device port (8765) via
  // /health, while the client reaches it through a unique forwarded host port
  // (8767, …). So runnerPort vs clientPort is only diagnostic context in the
  // reported line — never an independent failure. A round trip that actually
  // completed (connected, non-degenerate, error-free, non-empty) passes despite
  // the divergence, and a genuine wrong-port bind (issue #2731) still fails here
  // because it cannot connect (connected=false) and surfaces a hierarchyError.
  const unhealthy =
    !inspection.connected || hasDegenerateScreen || hasHierarchyError || hasNoElements;
  // Without a requested simulator, one with no running runner is a bystander (e.g. a CI simulator
  // another tool owns): doctor sent it nothing, so it warns instead of failing the round trip.
  // An explicitly requested simulator still fails.
  const notProbed = unhealthy && inspection.probed === false && targetDeviceId === undefined;
  const failed = unhealthy && !notProbed;

  const parts = [
    "platform=ios",
    `device=${inspection.deviceId}`,
    `runnerPort=${inspection.runnerPort}`,
    `clientPort=${inspection.clientPort}`,
    `connected=${inspection.connected}`,
    `screenSize=${inspection.screenSize.width}x${inspection.screenSize.height}`,
    `elementCount=${inspection.elementCount}`,
    `hierarchyStatus=${hasHierarchyError ? "error" : "ok"}`,
  ];
  if (inspection.hierarchyError) {
    parts.push(`hierarchyError=${inspection.hierarchyError}`);
  }

  if (notProbed) {
    parts.push("notProbed=true");
  }

  return { failed, notProbed, line: parts.join("; ") };
}

/**
 * Check the iOS CtrlProxy runner on each booted simulator, mirroring the Android
 * CtrlProxy check. Reports installed/running, the expected pinned runner version,
 * and a `versionStatus` derived from the runner's advertised feature command set
 * so a stale runner (e.g. released v0.0.38) is flagged with remediation instead of
 * silently passing.
 */
export async function checkIosCtrlProxyRunner(
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
  targetDeviceId?: string,
): Promise<CheckResult> {
  const name = "iOS CtrlProxy Runner";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "iOS simulators only available on macOS",
    };
  }

  try {
    const inspections = await dependencies.runnerInspector.inspectBootedRunners(
      targetDeviceId,
      remainingDoctorProbe(probe),
    );

    if (inspections.length === 0) {
      return {
        name,
        status: targetDeviceId === undefined ? "skip" : "fail",
        message:
          targetDeviceId === undefined
            ? "No booted simulators to check"
            : `Requested simulator is not booted: ${targetDeviceId}`,
      };
    }

    // An unverifiable explicit pin is a hard configuration failure — classifyRunner
    // only checks the advertised command set, so without this a running runner would
    // still report `pass` and leave the `doctor --ios` hermetic gate green (#2746).
    if (IosCtrlProxyBuilder.isPinnedVersionUnverifiable()) {
      return {
        name,
        status: "fail",
        message: `AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the release checksum registry`,
        recommendation:
          "The pinned CtrlProxy bundle cannot be integrity-verified. Pin a released version, or vendor a trusted bundle via AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH.",
      };
    }

    // Honor AUTOMOBILE_VERSION so a pinned runner is not falsely flagged "stale"
    // against the newest registry entry (#2746).
    const expectedVersion = resolveAssetVersion(resolvePinnedVersion());
    const classifications = inspections.map((inspection) =>
      classifyRunner(inspection, expectedVersion, dependencies.runnerCommandRequirements),
    );

    const message = classifications.map((classification) => classification.line).join(" | ");
    const hasStale = classifications.some((classification) => classification.status === "stale");
    const hasUnknown = classifications.some(
      (classification) => classification.status === "unknown",
    );

    if (hasStale) {
      return {
        name,
        status: "warn",
        message,
        recommendation: IOS_RUNNER_REBUILD_RECOMMENDATION,
      };
    }

    if (hasUnknown) {
      return {
        name,
        status: "warn",
        message,
        recommendation:
          "Could not confirm the iOS CtrlProxy runner identity. Ensure the runner is installed and " +
          `running, then re-run doctor. ${IOS_RUNNER_REBUILD_RECOMMENDATION}`,
      };
    }

    return {
      name,
      status: "pass",
      message,
    };
  } catch (error) {
    dependencies.logger.warn(`iOS CtrlProxy runner check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "skip",
      message: `Could not check iOS CtrlProxy runner: ${errorMessage(error)}`,
    };
  }
}

/**
 * Exercise the daemon/client-to-runner path that `observe` depends on. This is a
 * hard failure when a booted iOS simulator cannot return a non-degenerate
 * hierarchy, because otherwise doctor reports green for the exact broken state
 * users need it to diagnose.
 */
export async function checkIosObserveRoundTrip(
  dependencies = createIosDoctorDependencies(),
  probe: DoctorProbeOptions = {},
  targetDeviceId?: string,
): Promise<CheckResult> {
  const name = "iOS Observe Round Trip";

  if (dependencies.platform() !== "darwin") {
    return {
      name,
      status: "skip",
      message: "iOS simulators only available on macOS",
    };
  }

  try {
    const inspections = await dependencies.observeRoundTripInspector.inspectBootedObserveRoundTrips(
      targetDeviceId,
      remainingDoctorProbe(probe),
    );

    if (inspections.length === 0) {
      return {
        name,
        status: targetDeviceId === undefined ? "skip" : "fail",
        message:
          targetDeviceId === undefined
            ? "No booted simulators to check"
            : `Requested simulator is not booted: ${targetDeviceId}`,
      };
    }

    const classifications = inspections.map((inspection) =>
      classifyObserveRoundTrip(inspection, targetDeviceId),
    );
    const message = classifications.map((classification) => classification.line).join(" | ");
    const hasFailure = classifications.some((classification) => classification.failed);

    if (hasFailure) {
      return {
        name,
        status: "fail",
        message,
        recommendation:
          "Restart the AutoMobile daemon and iOS CtrlProxy runner, then confirm each simulator's runner is " +
          "reachable through its assigned client endpoint and returns a non-empty hierarchy, and re-run: " +
          "auto-mobile --doctor --ios.",
      };
    }

    if (classifications.some((classification) => classification.notProbed)) {
      return {
        name,
        status: "warn",
        message,
        recommendation:
          "A booted simulator has no running iOS CtrlProxy runner, so doctor did not probe it. " +
          "Pass --device <udid> to require its round trip, or start its runner.",
      };
    }

    return {
      name,
      status: "pass",
      message,
    };
  } catch (error) {
    dependencies.logger.warn(`iOS observe round-trip check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "fail",
      message: `Could not check iOS observe round trip: ${errorMessage(error)}`,
      recommendation:
        "Restart the AutoMobile daemon and iOS CtrlProxy runner, then re-run: auto-mobile --doctor --ios.",
    };
  }
}

/**
 * Run all iOS checks
 */
