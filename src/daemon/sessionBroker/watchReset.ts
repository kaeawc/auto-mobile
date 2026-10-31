import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models/DeviceInfo";
import type { BootCapacityReserver } from "../../models/IosBootInstrumentation";
import { errorMessage } from "../../utils/describeUnknownError";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type {
  ListedWatch,
  WatchSimulatorLifecycle,
} from "../../utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { ResetBootRunner, ResetOutcome } from "./devicePort";
import type { BrokerNativeProfile } from "./profile";
import { ResetFailureError } from "./ResetFailureError";

export type WatchResetProfile = Extract<BrokerNativeProfile, { platform: "watchos" }>;

/**
 * The broker's iOS reuse mode, applied to an Apple Watch simulator (owner decision, #15882:
 * between executions a watch follows the iOS simulator policy). `off` never reaches a reset: the
 * watch is destroyed on release, like an iPhone.
 */
export type WatchResetPolicy =
  | { mode: "erase" }
  | { mode: "keep-booted"; fallback: "erase" | "destroy" }
  | { mode: "minimal" };

/**
 * Why a watch cannot run the iOS keep-booted cleaning. The iOS path replays the session's
 * device-mutation journal against a captured pool-entry app baseline, sanitizes residue and
 * probes CtrlProxy health. A watch session records no mutation journal, has no pool-entry
 * baseline and no automation runner to probe, so that cleaning cannot prove a watch clean; the
 * mode's configured fallback (erase or destroy) runs instead, as it does for an iPhone whose
 * baseline is missing.
 */
export const WATCH_KEEP_BOOTED_UNSUPPORTED =
  "watchos-keep-booted-unsupported: a watch session has no mutation journal, pool-entry app " +
  "baseline or CtrlProxy health probe, so keep-booted cleaning cannot prove it clean";

/**
 * Why a watch cannot run the iOS minimal reset. Its first step uninstalls the apps the session's
 * mutation journal recorded, which a watch session does not record, and its appearance, content
 * size, pasteboard and Files-fixture steps have no watchOS equivalent. The minimal mode has no
 * erase fallback by design (#14682), so the watch is destroyed, as an iPhone whose minimal
 * cleaning cannot complete is.
 */
export const WATCH_MINIMAL_UNSUPPORTED =
  "watchos-minimal-unsupported: the session's installed watch apps are not journaled and the " +
  "minimal appearance, content-size, pasteboard and Files-fixture steps have no watchOS " +
  "equivalent; minimal mode never erases, so the watch is destroyed";

export interface WatchResetDependencies {
  /** Fresh watch listing (exact runtime/device type/state) and the admitted watch boot. */
  lifecycle: Pick<WatchSimulatorLifecycle, "findWatch" | "boot">;
  simctl: Pick<SimCtl, "eraseSimulator">;
  /** Stops the watch through the ordinary lifecycle handler, which ends its sessions first. */
  stopDevice: (device: BootedDevice) => Promise<void>;
  timer: Pick<Timer, "now">;
  policy: WatchResetPolicy;
  /**
   * The simulator gate's slot reservation. The erase reserves the watch's reboot against its own
   * UDID before stopping it, as the iPhone reset does, so the slot the stop frees cannot be taken
   * by another boot before the reboot. Absent when the host gates no simulator boots.
   */
  reserveBoot?: BootCapacityReserver["reserveBoot"];
}

/**
 * Release reset for a pooled Apple Watch simulator. Its only cleaning is the erase: stop the
 * watch, `simctl erase` it while shut down, then boot it again through the simulator boot gate
 * and confirm it Booted with its exact runtime and device type. Keep-booted runs that erase as its
 * fallback (or destroys) and minimal destroys; see the two reasons above.
 */
export class WatchSimulatorReset {
  constructor(private readonly dependencies: WatchResetDependencies) {}

  async resetWithTiming(
    device: BootedDevice,
    profile: WatchResetProfile,
    assertOwned: () => Promise<void>,
    options: { signal?: AbortSignal; runResetBoot?: ResetBootRunner } = {},
  ): Promise<ResetOutcome> {
    assertWatchResetInput(device, profile);
    const policy = this.dependencies.policy;
    switch (policy.mode) {
      case "erase":
        return this.erase(device, profile, assertOwned, { ...options, mode: "erase" });
      case "keep-booted":
        if (policy.fallback === "destroy") {
          logger.info(
            `[SessionBroker] watch ${device.deviceId} keep-booted release destroys: ${WATCH_KEEP_BOOTED_UNSUPPORTED}`,
          );
          return {
            outcome: "pending",
            mode: "keep-booted",
            phases: {},
            fallbackReason: WATCH_KEEP_BOOTED_UNSUPPORTED,
          };
        }
        return this.erase(device, profile, assertOwned, {
          ...options,
          mode: "keep-booted",
          fallbackReason: WATCH_KEEP_BOOTED_UNSUPPORTED,
        });
      case "minimal":
        logger.info(
          `[SessionBroker] watch ${device.deviceId} minimal release destroys: ${WATCH_MINIMAL_UNSUPPORTED}`,
        );
        return {
          outcome: "pending",
          mode: "minimal",
          phases: {},
          fallbackReason: WATCH_MINIMAL_UNSUPPORTED,
        };
    }
  }

  private async erase(
    device: BootedDevice,
    profile: WatchResetProfile,
    assertOwned: () => Promise<void>,
    {
      signal,
      runResetBoot,
      mode,
      fallbackReason,
    }: {
      signal?: AbortSignal;
      runResetBoot?: ResetBootRunner;
      mode: "erase" | "keep-booted";
      fallbackReason?: string;
    },
  ): Promise<ResetOutcome> {
    const phases: Record<string, number> = {};
    const owned = async () => {
      signal?.throwIfAborted();
      await assertOwned();
      signal?.throwIfAborted();
    };
    try {
      await owned();
      const operation = () => this.reservedEraseAndBoot(device, profile, owned, { phases, signal });
      await (runResetBoot ? runResetBoot(operation) : operation());
      await owned();
    } catch (error) {
      throw new ResetFailureError(
        errorMessage(error),
        { outcome: "pending", mode, phases, fallbackReason: errorMessage(error) },
        { cause: error },
      );
    }
    return mode === "erase"
      ? { outcome: "clean", mode, phases }
      : { outcome: "fallback:erase", mode, phases, ...(fallbackReason ? { fallbackReason } : {}) };
  }

  /**
   * Holds the watch's boot slot from before its stop until its reboot. A refused reservation
   * happens before any mutation, so the watch is left booted and untouched.
   */
  private async reservedEraseAndBoot(
    device: BootedDevice,
    profile: WatchResetProfile,
    owned: () => Promise<void>,
    options: { phases: Record<string, number>; signal?: AbortSignal },
  ): Promise<void> {
    const reservation = await this.dependencies.reserveBoot?.({
      replacingDeviceId: device.deviceId,
      timeoutMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
      reason: "reset",
      signal: options.signal,
    });
    const operation = () => this.eraseAndBoot(device, profile, owned, options);
    try {
      await (reservation ? reservation.run(operation) : operation());
    } finally {
      reservation?.release();
    }
  }

  private async eraseAndBoot(
    device: BootedDevice,
    profile: WatchResetProfile,
    owned: () => Promise<void>,
    { phases, signal }: { phases: Record<string, number>; signal?: AbortSignal },
  ): Promise<void> {
    // A redriven reset can find the watch already shut down (erased, then refused a boot slot):
    // it is erased again, so a retry never trusts an earlier pass.
    const before = await this.expectedWatch(device, profile, signal, "start watch reset");
    if (before.isRunning) {
      await owned();
      await this.measure(phases, "stop", () => this.dependencies.stopDevice(device));
    }
    const stopped = await this.expectedWatch(device, profile, signal, "erase watch");
    if (stopped.isRunning) {
      throw new ActionableError(
        `Cannot erase Apple Watch simulator '${device.deviceId}': it is still ${stopped.state}`,
      );
    }
    await owned();
    await this.measure(phases, "erase", () =>
      this.dependencies.simctl.eraseSimulator(device.deviceId),
    );
    await owned();
    await this.measure(phases, "boot", () =>
      this.dependencies.lifecycle.boot(stopped, {
        timeoutMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
        signal,
      }),
    );
    const booted = await this.expectedWatch(device, profile, signal, "confirm erased watch");
    if (!booted.isRunning) {
      throw new ActionableError(
        `Apple Watch simulator '${device.deviceId}' did not report Booted after its erase`,
      );
    }
  }

  /** A fresh watch listing must show this exact watch with its profile's runtime and device type. */
  private async expectedWatch(
    device: BootedDevice,
    profile: WatchResetProfile,
    signal: AbortSignal | undefined,
    action: string,
  ): Promise<ListedWatch> {
    const watch = await this.dependencies.lifecycle.findWatch(
      { deviceId: device.deviceId },
      signal,
    );
    if (watch.runtimeId !== profile.runtime || watch.deviceType !== profile.deviceType) {
      throw new ActionableError(
        `Cannot ${action}: Apple Watch simulator '${device.deviceId}' is ` +
          `${watch.deviceType ?? "an unknown device type"} on ${watch.runtimeId ?? "an unknown runtime"}, ` +
          `not ${profile.deviceType} on ${profile.runtime}`,
      );
    }
    return watch;
  }

  private async measure<T>(
    phases: Record<string, number>,
    phase: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = this.dependencies.timer.now();
    try {
      return await operation();
    } finally {
      phases[phase] = this.dependencies.timer.now() - started;
    }
  }
}

function assertWatchResetInput(device: BootedDevice, profile: WatchResetProfile): void {
  if (device.platform !== "watchos" || !device.deviceId.trim()) {
    throw new ActionableError("A watch reset requires an exact Apple Watch simulator UDID");
  }
  if (!profile.runtime.trim() || !profile.deviceType.trim()) {
    throw new ActionableError("A watch reset requires the watch's exact runtime and device type");
  }
}
