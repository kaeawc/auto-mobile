import { getDeviceToolsDependencies } from "../features/deviceLifecycle/deviceLifecycleCore";
import { teardownDeviceRegistrationSchema } from "../features/deviceLifecycle/core/toolSchemas";
import {
  createTeardownFailureResponse,
  createTeardownResponse,
  type TeardownToolResponse,
} from "../features/deviceLifecycle/teardown/teardownContracts";
import type { TeardownDeviceArgs } from "../features/deviceLifecycle/deviceLifecycleCore";
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
  /** Stops a running watch through killDevice, which releases any session on it. */
  stop(device: BootedDevice): Promise<unknown>;
}

/**
 * deleteDevice for an Apple Watch simulator (#15882). The watch is resolved from the watch
 * listing by UDID; an absent watch is already deleted. The caller checks run first; a running
 * watch is stopped through killDevice (before the teardown lease, which killDevice's own lease
 * would wait on), then under the teardown lease `simctl delete` runs and a fresh watch listing
 * must no longer show it.
 */
export async function deleteWatchDevice(
  args: RegisteredTeardownArgs,
  steps: WatchDeleteSteps,
  signal?: AbortSignal,
): Promise<TeardownToolResponse> {
  const response: TeardownDeviceArgs = args;
  const deps = getDeviceToolsDependencies();
  const provisioner = (deps.watchSimulatorProvisionerFactory ?? defaultWatchProvisioner)();
  const udid = args.target.stableId;
  try {
    const watch = await provisioner.find(udid, signal);
    if (!watch) {
      return createTeardownResponse(
        response,
        "already_absent",
        { stop: "not_required", destroy: "not_required" },
        VERIFIED,
      );
    }
    if (args.target.stableName && args.target.stableName !== watch.name) {
      return createTeardownFailureResponse(
        response,
        "precondition",
        "identity_conflict",
        `Apple Watch simulator ${udid} is named '${watch.name}', not '${args.target.stableName}'.`,
        watch,
      );
    }
    const device: BootedDevice = { name: watch.name, platform: "watchos", deviceId: udid };
    await steps.assertCaller(device);
    const wasRunning = watch.isRunning === true;
    if (wasRunning) {
      await steps.stop(device);
    }
    await destroyUnderLease(provisioner, device, args, signal);
    return createTeardownResponse(
      response,
      "destroyed",
      { stop: wasRunning ? "accepted" : "not_required", destroy: "accepted" },
      VERIFIED,
      watch,
    );
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`[DeviceTools] deleteDevice watchos:${udid} failed: ${errorMessage(error)}`, error);
    if (error instanceof ActionableError && Reflect.get(error, "code") !== undefined) {
      throw error;
    }
    return createTeardownFailureResponse(
      response,
      "destroy",
      "watch_delete_failed",
      errorMessage(error),
    );
  }
}

async function destroyUnderLease(
  provisioner: Pick<WatchSimulatorProvisioner, "find" | "deleteAndConfirmAbsent">,
  device: BootedDevice,
  args: RegisteredTeardownArgs,
  signal: AbortSignal | undefined,
): Promise<void> {
  const deps = getDeviceToolsDependencies();
  const lease = await deps.lifecycleCoordinator.reserve(
    { kind: "stable", platform: "watchos", stableId: device.deviceId },
    {
      operation: "teardown",
      deadlineMs: deps.timer.now() + (args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS),
      signal,
    },
  );
  try {
    if ((await provisioner.find(device.deviceId, signal))?.isRunning) {
      throw new ActionableError(
        `Apple Watch simulator ${device.deviceId} was started again before it could be deleted; retry deleteDevice.`,
      );
    }
    await provisioner.deleteAndConfirmAbsent(device.deviceId, signal);
  } finally {
    lease.release();
  }
}

function defaultWatchProvisioner(): WatchSimulatorProvisioner {
  const simctl = new SimCtlClient();
  return new WatchSimulatorProvisioner(new WatchSimulatorInventory(simctl), simctl);
}
