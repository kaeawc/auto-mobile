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
import { AppleVisionSimulatorInventory } from "../utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import { AppleVisionSimulatorProvisioner } from "../utils/ios-cmdline-tools/AppleVisionSimulatorProvisioner";
import { logger } from "../utils/logger";
import { awaitWhileRequestIsLive } from "../utils/toolUtils";
import type { z } from "zod/v4";

/** A deleteDevice request as registered; it may name an Apple Vision Pro simulator. */
export type RegisteredTeardownArgs = z.output<typeof teardownDeviceRegistrationSchema>;

const VERIFIED = { notRunning: "confirmed", inventory: "complete_absence_confirmed" } as const;

/** How deleteDevice stops and checks a headset; the lifecycle handlers pass killDevice's path. */
export interface AppleVisionDeleteSteps {
  /** The broker-binding, session-holder and other-daemon refusals; throws to refuse. */
  assertCaller(device: BootedDevice): Promise<void>;
  /** Stops the headset through killDevice, which releases the pool row and any session on it. */
  stop(device: BootedDevice, signal: AbortSignal): Promise<unknown>;
}

/**
 * deleteDevice for an Apple Vision Pro simulator. The headset is resolved from the headset
 * listing by UDID; an absent headset is already deleted. The caller checks run first. A running
 * headset, or a stopped one the pool still records (a session may be bound to it), goes through
 * killDevice, which stops it and releases its ownership; that happens before the teardown lease,
 * which killDevice's own lease would wait on. Under the teardown lease the caller checks run
 * again, then `simctl delete` runs and a fresh headset listing, template-format names included,
 * must no longer show it.
 *
 * `timeoutMs` bounds the whole delete, the caller checks included. As with every deleteDevice, a caller that goes away does
 * not stop an accepted delete unless it asked for `cancel-on-request-abort`.
 */
export async function deleteAppleVisionDevice(
  args: RegisteredTeardownArgs,
  steps: AppleVisionDeleteSteps,
  callerSignal?: AbortSignal,
): Promise<TeardownToolResponse> {
  const deps = getDeviceToolsDependencies();
  const deadlineMs = deps.timer.now() + (args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
  const operation = headsetDeleteOperation(deps.timer, deadlineMs, args, callerSignal);
  let assertingCaller = false;
  try {
    return await runAppleVisionDelete(
      args,
      {
        assertCaller: async (device) => {
          assertingCaller = true;
          // The checks take no signal; the delete's deadline still ends the wait for them.
          await awaitWhileRequestIsLive(steps.assertCaller(device), operation.signal);
          assertingCaller = false;
        },
        stop: (device, signal) => steps.stop(device, signal),
      },
      operation.signal,
      deadlineMs,
    );
  } catch (error) {
    logger.warn(
      `[DeviceTools] deleteDevice visionos:${args.target.stableId} failed: ${errorMessage(error)}`,
      error,
    );
    if (
      assertingCaller &&
      error instanceof ActionableError &&
      error !== Reflect.get(operation.signal, "reason")
    ) {
      throw error;
    }
    if (operation.timedOut()) {
      return createTeardownFailureResponse(args, "destroy", "teardown_deadline_exceeded", {
        message: `deleteDevice did not finish deleting Apple Vision Pro simulator ${args.target.stableId} within ${args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS}ms.`,
      });
    }
    operation.signal.throwIfAborted();
    if (error instanceof ActionableError && Reflect.get(error, "code") !== undefined) {
      throw error;
    }
    return createTeardownFailureResponse(args, "destroy", "vision_delete_failed", {
      message: errorMessage(error),
    });
  } finally {
    operation.dispose();
  }
}

async function runAppleVisionDelete(
  args: RegisteredTeardownArgs,
  steps: AppleVisionDeleteSteps,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<TeardownToolResponse> {
  const deps = getDeviceToolsDependencies();
  const provisioner = (
    deps.appleVisionSimulatorProvisionerFactory ?? defaultAppleVisionProvisioner
  )();
  const udid = args.target.stableId;
  const headset = await provisioner.find(udid, signal);
  if (!headset) {
    const pooled = initializedDevicePool()?.getDevice(udid);
    if (pooled) {
      const device: BootedDevice = { name: pooled.name, platform: "visionos", deviceId: udid };
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
  if (args.target.stableName && args.target.stableName !== headset.name) {
    return createTeardownFailureResponse(args, "precondition", "identity_conflict", {
      message: `Apple Vision Pro simulator ${udid} is named '${headset.name}', not '${args.target.stableName}'.`,
      resolved: headset,
    });
  }
  const device: BootedDevice = { name: headset.name, platform: "visionos", deviceId: udid };
  await steps.assertCaller(device);
  const wasRunning = headset.isRunning === true;
  if (wasRunning || initializedDevicePool()?.getDevice(udid)) {
    await steps.stop(device, signal);
  }
  signal.throwIfAborted();
  await destroyUnderLease(provisioner, device, { deadlineMs, signal, steps });
  return createTeardownResponse(
    args,
    "destroyed",
    { stop: wasRunning ? "accepted" : "not_required", destroy: "accepted" },
    { verification: VERIFIED, resolved: headset },
  );
}

/**
 * The delete's own signal: aborted at its deadline, and by the caller only under
 * `cancel-on-request-abort`; otherwise an accepted delete outlives its caller.
 */
function headsetDeleteOperation(
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
  provisioner: Pick<AppleVisionSimulatorProvisioner, "find" | "deleteAndConfirmAbsent">,
  device: BootedDevice,
  {
    deadlineMs,
    signal,
    steps,
  }: { deadlineMs: number; signal: AbortSignal; steps: Pick<AppleVisionDeleteSteps, "assertCaller"> },
): Promise<void> {
  const deps = getDeviceToolsDependencies();
  const lease = await deps.lifecycleCoordinator.reserve(
    { kind: "stable", platform: "visionos", stableId: device.deviceId },
    { operation: "teardown", deadlineMs, signal },
  );
  try {
    const current = await provisioner.find(device.deviceId, signal);
    if (current && current.name !== device.name) {
      throw new ActionableError(
        `Apple Vision Pro simulator ${device.deviceId} was renamed before it could be deleted; retry deleteDevice.`,
      );
    }
    if (current?.isRunning) {
      throw new ActionableError(
        `Apple Vision Pro simulator ${device.deviceId} was started again before it could be deleted; retry deleteDevice.`,
      );
    }
    // The lease is per process: a peer daemon may have claimed the headset since the first
    // caller check, so the caller checks (other-daemon claims included) run again here.
    await steps.assertCaller(device);
    signal.throwIfAborted();
    await provisioner.deleteAndConfirmAbsent(device.deviceId, signal);
  } finally {
    lease.release();
  }
}

function defaultAppleVisionProvisioner(): AppleVisionSimulatorProvisioner {
  const simctl = new SimCtlClient();
  return new AppleVisionSimulatorProvisioner(new AppleVisionSimulatorInventory(simctl), simctl);
}
