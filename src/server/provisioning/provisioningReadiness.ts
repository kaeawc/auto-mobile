import { disabledDeviceResourceReport } from "../../utils/iosDeviceResourceImpact";
import { mergeProvenResourceStates } from "../../utils/deviceResourceStates";
import { observeConfiguredDeviceResources } from "../deviceResourceTools";
import { computeDeviceResourceDrift } from "../../utils/deviceResourceDrift";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import type { DeviceResourceConfigurationResult } from "../../models/DeviceResourceConfiguration";
import { BootedDevice, DeviceInfo } from "../../models";
import { defaultDaemonContext } from "../../daemon/daemonContext";
import { describeDevice, projectProvisionedDevice } from "../../daemon/deviceDescription";
import { createPerformanceTracker } from "../../utils/PerformanceTracker";
import { requestAcquisitionReceipt } from "../../daemon/acquisitionReceipt";
import type { DeviceReadinessReservation } from "../../daemon/devicePool";
import { type DeviceBootResult } from "../../devices/deviceBootService";
import { serverConfig } from "../../utils/ServerConfig";
import { START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS } from "../../utils/deviceTimeouts";
import {
  type ExactDeviceProvisioner,
  ProvisionDeviceError,
} from "../../devices/exactDeviceProvisioning";
import { type VirtualDeviceLifecycleLease } from "../../devices/virtualDeviceLifecycleCoordinator";
import { classifyDisplayCutout } from "../../utils/displayCutout";
import { restartResumeSessionForDevice } from "../deviceToolsStartDevice";
import {
  DeviceToolsDependencies,
  ProvisionDeviceArgs,
  initializedDevicePool,
  rollBackUndeliveredBoot,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import { type ProvisionBootOptions, type ProvisioningContext } from "./provisioningTypes";
import { provisionSessionArgs } from "./provisioningSession";

/**
 * Record what this request booted or created on its receipt. Ownership has passed to the bound
 * session, so the failed-lifecycle rollback no longer applies; a request that turns out
 * undelivered after this point is undone through the receipt instead (#11593).
 */
export function recordProvisionedDeviceStarted(
  boot: DeviceBootResult,
  lifecycleLease: VirtualDeviceLifecycleLease,
  {
    deleteCreatedIfUndelivered,
    recordUndeliveredAdoption,
  }: Pick<ProvisionBootOptions, "deleteCreatedIfUndelivered" | "recordUndeliveredAdoption">,
): void {
  const receipt = requestAcquisitionReceipt();
  if (!receipt) {
    return;
  }
  const { identity } = lifecycleLease;
  receipt.started = {
    rollBack: async (reason) => {
      await rollBackUndeliveredBoot(
        boot,
        identity,
        deleteCreatedIfUndelivered
          ? async (rollbackLease) => await deleteCreatedIfUndelivered(rollbackLease, reason)
          : undefined,
      );
      recordUndeliveredAdoption?.(reason);
    },
  };
}

/** What the request applied to the booted device: resources, then a manufacturer profile. */
function postBootResults(
  booted:
    | {
        resources?: DeviceResourceConfigurationResult;
        manufacturerProfile?: Record<string, unknown>;
      }
    | undefined,
): Record<string, unknown> {
  return {
    ...(booted?.resources ? { resources: booted.resources } : {}),
    ...(booted?.manufacturerProfile ? { manufacturerProfile: booted.manufacturerProfile } : {}),
  };
}

export async function applyProvisionDeviceResources(
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  device: BootedDevice,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<DeviceResourceConfigurationResult | undefined> {
  if (!args.resources) {
    return undefined;
  }
  // Leave readiness and session binding time inside the existing total budget.
  // On short requests, split the remaining time rather than exhausting it in resources.
  const remainingMs = Math.max(0, deadlineMs - deps.timer.now());
  const completionBudgetMs = Math.min(
    remainingMs / 2,
    args.readiness === "automation"
      ? serverConfig.getRunnerReadinessTimeoutMs()
      : START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
  );
  const resourceDeadlineMs = deadlineMs - completionBudgetMs;
  const configured = await deps.deviceResourceControllerFactory().setResources({
    device,
    resources: args.resources,
    deadlineMs: resourceDeadlineMs,
    signal,
  });
  const verified = await observeConfiguredDeviceResources(deps, configured, {
    device,
    deadlineMs: resourceDeadlineMs,
    signal,
  });
  assertSimulatorProfileProven(args, device, verified);
  return verified;
}

/**
 * iOS Simulator workload profiles are all-or-nothing (#6695): when any requested
 * entry cannot be proven applied after the write and independent re-read, fail
 * provisioning before readiness and session binding. The thrown error flows through
 * the normal failed-provision lifecycle, which rolls back a device this operation
 * created, releases the lifecycle lease and never binds a session. Overrides already
 * written to an adopted simulator are left in place (recorded as AutoMobile-owned).
 */
function assertSimulatorProfileProven(
  args: ProvisionDeviceArgs,
  device: BootedDevice,
  result: DeviceResourceConfigurationResult,
): void {
  if (device.platform !== "ios" || resolveIosDeviceKind(device) !== "simulator") {
    return;
  }
  // The independent re-read wins only by direct contradiction: an observed
  // unknown/unsupported (a failed or timed-out read) never overrides a state the
  // controller proved, so a transient read error cannot fail provisioning.
  const states = mergeProvenResourceStates(result.resources, result.observed?.resources);
  const drift = computeDeviceResourceDrift(result.requested, states);
  if (drift.length === 0 && result.success) {
    return;
  }
  const detail = drift.length
    ? drift
        .map(
          (entry) =>
            `${entry.resource} (${entry.kind}: expected ${entry.expected}, observed ${entry.observed.state})`,
        )
        .join(", ")
    : "resource configuration did not report success";
  throw new ProvisionDeviceError(
    "resource_profile_unproven",
    `Requested resource profile could not be proven applied on iOS simulator '${args.device.name}'; no session was bound. Unproven: ${detail}. Overrides already written to an adopted simulator remain; run reconcileDeviceResources with repair, or setDeviceResources, to change them.`,
    // Only unreadable evidence (every entry a command failure) is worth retrying.
    drift.length > 0 && drift.every((entry) => entry.kind === "commandFailure"),
    { resourceDrift: drift, deviceId: device.deviceId },
  );
}

export async function reserveProvisionDeviceReadiness(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  boot: DeviceBootResult,
): Promise<DeviceReadinessReservation | undefined> {
  const devicePool = defaultDaemonContext.devicePoolWrites();
  if (!devicePool) {
    return undefined;
  }
  const resumeSessionId = restartResumeSessionForDevice(provisionSessionArgs(args), boot.device);
  if (resumeSessionId) {
    return await devicePool.reserveRestartRecoveryReadiness(
      boot.device,
      boot.sourceImage?.name ?? boot.device.name,
      resumeSessionId,
    );
  }
  // Reserving may reboot the device during readiness recovery, and the
  // readiness that follows resets the shared per-device CtrlProxy manager and
  // rewrites resource settings. Prove this client owns the device first, the
  // same way `reserveInitialDeviceForReadiness` does for startDevice.
  return await devicePool.reserveDeviceForReadiness(
    boot.device.deviceId,
    boot.device,
    boot.sourceImage?.name ?? boot.device.name,
    undefined,
    args.__oneShotCli
      ? { oneShotCli: true }
      : args.__mcpSessionId
        ? { mcpSessionId: args.__mcpSessionId }
        : undefined,
  );
}

export async function ensureProvisionDeviceReadiness(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  device: BootedDevice,
  requestedIdentity: string,
  {
    totalDeadlineMs,
    perf,
    signal,
  }: {
    totalDeadlineMs: number;
    perf: ReturnType<typeof createPerformanceTracker>;
    signal: AbortSignal | undefined;
  },
): Promise<void> {
  if (args.readiness !== "automation") {
    return;
  }
  const ctrlProxySetup = deps.ensureCtrlProxyReady ?? ctx.ensureCtrlProxyReady;
  await ctrlProxySetup({
    device,
    requestedIdentity,
    totalDeadlineMs,
    readinessTimeoutMs: args.timeoutMs ?? serverConfig.getRunnerReadinessTimeoutMs(),
    skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
    perf,
    signal,
  });
}

export function buildProvisionDeviceResult(
  args: ProvisionDeviceArgs,
  provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
  createdByRequest: boolean,
  perf: ReturnType<typeof createPerformanceTracker>,
  booted:
    | {
        device: BootedDevice;
        sessionId: string;
        sourceImage?: DeviceInfo;
        resources?: DeviceResourceConfigurationResult;
        manufacturerProfile?: Record<string, unknown>;
      }
    | undefined,
): Record<string, unknown> {
  const pooled = booted
    ? (initializedDevicePool()?.getDevice(booted.device.deviceId) ?? undefined)
    : undefined;
  const description = describeDevice({
    kind: "provisioned",
    provisioned,
    booted: booted?.device,
    pooled,
    discovery: booted?.sourceImage,
    session: booted ? { sessionId: booted.sessionId } : undefined,
    serviceStatus: provisionedServiceStatus(booted !== undefined, args.readiness),
  });
  return {
    ...postBootResults(booted),
    ...disabledDeviceResourceReport(
      Object.fromEntries(
        (createdByRequest && provisioned.device.platform === "ios"
          ? (provisioned.prebootDisabledResources ?? [])
          : []
        ).map((key) => [key, { state: "disabled" }]),
      ),
    ),
    device: projectProvisionedDevice(description),
    requestedSpec: args.device.spec,
    resolvedSpec: provisioned.resolvedSpec,
    displayCutout:
      provisioned.resolvedSpec.displayCutout ??
      classifyDisplayCutout(args.device.platform, provisioned.resolvedSpec.deviceType),
    created: createdByRequest,
    adopted: !createdByRequest,
    lifecycleState: provisionLifecycleState(booted !== undefined, createdByRequest),
    readiness: {
      mode: args.readiness,
      status: provisionReadinessStatus(booted !== undefined, args.readiness),
    },
    ...(booted ? { sessionId: booted.sessionId } : {}),
    timing: perf.getTimings(),
  };
}

function provisionedServiceStatus(
  booted: boolean,
  readiness: ProvisionDeviceArgs["readiness"],
): { installed: true; enabled: true; running: boolean; isCompatible: true } | undefined {
  return booted
    ? { installed: true, enabled: true, running: readiness === "automation", isCompatible: true }
    : undefined;
}

function provisionLifecycleState(booted: boolean, createdByRequest: boolean): string {
  return booted ? "ready" : createdByRequest ? "created" : "adopted";
}

function provisionReadinessStatus(
  booted: boolean,
  readiness: ProvisionDeviceArgs["readiness"],
): string {
  return booted
    ? readiness === "automation"
      ? "automation_ready"
      : "device_ready"
    : "not_requested";
}
