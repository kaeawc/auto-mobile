import { holderOf } from "../../deviceBinding";
import type { DeviceInfo } from "../../../models/index";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { PooledDevice } from "../../devicePool";
import { deviceStableId, type BindingDeviceClaim, type BindingDeviceClaims } from "./reconciler";
import type { LiveExecutionSessions } from "../registry/ownerLiveness";
import type { BindingPlatform } from "../registry/bindingRegistry";

export interface BindingClaimPool {
  getAllDevices(): PooledDevice[];
  /** Throws when another live daemon claims the device. */
  assertNotClaimedByForeignDaemon(deviceId: string, platform: BindingPlatform): Promise<void>;
}

/**
 * A device is held while a pooled runtime of it has a session, or another daemon claims it. A
 * running device whose runtime identity the pool cannot resolve is unknown, never free.
 */
export class PoolBindingDeviceClaims implements BindingDeviceClaims {
  constructor(
    private readonly pool: BindingClaimPool,
    private readonly executions?: LiveExecutionSessions,
  ) {}

  isLiveExecution(sessionUuid: string): boolean {
    return this.executions?.isLiveManagedExecutionSession(sessionUuid) ?? false;
  }

  async describe(device: DeviceInfo): Promise<BindingDeviceClaim> {
    const runtimes = this.runtimesOf(device);
    const held = runtimes.find((pooled) => holderOf(pooled) !== null);
    if (held) {
      return { kind: "held", reason: `session ${holderOf(held)} holds ${held.id}` };
    }
    // The listing reports an unknown running state as isRunning:false, so the flag alone is not
    // evidence the device is stopped.
    if (device.isRunningStateKnown === false && runtimes.length === 0) {
      return { kind: "unknown", reason: "its running state could not be determined" };
    }
    if (device.platform === "android" && this.hasUnresolvedSessionRuntime()) {
      return { kind: "unknown", reason: "a session holds an emulator whose AVD is unresolved" };
    }
    for (const runtime of runtimes) {
      try {
        await this.pool.assertNotClaimedByForeignDaemon(runtime.id, device.platform);
      } catch (error) {
        return { kind: "held", reason: errorMessage(error) };
      }
    }
    return { kind: "free" };
  }

  sessionsOn(device: DeviceInfo): string[] {
    return this.runtimesOf(device).flatMap((pooled) =>
      holderOf(pooled) ? [holderOf(pooled)!] : [],
    );
  }

  /** A session-held emulator whose AVD name has not resolved may be any configured AVD. */
  private hasUnresolvedSessionRuntime(): boolean {
    return this.pool
      .getAllDevices()
      .some(
        (pooled) =>
          pooled.platform === "android" &&
          holderOf(pooled) !== null &&
          !pooled.avdName &&
          pooled.name.startsWith("Unknown ("),
      );
  }

  /** The pooled runtimes of a configured device (AVD name or simulator UDID). */
  private runtimesOf(device: DeviceInfo): PooledDevice[] {
    const stableId = deviceStableId(device);
    return this.pool
      .getAllDevices()
      .filter(
        (pooled) =>
          pooled.platform === device.platform &&
          (device.platform === "android"
            ? (pooled.avdName ?? pooled.name) === stableId
            : pooled.id === stableId),
      );
  }
}
