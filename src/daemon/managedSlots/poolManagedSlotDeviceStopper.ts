import type { PooledDevice } from "../devicePool";
import { errorMessage } from "../../utils/describeUnknownError";
import type {
  ManagedSlotDeviceStopper,
  ManagedSlotStopResult,
  ManagedSlotStopTarget,
} from "./freeDeviceReclaimer";
import { runAsManagedSlotReconciler } from "./managedSlotExclusion";
import { readToolPayload, type ManagedSlotToolInvoker } from "./managedSlotReconcilerPorts";

/** `killDevice` reports a device that is not running with this code; the goal is already met. */
const DEVICE_ALREADY_STOPPED_CODE = "device_already_stopped";

export interface ManagedSlotStopPool {
  getAllDevices(): PooledDevice[];
}

/**
 * {@link ManagedSlotDeviceStopper} over the registered `killDevice` handler (shut down, image kept;
 * never `deleteDevice`). Runs inside {@link runAsManagedSlotReconciler}, which the generic-exclusion
 * guard accepts for the managed free pool only. The handler's own entry checks still apply and are
 * never forced: a session-held device or one another live daemon holds is refused, which is a
 * `failed` result retried with backoff.
 */
export class PoolManagedSlotDeviceStopper implements ManagedSlotDeviceStopper {
  constructor(
    private readonly pool: ManagedSlotStopPool,
    private readonly invokeTool: ManagedSlotToolInvoker,
  ) {}

  async stopAndVerifyOffline(target: ManagedSlotStopTarget): Promise<ManagedSlotStopResult> {
    const runtimes = this.pool
      .getAllDevices()
      .filter(
        (pooled) =>
          pooled.platform === target.platform &&
          (target.platform === "android"
            ? (pooled.avdName ?? pooled.name) === target.stableId
            : pooled.id === target.stableId),
      );
    if (runtimes.length === 0) {
      return { kind: "failed", message: "The device is running but the pool has no runtime of it" };
    }
    for (const runtime of runtimes) {
      const failure = await this.kill(target, runtime);
      if (failure) {
        return failure;
      }
    }
    return { kind: "stopped" };
  }

  private async kill(
    target: ManagedSlotStopTarget,
    runtime: PooledDevice,
  ): Promise<ManagedSlotStopResult | undefined> {
    try {
      const response = await runAsManagedSlotReconciler(
        { scopeKey: target.fromScopeKey, slotIndex: 0 },
        () =>
          this.invokeTool(
            "killDevice",
            {
              device: {
                name: runtime.avdName ?? runtime.name,
                platform: runtime.platform,
                deviceId: runtime.id,
              },
            },
            undefined,
          ),
      );
      const { isError, payload } = readToolPayload(response);
      const error = (payload.error ?? {}) as { code?: unknown };
      if (!isError || error.code === DEVICE_ALREADY_STOPPED_CODE) {
        return undefined;
      }
      const message = typeof payload.message === "string" ? payload.message : undefined;
      return {
        kind: "failed",
        message: message ?? `killDevice '${target.name}' failed`,
        evidence: payload,
      };
    } catch (error) {
      return { kind: "failed", message: errorMessage(error) };
    }
  }
}
