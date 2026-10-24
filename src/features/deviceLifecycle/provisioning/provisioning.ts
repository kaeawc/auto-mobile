import { ProvisionDeviceError } from "../../../devices/exactDeviceProvisioning";
import {
  AndroidAvdIdentityConflictError,
  BootedDeviceDiscoveryIncompleteError,
  findUniqueBootedAndroidDeviceByName,
} from "../../../devices/deviceBootService";
import { Platform, BootedDevice, DeviceInfo } from "../../../models";
import { type ProvisionDeviceLifecycleOutcome } from "../../../devices/provisionDeviceLifecycle";
import { serverConfig } from "../../../utils/ServerConfig";
import { deleteInternalToolParams } from "../../../daemon/wire/constants";
import { type Timer } from "../../../utils/SystemTimer";
import {
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS,
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
} from "../../../utils/deviceTimeouts";
import {
  type TeardownDeviceArgs,
  type StartDeviceArgs,
  type ProvisionDeviceArgs,
  type InternalProvisionDeviceArgs,
} from "../core/contracts";
import { type TeardownToolResponse } from "../teardown/teardownContracts";
import { provisionDeviceSchema } from "../core/schemas";

export function knownProvisionDeviceError(error: unknown): ProvisionDeviceError | undefined {
  if (error instanceof ProvisionDeviceError) {
    return error;
  }
  if (error instanceof AndroidAvdIdentityConflictError) {
    return new ProvisionDeviceError("identity_conflict", error.message);
  }
  if (error instanceof BootedDeviceDiscoveryIncompleteError) {
    return new ProvisionDeviceError("discovery_incomplete", error.message, true);
  }
  return undefined;
}

export function findExactProvisionedBootedDevice(
  platform: Platform,
  booted: readonly BootedDevice[],
  provisioned: Pick<DeviceInfo, "deviceId" | "name">,
): BootedDevice | undefined {
  if (platform === "ios") {
    return booted.find((device) => device.deviceId === provisioned.deviceId);
  }
  const byDeviceId = provisioned.deviceId
    ? booted.find((device) => !device.foreignOwned && device.deviceId === provisioned.deviceId)
    : undefined;
  return byDeviceId ?? findUniqueBootedAndroidDeviceByName(booted, provisioned.name);
}

export interface ProvisionDeviceCleanup {
  status: "succeeded" | "failed";
  target: TeardownDeviceArgs["target"];
  state?: string;
  failure?: {
    code: string;
    phase: string;
    message: string;
  };
}

/** Record a lifecycle outcome for the running request's recovery evidence. */
export type RecordProvisionDeviceLifecycle = (lifecycle: ProvisionDeviceLifecycleOutcome) => void;

export const provisionDeviceLifecycleByError = new WeakMap<
  object,
  ProvisionDeviceLifecycleOutcome
>();

export function attachProvisionDeviceLifecycle<T extends object>(
  error: T,
  lifecycle: ProvisionDeviceLifecycleOutcome,
): T {
  provisionDeviceLifecycleByError.set(error, lifecycle);
  return error;
}

export function lifecycleForProvisionResponseError(
  error: unknown,
): ProvisionDeviceLifecycleOutcome | undefined {
  return typeof error === "object" && error !== null
    ? provisionDeviceLifecycleByError.get(error)
    : undefined;
}

export function lifecycleStateForCleanup(
  cleanup: ProvisionDeviceCleanup,
): ProvisionDeviceLifecycleOutcome["state"] {
  if (cleanup.status === "succeeded") {
    return "removed";
  }
  return cleanup.failure?.code === "mutation_settlement_timeout"
    ? "cleanup_in_progress"
    : "retained";
}

export function lifecycleCleanupStatus(
  cleanup: ProvisionDeviceCleanup,
): NonNullable<ProvisionDeviceLifecycleOutcome["cleanup"]>["status"] {
  if (cleanup.status === "succeeded") {
    return "succeeded";
  }
  return cleanup.failure?.code === "mutation_settlement_timeout" ? "in_progress" : "failed";
}

export class ProvisionDeviceRollbackError extends ProvisionDeviceError {
  constructor(
    readonly provisionFailure: ProvisionDeviceError,
    readonly cleanup: ProvisionDeviceCleanup,
  ) {
    super(
      cleanup.status === "failed" ? "cleanup_failed" : provisionFailure.code,
      cleanup.status === "failed"
        ? `${provisionFailure.message} Cleanup of the newly created device also failed: ${
            cleanup.failure?.message ?? "unknown cleanup failure"
          }`
        : provisionFailure.message,
      // Retry risks an identity collision while the failed-rollback device may still exist.
      cleanup.status === "failed" ? false : provisionFailure.retryable,
      provisionFailure.diagnostics,
    );
    this.name = "ProvisionDeviceRollbackError";
  }
}

export function isTeardownFailure(response: TeardownToolResponse): boolean {
  return "isError" in response && response.isError === true;
}

export function describeStartDeviceRequest(args: StartDeviceArgs): string {
  return [
    `platform=${args.platform}`,
    args.deviceId ? `deviceId=${args.deviceId}` : undefined,
    args.name ? `name=${args.name}` : undefined,
    args.minOsVersion ? `minOsVersion=${args.minOsVersion}` : undefined,
    args.maxOsVersion ? `maxOsVersion=${args.maxOsVersion}` : undefined,
    args.formFactor ? `formFactor=${args.formFactor}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

export function resolveRunnerReadinessTimeoutMs(args: StartDeviceArgs): number {
  return (
    args.runnerReadinessTimeoutMs ?? args.timeoutMs ?? serverConfig.getRunnerReadinessTimeoutMs()
  );
}

export function parseProvisionDeviceArgs(
  input: Partial<InternalProvisionDeviceArgs>,
): InternalProvisionDeviceArgs {
  const __mcpSessionId = input.__mcpSessionId;
  const __oneShotCli = input.__oneShotCli === true;
  const __mcpRequestDeadlineMs = input.__mcpRequestDeadlineMs;
  const __mcpLiveDeadlineKey =
    typeof input.__mcpLiveDeadlineKey === "string" ? input.__mcpLiveDeadlineKey : undefined;
  const publicInput: Record<string, unknown> = { ...input };
  // `provisionDeviceSchema` is `.strict()`, so EVERY internal param the daemon
  // may inject has to go before re-parsing -- hence the canonical shared list
  // rather than a hand-maintained copy that silently falls behind (a missing
  // `__mcpLiveDeadlineKey` made this tool unusable for any caller sending a
  // progress token).
  deleteInternalToolParams(publicInput);
  delete publicInput.rollbackOnRetryableReadiness;
  const parsed = provisionDeviceSchema.parse(publicInput);
  return {
    ...parsed,
    ...(input.rollbackOnRetryableReadiness === false
      ? { rollbackOnRetryableReadiness: false }
      : {}),
    boot: parsed.boot ?? true,
    readiness: parsed.readiness ?? "automation",
    __mcpSessionId,
    ...(__oneShotCli ? { __oneShotCli } : {}),
    __mcpRequestDeadlineMs,
    ...(__mcpLiveDeadlineKey ? { __mcpLiveDeadlineKey } : {}),
  };
}

// Exported for property-based testing: the absolute deadline arithmetic clamps
// the requested budget against the transport deadline minus reserved rollback
// time, and those clamping invariants are worth exercising directly.
export function provisionDeviceDeadlineMs(
  args: ProvisionDeviceArgs,
  timer: Pick<Timer, "now">,
  reserveRollbackTime: boolean,
): number {
  const requestedDeadlineMs = timer.now() + (args.timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
  if (!reserveRollbackTime || args.__mcpRequestDeadlineMs === undefined) {
    return requestedDeadlineMs;
  }
  return Math.min(
    requestedDeadlineMs,
    args.__mcpRequestDeadlineMs -
      DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS -
      START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
  );
}

export function provisionDeviceTimeoutError(phase: string): ProvisionDeviceError {
  return new ProvisionDeviceError(
    "timeout",
    `provisionDevice timeout exhausted while ${phase}; remainingBudgetMs=0`,
  );
}
