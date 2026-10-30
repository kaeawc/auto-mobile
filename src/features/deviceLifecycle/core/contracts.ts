import { type FormFactor, type DeviceMatchCriteria } from "../../../models/DeviceMatchCriteria";
import { type ExactDeviceSpecification } from "../../../devices/exactDeviceProvisioning";
import { type DeviceResourceConfiguration } from "../../../models/DeviceResourceConfiguration";
import { BootedDevice, Platform } from "../../../models";
import type { ProvisionDeviceProfile } from "./schemas";

// Export interfaces for type safety
export interface StartDeviceArgs {
  cameraPosterPath?: string;
  cameraPosterQr?: { text: string };
  platform: "android" | "ios";
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  /** Exact Android AVD identity for callers that must never match a sibling by substring. */
  avdName?: string;
  formFactor?: FormFactor;
  requires?: DeviceMatchCriteria["requires"];
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
  runnerReadinessTimeoutMs?: number;
  createIfMissing?: boolean;
  __mcpSessionId?: string;
  /** Daemon-forwarded: the caller is a one-shot `--cli` connection, so it acquires anonymously (#11096). */
  __oneShotCli?: boolean;
  /** Request-local owner admitted before boot; never mint a replacement if recovery fails. */
  __restartResumeSessionUuid?: string;
  /** Routing snapshot carried across acquisition schema parsing. */
  __requesterSessionUuid?: string;
  /** Owner selector candidates captured before boot, so expiry cannot turn resume into a mint. */
  __restartResumeTargets?: readonly import("../../../daemon/sessionManager").RehydrationDeviceReservation[];
  /** Acceptance-only, non-mutating discovery presentation control. */
  presentationOrder?: "forward" | "reverse";
  /** Internal exact runtime identity used by getAndroid. */
  matchExactName?: boolean;
}

/**
 * What binding a booted device's session reads from a start request. The bound device carries
 * the platform, so the request's own may be any platform, an Apple Watch's included (#14908).
 */
export type StartDeviceSessionArgs = Omit<StartDeviceArgs, "platform"> & { platform?: Platform };

export interface GetAndroidArgs {
  avdName?: string;
  deviceId?: string;
  requires?: DeviceMatchCriteria["requires"];
  bootTimeoutMs?: number;
  automationReadyTimeoutMs?: number;
}

export interface GetAppleArgs {
  udid?: string;
  deviceId?: string;
  bootTimeoutMs?: number;
  automationReadyTimeoutMs?: number;
}

export interface ProvisionDeviceArgs {
  /** Exact owner recovery identity retained after the reservation ends. */
  __restartResumeTargets?: readonly import("../../../daemon/sessionManager").RehydrationDeviceReservation[];
  /** Request-local owner snapshot assigned after public schema validation. */
  __restartResumeSessionUuid?: string;
  device: {
    platform: "android" | "ios";
    name: string;
    deviceId?: string;
    /** Android may also name a `deviceProfile`, applied after boot and never provisioned (#14058). */
    spec: ExactDeviceSpecification & { deviceProfile?: ProvisionDeviceProfile };
  };
  boot: boolean;
  readiness: "automation" | "none";
  resources?: DeviceResourceConfiguration;
  timeoutMs?: number;
  __mcpSessionId?: string;
  /** Daemon-forwarded one-shot `--cli` marker (#11096). */
  __oneShotCli?: boolean;
  /** Daemon-provided remaining transport budget. */
  __mcpRequestTimeoutMs?: number;
  /** Daemon-provided absolute transport deadline. */
  __mcpRequestDeadlineMs?: number;
  /** Daemon-generated key of this forwarded call; correlates a cancellation outcome. */
  __mcpLiveDeadlineKey?: string;
}

/** Only in-process binding reconciliation may retain a created simulator for readiness retry. */
export interface InternalProvisionDeviceArgs extends ProvisionDeviceArgs {
  rollbackOnRetryableReadiness?: boolean;
  /** Android: boot the emulator with `-no-snapshot-save` (#15477). */
  discardSnapshotOnExit?: boolean;
}

export interface KillDeviceArgs {
  device: BootedDevice;
  /**
   * Drop the AVD-name comparisons on the way to the kill -- the kill-time
   * emulator-console probe here, and the platform kill's own re-discovery check
   * in `AndroidEmulatorClient.killDevice` -- and act on whatever occupies the
   * serial (#6864). Defaults to false; see
   * {@link FORCE_SKIP_AVD_VERIFICATION_DESCRIPTION}.
   */
  force?: boolean;
}

export interface TeardownDeviceArgs {
  target: {
    platform: Platform;
    isVirtual: true;
    stableId: string;
    stableName?: string;
  };
  mode: "destroy";
  verifyAbsence: true;
  timeoutMs?: number;
  /**
   * Opt into cancellation of the accepted teardown on request abort. The
   * default preserves ordinary idempotent teardown continuation semantics.
   */
  cancellationPolicy?: "cancel-on-request-abort";
  /**
   * Drop the AVD-name comparisons on the way to the kill -- the kill-time
   * emulator-console probe here, and the platform kill's own re-discovery check
   * in `AndroidEmulatorClient.killDevice` -- and act on whatever occupies the
   * serial (#6864). Defaults to false; see
   * {@link FORCE_SKIP_AVD_VERIFICATION_DESCRIPTION}.
   */
  force?: boolean;
}
