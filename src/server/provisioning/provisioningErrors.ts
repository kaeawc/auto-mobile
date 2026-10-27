import {
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DEVICE_SHUTTING_DOWN_CODE,
  DEVICE_OFFLINE_CODE,
  DeviceOwnedByOtherDaemonError,
  SESSION_CREATION_TIMEOUT_CODE,
  RetryableDeviceAcquisitionError,
} from "../../models/deviceAcquisitionRefusals";
import { InputDeviceOwnedError } from "../../daemon/inputDeviceOwnership";
import {
  DeviceAssignedToBindingError,
  BindingDiscoveryIncompleteError,
} from "../../daemon/sessionBroker/provisioning/refusal";
import { errorMessage } from "../../utils/describeUnknownError";
import { DeviceLostError } from "../../models/DeviceLostError";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import { ActionableError } from "../../models/ActionableError";
import {
  buildProvisionDeviceRecoveryEvidence,
  type ProvisionDeviceFailureBoundary,
  type ProvisionDeviceRecoveryEvidence,
  type ProvisionDeviceRecoveryInput,
} from "../provisionDeviceRecoveryEvidence";
import { getCurrentBuildIdentity } from "../../daemon/wire/buildIdentity";
import { DAEMON_VERSION } from "../../daemon/wire/constants";
import { DaemonHandoffInterruptionError } from "../../daemon/daemonHandoffInterruption";
import { SimctlCommandTimeoutError } from "../../utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { DeviceBootTimeoutError } from "../../devices/deviceBootService";
import { AdbDeviceOfflineError } from "../../utils/android-cmdline-tools/AdbDeviceHealth";
import { RunnerReadinessError } from "../../ctrlProxy/RunnerReadinessError";
import {
  bindingProvisionError,
  type ProvisionDeviceFailureCode,
  ProvisionDeviceError,
} from "../../devices/exactDeviceProvisioning";
import type { ProvisionDeviceLifecycleOutcome } from "../../devices/provisionDeviceLifecycle";
import {
  ActiveProvisionDeviceRequest,
  ProvisionDeviceArgs,
  ProvisionDeviceRollbackError,
  createToolErrorResponse,
  getDeviceToolsDependencies,
  knownProvisionDeviceError,
  lifecycleForProvisionResponseError,
} from "../../features/deviceLifecycle/deviceLifecycleCore";

function retryableAcquisitionProvisionCode(code: string): ProvisionDeviceFailureCode | undefined {
  switch (code) {
    case DEVICE_OWNED_BY_OTHER_DAEMON_CODE:
    case DEVICE_CLEANUP_IN_PROGRESS_CODE:
    case SESSION_CREATION_TIMEOUT_CODE:
    case DEVICE_SHUTTING_DOWN_CODE:
    case DEVICE_OFFLINE_CODE:
      return code;
    default:
      return undefined;
  }
}

/**
 * Typed retryable refusals from the shared bind path, and boot capacity refusals (#11236), keep
 * their wire code and wait hint so a controller retries them the way startDevice/getAndroid
 * clients do.
 */
function retryableAcquisitionProvisionError(
  args: ProvisionDeviceArgs,
  error: unknown,
): ProvisionDeviceError | undefined {
  if (error instanceof BootCapacityExhaustedError) {
    return capacityExhaustedProvisionError(args, error);
  }
  if (!(error instanceof RetryableDeviceAcquisitionError)) {
    return undefined;
  }
  const code = retryableAcquisitionProvisionCode(error.code);
  if (!code) {
    return undefined;
  }
  return new ProvisionDeviceError(
    code,
    `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
    true,
    {
      deviceId: error.deviceId,
      retryAfterMs: error.retryAfterMs,
      ...(error instanceof DeviceOwnedByOtherDaemonError && error.ownerPid !== undefined
        ? { ownerPid: error.ownerPid }
        : {}),
    },
  );
}

/**
 * A boot refused at the booted-device limit stays the typed retryable `capacity_exhausted`
 * refusal with its wait hint and limit details, not a terminal `platform_command_failed` (#11236).
 */
function capacityExhaustedProvisionError(
  args: ProvisionDeviceArgs,
  error: BootCapacityExhaustedError,
): ProvisionDeviceError {
  const { limit, booted, externalDevices, heldDevices } = error.details;
  return new ProvisionDeviceError(
    "capacity_exhausted",
    `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
    true,
    {
      retryAfterMs: error.retryAfterMs,
      capacity: {
        limit,
        booted,
        ...(externalDevices ? { externalDevices } : {}),
        ...(heldDevices ? { heldDevices } : {}),
      },
    },
  );
}

export function describeProvisionRequest(args: ProvisionDeviceArgs): string {
  return `${args.device.platform} '${args.device.name}'`;
}

/** Readiness and cleanup failures carry the same evidence envelope as the other boundaries. */
export function failureBoundaryRecovery(
  error: unknown,
  request: ActiveProvisionDeviceRequest,
): ProvisionDeviceRecoveryEvidence | undefined {
  if (recoveryFromError(error)) {
    return undefined;
  }
  const lifecycle = lifecycleForProvisionResponseError(error);
  const boundary = failureBoundaryFor(error, lifecycle);
  if (!boundary) {
    return undefined;
  }
  const failure = error instanceof ProvisionDeviceRollbackError ? error.provisionFailure : error;
  const { code, retryable } = failureCodeAndRetryability(failure);
  const { ownership } = request.lifecycleEvidence;
  return buildProvisionDeviceRecoveryEvidence({
    boundary,
    nowMs: getDeviceToolsDependencies().timer.now(),
    daemonBuild: `${DAEMON_VERSION}+${getCurrentBuildIdentity().buildId}`,
    // A rollback error's own lifecycle is newer than the last one recorded.
    lifecycle: lifecycle ?? request.lifecycleEvidence.lifecycle,
    ...(ownership ? { ownership } : {}),
    deviceIntact:
      error instanceof ProvisionDeviceRollbackError &&
      error.diagnostics.retainedDevice !== undefined,
    originalError: { code, message: errorMessage(failure) },
    ...(retryable !== undefined ? { retryable } : {}),
  });
}

function failureCodeAndRetryability(failure: unknown): { code: string; retryable?: boolean } {
  if (failure instanceof ProvisionDeviceError) {
    return { code: failure.code, retryable: failure.retryable };
  }
  return { code: "platform_command_failed" };
}

function failureBoundaryFor(
  error: unknown,
  lifecycle: ProvisionDeviceLifecycleOutcome | undefined,
): ProvisionDeviceFailureBoundary | undefined {
  if (error instanceof ProvisionDeviceRollbackError && error.cleanup.status !== "succeeded") {
    return "cleanup_failure";
  }
  // A rollback that removed the device is a provisioning failure with a clean
  // cleanup, so it is classified by the failure that triggered it.
  const readiness =
    (error instanceof ProvisionDeviceError && error.diagnostics.readinessPhase) ||
    lifecycle?.reason?.readinessPhase ||
    lifecycle?.phase === "readiness";
  if (readiness || error instanceof ProvisionDeviceRollbackError) {
    return "readiness_failure";
  }
  return undefined;
}

export function provisionDeviceRecovery(
  boundary: ProvisionDeviceFailureBoundary,
  request: ActiveProvisionDeviceRequest,
  extra: Pick<ProvisionDeviceRecoveryInput, "settled" | "originalError" | "retryAfterMs">,
): ProvisionDeviceRecoveryEvidence {
  return buildProvisionDeviceRecoveryEvidence({
    boundary,
    nowMs: getDeviceToolsDependencies().timer.now(),
    daemonBuild: `${DAEMON_VERSION}+${getCurrentBuildIdentity().buildId}`,
    lifecycle: request.lifecycleEvidence.lifecycle,
    ...(request.lifecycleEvidence.ownership
      ? { ownership: request.lifecycleEvidence.ownership }
      : {}),
    ...extra,
  });
}

export function toProvisionDeviceError(
  args: ProvisionDeviceArgs,
  error: unknown,
): ProvisionDeviceError {
  const knownError = knownProvisionDeviceError(error);
  if (knownError) {
    return knownError;
  }
  if (error instanceof DeviceAssignedToBindingError) {
    return bindingProvisionError(
      error,
      `Failed to provision ${args.device.platform} device '${args.device.name}'`,
    );
  }
  if (error instanceof BindingDiscoveryIncompleteError) {
    return new ProvisionDeviceError(
      "discovery_incomplete",
      `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
      true,
      { retryAfterMs: error.retryAfterMs },
    );
  }
  if (error instanceof InputDeviceOwnedError) {
    return new ProvisionDeviceError(
      "device_owned_by_other_session",
      `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
      true,
      { deviceId: error.deviceId, retryAfterMs: error.retryAfterMs },
    );
  }
  const acquisitionFailure = retryableAcquisitionProvisionError(args, error);
  if (acquisitionFailure) {
    return acquisitionFailure;
  }
  if (error instanceof RunnerReadinessError) {
    const cause = error.diagnosticCause;
    if (cause instanceof DeviceLostError) {
      return new ProvisionDeviceError(
        "device_lost",
        `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
        true,
        {
          providerCode: cause.code,
          readinessPhase: error.phase,
          attempt: error.attempts,
          incidentId: cause.incidentId,
          deviceId: cause.deviceId,
        },
      );
    }
    if (cause instanceof AdbDeviceOfflineError) {
      return new ProvisionDeviceError(
        "device_offline",
        `Failed to provision ${args.device.platform} device '${args.device.name}': ${error.message}`,
        true,
        {
          providerCode: cause.code,
          readinessPhase: error.phase,
          attempt: error.attempts,
          deviceId: cause.deviceId,
        },
      );
    }
  }
  // A readiness phase that ran out of budget is a purely time-based failure:
  // report it as `timeout` so a controller that retries timeouts but treats
  // `platform_command_failed` as terminal does not give up on it.
  const deadlineFailure = isDeadlineFailure(error);
  return new ProvisionDeviceError(
    deadlineFailure ? "timeout" : "platform_command_failed",
    `Failed to provision ${args.device.platform} device '${args.device.name}': ${errorMessage(error)}`,
  );
}

// Bound traversal even for cyclic/foreign Error.cause graphs.
const MAX_DEADLINE_CAUSE_DEPTH = 8;

function isDeadlineFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_DEADLINE_CAUSE_DEPTH; depth += 1) {
    if (
      current instanceof DeviceBootTimeoutError ||
      current instanceof SimctlCommandTimeoutError ||
      (current instanceof RunnerReadinessError && current.deadlineExhausted) ||
      (current instanceof DOMException && current.name === "TimeoutError")
    ) {
      return true;
    }
    // Only plain contextual wrappers delegate classification to their cause.
    // A platform/typed failure owns its classification, even if an unrelated
    // earlier step left a timeout in its cause chain. Cancellation is not a deadline.
    if (!(current instanceof ActionableError) || current.constructor !== ActionableError) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

export function provisionDeviceLifecycleReason(error: ProvisionDeviceError) {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...provisionDeviceDiagnosticFields(error),
  };
}

function recoveryField(recovery: ProvisionDeviceRecoveryEvidence | undefined) {
  return recovery ? { recovery } : {};
}

function recoveryFromError(error: unknown): ProvisionDeviceRecoveryEvidence | undefined {
  return error instanceof ProvisionDeviceError ? error.diagnostics.recovery : undefined;
}

export function provisionDeviceErrorResponse(
  error: unknown,
  recovery?: ProvisionDeviceRecoveryEvidence,
) {
  const lifecycle = lifecycleForProvisionResponseError(error);
  const requestOutcome = {
    ...(lifecycle ? { lifecycle } : {}),
    ...recoveryField(recovery ?? recoveryFromError(error)),
  };
  if (error instanceof DaemonHandoffInterruptionError) {
    return createToolErrorResponse(error.code, error.message, {
      ...requestOutcome,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    });
  }
  if (error instanceof ProvisionDeviceRollbackError) {
    return createToolErrorResponse(error.code, error.message, {
      ...requestOutcome,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...provisionDeviceDiagnosticFields(error.provisionFailure),
      },
      provisionFailure: {
        code: error.provisionFailure.code,
        message: error.provisionFailure.message,
      },
      cleanup: error.cleanup,
    });
  }
  if (error instanceof ProvisionDeviceError) {
    return createToolErrorResponse(error.code, error.message, {
      ...requestOutcome,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...provisionDeviceDiagnosticFields(error),
      },
    });
  }
  return createToolErrorResponse("platform_command_failed", errorMessage(error), requestOutcome);
}

function provisionDeviceDiagnosticFields(error: ProvisionDeviceError) {
  const diagnostics = error.diagnostics;
  return {
    ...(diagnostics.providerCode ? { providerCode: diagnostics.providerCode } : {}),
    ...(diagnostics.readinessPhase ? { readinessPhase: diagnostics.readinessPhase } : {}),
    ...(diagnostics.attempt !== undefined ? { attempt: diagnostics.attempt } : {}),
    ...(diagnostics.incidentId ? { incidentId: diagnostics.incidentId } : {}),
    ...(diagnostics.deviceId ? { deviceId: diagnostics.deviceId } : {}),
    ...(diagnostics.ownerPid !== undefined ? { ownerPid: diagnostics.ownerPid } : {}),
    ...(diagnostics.retryAfterMs !== undefined ? { retryAfterMs: diagnostics.retryAfterMs } : {}),
    ...(diagnostics.hazards
      ? { hazards: diagnostics.hazards, howToProceed: diagnostics.howToProceed }
      : {}),
    ...(diagnostics.resourceDrift ? { resourceDrift: diagnostics.resourceDrift } : {}),
    ...(diagnostics.runtimeCompatibility
      ? { runtimeCompatibility: diagnostics.runtimeCompatibility }
      : {}),
    ...provisionDeviceRefusalFields(error),
    daemonBuild: `${DAEMON_VERSION}+${getCurrentBuildIdentity().buildId}`,
  };
}

/** Why the request itself was refused: a binding hold, missing capabilities, or capacity. */
function provisionDeviceRefusalFields(error: ProvisionDeviceError) {
  const diagnostics = error.diagnostics;
  return {
    ...(diagnostics.binding ? { binding: diagnostics.binding } : {}),
    ...(diagnostics.capabilities ? { capabilities: diagnostics.capabilities } : {}),
    ...(diagnostics.capacity ? diagnostics.capacity : {}),
  };
}
