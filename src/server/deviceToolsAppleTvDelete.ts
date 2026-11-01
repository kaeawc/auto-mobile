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
import { AppleTvSimulatorInventory } from "../utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import { AppleTvSimulatorProvisioner } from "../utils/ios-cmdline-tools/AppleTvSimulatorProvisioner";
import { logger } from "../utils/logger";
import type { z } from "zod/v4";

/** A deleteDevice request as registered; it may name an Apple TV simulator. */
export type RegisteredTeardownArgs = z.output<typeof teardownDeviceRegistrationSchema>;

const VERIFIED = { notRunning: "confirmed", inventory: "complete_absence_confirmed" } as const;

/** How deleteDevice stops and checks a TV; the lifecycle handlers pass killDevice's path. */
export interface AppleTvDeleteSteps {
  /** The broker-binding, session-holder and other-daemon refusals; throws to refuse. */
  assertCaller(device: BootedDevice): Promise<void>;
  /** Stops the TV through killDevice, which releases the pool row and any session on it. */
  stop(device: BootedDevice, signal: AbortSignal): Promise<unknown>;
}

/**
 * deleteDevice for an Apple TV simulator (#15889). The TV is resolved from the TV
 * listing by UDID; an absent TV is already deleted. The caller checks run first. A running
 * TV, or a stopped one the pool still records (a session may be bound to it), goes through
 * killDevice, which stops it and releases its ownership; that happens before the teardown lease,
 * which killDevice's own lease would wait on. Under the teardown lease `simctl delete` runs and a
 * fresh TV listing must no longer show it.
 *
 * `timeoutMs` bounds the whole delete. As with every deleteDevice, a caller that goes away does
 * not stop an accepted delete unless it asked for `cancel-on-request-abort`.
 */
export async function deleteAppleTvDevice(
  args: RegisteredTeardownArgs,
  steps: AppleTvDeleteSteps,
  callerSignal?: AbortSignal,
): Promise<TeardownToolResponse> {
  const deps = getDeviceToolsDependencies();
  const deadlineMs = deps.timer.now() + (args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
  const operation = tvDeleteOperation(deps.timer, deadlineMs, args, callerSignal);
  let assertingCaller = false;
  try {
    return await runAppleTvDelete(
      args,
      {
        assertCaller: async (device) => {
          assertingCaller = true;
          await steps.assertCaller(device);
          assertingCaller = false;
        },
        stop: (device, signal) => steps.stop(device, signal),
      },
      operation.signal,
      deadlineMs,
    );
  } catch (error) {
    logger.warn(
      `[DeviceTools] deleteDevice tvos:${args.target.stableId} failed: ${errorMessage(error)}`,
      error,
    );
    if (assertingCaller && error instanceof ActionableError) {
      throw error;
    }
    if (operation.timedOut()) {
      return createTeardownFailureResponse(args, "destroy", "teardown_deadline_exceeded", {
        message: `deleteDevice did not finish deleting Apple TV simulator ${args.target.stableId} within ${args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS}ms.`,
      });
    }
    operation.signal.throwIfAborted();
    if (error instanceof ActionableError && Reflect.get(error, "code") !== undefined) {
      throw error;
    }
    return createTeardownFailureResponse(args, "destroy", "tv_delete_failed", {
      message: errorMessage(error),
    });
  } finally {
    operation.dispose();
  }
}

async function runAppleTvDelete(
  args: RegisteredTeardownArgs,
  steps: AppleTvDeleteSteps,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<TeardownToolResponse> {
  const deps = getDeviceToolsDependencies();
  const provisioner = (deps.appleTvSimulatorProvisionerFactory ?? defaultAppleTvProvisioner)();
  const udid = args.target.stableId;
  const tv = await provisioner.find(udid, signal);
  if (!tv) {
    const pooled = initializedDevicePool()?.getDevice(udid);
    if (pooled) {
      const device: BootedDevice = { name: pooled.name, platform: "tvos", deviceId: udid };
      await steps.assertCaller(device);
      await steps.stop(device, signal);
    }
    return createTeardownResponse(
      args,
      "already_absent",
      { stop: "not_required", destroy: "not_required" },
      { verification: VERIFIED },
    );
  }
  if (args.target.stableName && args.target.stableName !== tv.name) {
    return createTeardownFailureResponse(args, "precondition", "identity_conflict", {
      message: `Apple TV simulator ${udid} is named '${tv.name}', not '${args.target.stableName}'.`,
      resolved: tv,
    });
  }
  const device: BootedDevice = { name: tv.name, platform: "tvos", deviceId: udid };
  await steps.assertCaller(device);
  const wasRunning = tv.isRunning === true;
  if (wasRunning || initializedDevicePool()?.getDevice(udid)) {
    await steps.stop(device, signal);
  }
  signal.throwIfAborted();
  await destroyUnderLease(provisioner, device, deadlineMs, signal);
  return createTeardownResponse(
    args,
    "destroyed",
    { stop: wasRunning ? "accepted" : "not_required", destroy: "accepted" },
    { verification: VERIFIED, resolved: tv },
  );
}

/**
 * The delete's own signal: aborted at its deadline, and by the caller only under
 * `cancel-on-request-abort`; otherwise an accepted delete outlives its caller.
 */
function tvDeleteOperation(
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
  provisioner: Pick<AppleTvSimulatorProvisioner, "find" | "deleteAndConfirmAbsent">,
  device: BootedDevice,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deps = getDeviceToolsDependencies();
  const lease = await deps.lifecycleCoordinator.reserve(
    { kind: "stable", platform: "tvos", stableId: device.deviceId },
    { operation: "teardown", deadlineMs, signal },
  );
  try {
    const current = await provisioner.find(device.deviceId, signal);
    if (current && current.name !== device.name) {
      throw new ActionableError(
        `Apple TV simulator ${device.deviceId} was renamed before it could be deleted; retry deleteDevice.`,
      );
    }
    if (current?.isRunning) {
      throw new ActionableError(
        `Apple TV simulator ${device.deviceId} was started again before it could be deleted; retry deleteDevice.`,
      );
    }
    signal.throwIfAborted();
    await provisioner.deleteAndConfirmAbsent(device.deviceId, signal);
  } finally {
    lease.release();
  }
}

function defaultAppleTvProvisioner(): AppleTvSimulatorProvisioner {
  const simctl = new SimCtlClient();
  return new AppleTvSimulatorProvisioner(new AppleTvSimulatorInventory(simctl), simctl);
}
