import {
  getDeviceToolsDependencies,
  initializedDevicePool,
  type DeviceToolsDependencies,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { teardownDeviceRegistrationSchema } from "../features/deviceLifecycle/core/toolSchemas";
import {
  createTeardownFailureResponse,
  createTeardownResponse,
  type TeardownToolResponse,
} from "../features/deviceLifecycle/teardown/teardownContracts";
import { ActionableError, type BootedDevice } from "../models";
import { DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { errorMessage } from "../utils/describeUnknownError";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { WatchSimulatorInventory } from "../utils/ios-cmdline-tools/WatchSimulatorInventory";
import { WatchSimulatorProvisioner } from "../utils/ios-cmdline-tools/WatchSimulatorProvisioner";
import { logger } from "../utils/logger";
import type { z } from "zod/v4";

/** A deleteDevice request as registered; it may name an Apple Watch simulator. */
export type RegisteredTeardownArgs = z.output<typeof teardownDeviceRegistrationSchema>;

/** Whether a deleteDevice request names an Apple Watch simulator. */
export function isWatchTeardownRequest(args: RegisteredTeardownArgs): boolean {
  return args.target.platform === "watchos";
}

const VERIFIED = { notRunning: "confirmed", inventory: "complete_absence_confirmed" } as const;

/** How deleteDevice stops and checks a watch; the lifecycle handlers pass killDevice's path. */
export interface WatchDeleteSteps {
  /** The broker-binding, session-holder and other-daemon refusals; throws to refuse. */
  assertCaller(device: BootedDevice): Promise<void>;
  /** Stops the watch through killDevice, which releases the pool row and any session on it. */
  stop(device: BootedDevice, signal: AbortSignal): Promise<unknown>;
}

/**
 * deleteDevice for an Apple Watch simulator (#15882). The watch is resolved from the watch
 * listing by UDID; an absent watch is already deleted. The caller checks run first. A running
 * watch, or a stopped one the pool still records (a session may be bound to it), goes through
 * killDevice, which stops it and releases its ownership; that happens before the teardown lease,
 * which killDevice's own lease would wait on. Under the teardown lease `simctl delete` runs and a
 * fresh watch listing must no longer show it.
 *
 * `timeoutMs` bounds the whole delete. As with every deleteDevice, a caller that goes away does
 * not stop an accepted delete unless it asked for `cancel-on-request-abort`.
 */
export async function deleteWatchDevice(
  args: RegisteredTeardownArgs,
  steps: WatchDeleteSteps,
  callerSignal?: AbortSignal,
): Promise<TeardownToolResponse> {
  const deps = getDeviceToolsDependencies();
  const deadlineMs = deps.timer.now() + (args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
  const operation = watchDeleteOperation(deps.timer, deadlineMs, args, callerSignal);
  try {
    return await runWatchDelete(args, steps, operation.signal, deadlineMs);
  } catch (error) {
    if (operation.timedOut()) {
      return createTeardownFailureResponse(
        args,
        "destroy",
        "teardown_deadline_exceeded",
        `deleteDevice did not finish deleting Apple Watch simulator ${args.target.stableId} within ${args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS}ms.`,
      );
    }
    operation.signal.throwIfAborted();
    logger.warn(
      `[DeviceTools] deleteDevice watchos:${args.target.stableId} failed: ${errorMessage(error)}`,
      error,
    );
    if (error instanceof ActionableError && Reflect.get(error, "code") !== undefined) {
      throw error;
    }
    return createTeardownFailureResponse(
      args,
      "destroy",
      "watch_delete_failed",
      errorMessage(error),
    );
  } finally {
    operation.dispose();
  }
}

async function runWatchDelete(
  args: RegisteredTeardownArgs,
  steps: WatchDeleteSteps,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<TeardownToolResponse> {
  const deps = getDeviceToolsDependencies();
  const provisioner = (deps.watchSimulatorProvisionerFactory ?? defaultWatchProvisioner)();
  const udid = args.target.stableId;
  const watch = await provisioner.find(udid, signal);
  if (!watch) {
    return createTeardownResponse(
      args,
      "already_absent",
      { stop: "not_required", destroy: "not_required" },
      VERIFIED,
    );
  }
  if (args.target.stableName && args.target.stableName !== watch.name) {
    return createTeardownFailureResponse(
      args,
      "precondition",
      "identity_conflict",
      `Apple Watch simulator ${udid} is named '${watch.name}', not '${args.target.stableName}'.`,
      { resolved: watch },
    );
  }
  const device: BootedDevice = { name: watch.name, platform: "watchos", deviceId: udid };
  await steps.assertCaller(device);
  const wasRunning = watch.isRunning === true;
  if (wasRunning || initializedDevicePool()?.getDevice(udid)) {
    await steps.stop(device, signal);
  }
  signal.throwIfAborted();
  await destroyUnderLease(provisioner, device, deadlineMs, signal);
  return createTeardownResponse(
    args,
    "destroyed",
    { stop: wasRunning ? "accepted" : "not_required", destroy: "accepted" },
    VERIFIED,
    { resolved: watch },
  );
}

/**
 * The delete's own signal: aborted at its deadline, and by the caller only under
 * `cancel-on-request-abort`; otherwise an accepted delete outlives its caller.
 */
function watchDeleteOperation(
  timer: Pick<DeviceToolsDependencies["timer"], "setTimeout" | "clearTimeout" | "now">,
  deadlineMs: number,
  args: RegisteredTeardownArgs,
  callerSignal: AbortSignal | undefined,
) {
  const controller = new AbortController();
  let expired = false;
  const handle = timer.setTimeout(
    () => {
      expired = true;
      controller.abort(new ActionableError("deleteDevice deadline exceeded"));
    },
    Math.max(0, deadlineMs - timer.now()),
  );
  const followCaller =
    args.cancellationPolicy === "cancel-on-request-abort" ? callerSignal : undefined;
  const onCallerAbort = () => controller.abort(followCaller?.reason);
  if (followCaller?.aborted) {
    onCallerAbort();
  } else {
    followCaller?.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      timer.clearTimeout(handle);
      followCaller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function destroyUnderLease(
  provisioner: Pick<WatchSimulatorProvisioner, "find" | "deleteAndConfirmAbsent">,
  device: BootedDevice,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deps = getDeviceToolsDependencies();
  const lease = await deps.lifecycleCoordinator.reserve(
    { kind: "stable", platform: "watchos", stableId: device.deviceId },
    { operation: "teardown", deadlineMs, signal },
  );
  try {
    if ((await provisioner.find(device.deviceId, signal))?.isRunning) {
      throw new ActionableError(
        `Apple Watch simulator ${device.deviceId} was started again before it could be deleted; retry deleteDevice.`,
      );
    }
    signal.throwIfAborted();
    await provisioner.deleteAndConfirmAbsent(device.deviceId, signal);
  } finally {
    lease.release();
  }
}

function defaultWatchProvisioner(): WatchSimulatorProvisioner {
  const simctl = new SimCtlClient();
  return new WatchSimulatorProvisioner(new WatchSimulatorInventory(simctl), simctl);
}
