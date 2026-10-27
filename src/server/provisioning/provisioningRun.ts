import { combineAbortSignals } from "../../utils/AbortContext";
import { PlatformDeviceManager } from "../../devices/deviceUtils";
import { errorMessage } from "../../utils/describeUnknownError";
import { BootedDevice } from "../../models";
import { assertBootCapacityAvailable } from "../../features/bootAdmission/sharedBootAdmissionGates";
import { logger } from "../../utils/logger";
import { createPerformanceTracker } from "../../utils/PerformanceTracker";
import { ambientPerfFor, runWithPerfTracker } from "../../utils/PerfContext";
import { McpSessionRecoveryInProgressError } from "../../daemon/devicePool";
import { DaemonHandoffInterruptionError } from "../../daemon/daemonHandoffInterruption";
import {
  type ExactDeviceProvisioner,
  ProvisionDeviceError,
} from "../../devices/exactDeviceProvisioning";
import { type VirtualDeviceLifecycleLease } from "../../devices/virtualDeviceLifecycleCoordinator";
import {
  ActiveProvisionDeviceRequest,
  DeviceToolsDependencies,
  ProvisionDeviceArgs,
  RecordProvisionDeviceLifecycle,
  getDeviceToolsDependencies,
  provisionDeviceDeadlineMs,
  reserveStableDeviceLifecycle,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import { describeProvisionRequest, toProvisionDeviceError } from "./provisioningErrors";
import { type ProvisionSettlementState, type ProvisioningContext } from "./provisioningTypes";
import { admitRestartReservedProvision } from "./provisioningSession";
import {
  prebootProvisionDeviceLifecycle,
  provisionDeviceLifecycleIdentity,
  releaseProvisionLifecycleReservations,
  reserveExistingIosProvisionDeviceLifecycle,
  reserveIosSelectorProvisionDeviceLifecycle,
} from "./provisioningReservation";
import { bootExactProvisionedDevice, provisionExactDevice } from "./provisioningBoot";
import { buildProvisionDeviceResult } from "./provisioningReadiness";
import { assertDeviceProfileEmulatable } from "./provisioningDeviceProfile";
import {
  rethrowFailedProvisionDeviceLifecycle,
  undeliveredProvisionRollback,
} from "./provisioningFailure";

export async function executeProvisionDevice(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  signal: AbortSignal | undefined,
  lifecycleEvidence: ActiveProvisionDeviceRequest["lifecycleEvidence"],
): Promise<Record<string, unknown>> {
  const deps = getDeviceToolsDependencies();
  const recordLifecycle: RecordProvisionDeviceLifecycle = (lifecycle) => {
    lifecycleEvidence.lifecycle = lifecycle;
    if (lifecycle.phase === "created" || lifecycle.phase === "adopted") {
      lifecycleEvidence.ownership =
        lifecycle.phase === "created" ? "created_by_request" : "adopted";
    }
  };
  // ONE absolute deadline for the whole request, anchored here and sliced
  // across every phase below (lifecycle lease wait, provisioning, boot,
  // readiness), clamped so rollback still fits inside the daemon's queued
  // request deadline (the `reserveRollbackTime` form).
  const totalDeadlineMs = provisionDeviceDeadlineMs(args, deps.timer, true);
  // Before any lease, creation or boot: a stock emulator can never serve this request (#14058).
  assertDeviceProfileEmulatable(args);
  try {
    return await runProvisionDeviceLifecycle(ctx, args, deps, {
      recordLifecycle,
      totalDeadlineMs,
      signal,
    });
  } catch (error) {
    if (
      error instanceof McpSessionRecoveryInProgressError ||
      error instanceof DaemonHandoffInterruptionError
    ) {
      // Transient by construction: the device stays viable and a retry
      // re-runs the lifecycle, adopting it under the lifecycle lease.
      logger.warn(
        `[DeviceTools] provisionDevice ${describeProvisionRequest(args)} interrupted: ${errorMessage(error)}`,
        error,
      );
      throw error;
    }
    throw toProvisionDeviceError(args, error);
  }
}

/** Takes the device lifecycle lease for the requested exact device, by platform. */
async function reserveProvisionLifecycleLease(
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  deviceManager: PlatformDeviceManager,
  perf: ReturnType<typeof createPerformanceTracker>,
  totalDeadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<VirtualDeviceLifecycleLease> {
  if (args.device.platform === "android") {
    return await reserveStableDeviceLifecycle(
      { platform: "android", stableId: args.device.name },
      {
        platform: "android",
        name: args.device.name,
        deviceId: args.device.name,
      },
      deps.timer,
      totalDeadlineMs,
      {
        requestAbortSignal: signal,
        timeoutError: (detail) =>
          new ProvisionDeviceError(
            "timeout",
            `Timed out provisioning Android AVD '${args.device.name}': ${detail}.`,
          ),
        operation: "provision",
        coordinator: deps.lifecycleCoordinator,
      },
    );
  } else {
    // Scope the iOS lifecycle reservation too: it runs `getDeviceImagesDetailed`
    // (→ `simctl list`) before the provision/boot scopes, so its discovery
    // command would otherwise be missing from perfTiming (see PerfContext).
    return await runWithPerfTracker(ambientPerfFor(perf), async () => {
      const existing = await reserveExistingIosProvisionDeviceLifecycle(
        args,
        deps,
        deviceManager,
        totalDeadlineMs,
        signal,
      );
      return (
        existing ??
        (await reserveIosSelectorProvisionDeviceLifecycle(args, deps, totalDeadlineMs, signal))
      );
    });
  }
}

async function runProvisionDeviceLifecycle(
  ctx: ProvisioningContext,
  args: ProvisionDeviceArgs,
  deps: DeviceToolsDependencies,
  {
    recordLifecycle,
    totalDeadlineMs,
    signal,
  }: {
    recordLifecycle: RecordProvisionDeviceLifecycle;
    totalDeadlineMs: number;
    signal: AbortSignal | undefined;
  },
): Promise<Record<string, unknown>> {
  const perf = createPerformanceTracker(true);
  perf.serial("provisionDevice");
  const deviceManager = deps.deviceManagerFactory();
  let lifecycleLease: VirtualDeviceLifecycleLease | undefined;
  let provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>> | undefined;
  let observedRuntimeDevice: BootedDevice | undefined;
  let creationStarted = false;
  const settlementState: ProvisionSettlementState = { bindingSettlements: [] };
  const notifyResourcesChangedBestEffort = () => {
    void deps.notifyResourcesChanged().catch((error: unknown) => {
      logger.warn(
        `[DeviceTools] Failed to notify resource changes after provisioning ${args.device.platform} device '${args.device.name}': ${errorMessage(error)}`,
        error,
      );
    });
  };
  try {
    admitRestartReservedProvision(args, args.device.deviceId);
    lifecycleLease = await reserveProvisionLifecycleLease(
      args,
      deps,
      deviceManager,
      perf,
      totalDeadlineMs,
      signal,
    );
    const deviceCreationGate = deps.deviceCreationGateFactory();
    provisioned = await provisionExactDevice(
      args,
      deps.exactDeviceProvisionerFactory(deviceManager, deviceCreationGate),
      perf,
      deps.timer,
      {
        totalDeadlineMs: totalDeadlineMs,
        markDeviceCreationStarted: () => {
          creationStarted = true;
        },
        checkBootCapacity:
          deps.checkBootCapacity ??
          ((platform, capacitySignal) =>
            assertBootCapacityAvailable(platform, { signal: capacitySignal })),
        lifecycleLease: lifecycleLease,
        collectPendingSettlement: (settlement) => {
          settlementState.exactProvisioning = settlement;
        },
        signal: signal,
      },
    );
    const createdByRequest = provisioned.created;
    recordLifecycle(prebootProvisionDeviceLifecycle(args, provisioned));
    if (!args.boot) {
      if (provisioned.created) {
        // Device creation is committed. Do not make its response or rollback
        // depend on an advisory resource notification.
        notifyResourcesChangedBestEffort();
      }
      perf.end();
      return buildProvisionDeviceResult(args, provisioned, createdByRequest, perf, undefined);
    }
    // Ambient scope (only under --debug-perf) so the emulator/simctl boot
    // commands attribute their time into this provisioning tree. Capture the
    // narrowed `provisioned`/`lifecycleLease` in consts first: the arrow
    // closure would otherwise widen the `let`s back to `| undefined`.
    const provisionedDevice = provisioned;
    const bootLifecycleLease = lifecycleLease;
    const booted = await runWithPerfTracker(ambientPerfFor(perf), () =>
      bootExactProvisionedDevice(ctx, args, deps, deviceManager, deviceCreationGate, {
        provisioned: provisionedDevice,
        perf: perf,
        totalDeadlineMs: totalDeadlineMs,
        lifecycleLease: bootLifecycleLease,
        signal: signal,
        settlementState: settlementState,
        ...undeliveredProvisionRollback(ctx, args, provisionedDevice, {
          recordLifecycle,
          observedRuntimeDevice: () => observedRuntimeDevice,
        }),
        onBooted: (device) => {
          observedRuntimeDevice = device;
          recordLifecycle({
            state: "created_not_ready",
            phase: "readiness",
            device: provisionDeviceLifecycleIdentity(args, provisionedDevice.device, device),
          });
        },
      }),
    );
    if (provisioned.created || booted.source === "cold-boot") {
      // Session and pool ownership are already committed by
      // `bootExactProvisionedDevice`. A best-effort resource notification is
      // safe to swallow here: failing it must neither turn that committed
      // success into destructive rollback nor strand the bound session.
      notifyResourcesChangedBestEffort();
    }
    perf.end();
    return buildProvisionDeviceResult(args, provisioned, createdByRequest, perf, booted);
  } catch (error) {
    perf.end();
    return await rethrowFailedProvisionDeviceLifecycle(
      ctx,
      args,
      deps,
      deviceManager,
      provisioned,
      {
        createdAvdNeverLaunched:
          args.device.platform === "android" &&
          provisioned?.created === true &&
          !settlementState.bootAttempted,
        creationStarted: creationStarted,
        retainCreatedForRetry: settlementState.retainCreatedForRetry,
        signal: combineAbortSignals(signal, lifecycleLease?.signal),
        takeLifecycleLease: () => {
          const rollbackLease = lifecycleLease;
          lifecycleLease = undefined;
          return rollbackLease;
        },
        error: error,
        unownedColdBootSettlement: settlementState.unownedColdBootSettlement,
        pendingMutationSettlement: settlementState.exactProvisioning,
        recordLifecycle: recordLifecycle,
        observedRuntimeDevice: observedRuntimeDevice,
      },
    );
  } finally {
    releaseProvisionLifecycleReservations(settlementState, () => lifecycleLease);
  }
}
