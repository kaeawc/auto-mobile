import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";
import type { AdmitColdBoot } from "../../models/BootAdmission";
import type { AndroidEmulatorLaunchOutcome } from "./EmulatorLauncher";

export interface AndroidEmulatorLaunchRequest {
  /** Host still image used as the virtual-scene back-camera wall poster at boot. */
  cameraPosterPath?: string;
  /** The configured Android Virtual Device to launch. */
  avdName: string;
  /**
   * The expected ADB serial, when the caller already knows it. This remains
   * authoritative during readiness checks instead of relying on AVD-name
   * discovery from a concurrently starting emulator.
   */
  deviceId?: string;
  /** Additional, already-tokenized emulator arguments. */
  extraArgs?: readonly string[];
  /** Cancels a launch that has not begun, or disposes a completed launch. */
  signal?: AbortSignal;
  /**
   * Boot admission (#11181), awaited only on the cold-spawn path: after the
   * in-process join and the already-running/starting adoption checks, so
   * adopting a running AVD is never refused for capacity.
   */
  admitColdBoot?: AdmitColdBoot;
}

/** Optional readiness behavior for callers recovering an existing guest state. */
export interface AndroidEmulatorReadinessOptions {
  /** Preserve the guest's restored display and keyguard state instead of waking it. */
  skipWakeAndUnlock?: boolean;
  /**
   * The device was just created by a fresh provision, so its first boot is a
   * genuine cold boot (no quick-boot snapshot to restore). When its serial sits
   * in ADB `offline` past a bounded threshold, attempt one `adb -s <serial> reconnect`
   * re-detect, then continue readiness polling through the caller's
   * timeout. A quick-boot-after-shutdown restore leaves this unset and skips
   * that recovery attempt.
   */
  freshProvision?: boolean;
}

export interface AndroidEmulatorLaunchHandle {
  readonly avdName: string;
  readonly process: ChildProcess | null;
  readonly outcome: AndroidEmulatorLaunchOutcome;
  readonly targetDeviceId?: string;
  /** Stops the emulator only when this launch created its process. */
  dispose(): void;
  release(): void;
}
