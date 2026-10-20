import type { IosAppNetworkRule } from "../features/networkFilter/IosAppNetworkRuleClient";
import type { DeviceClockRestoreRegistry } from "../features/utility/DeviceClock";
import type { BiometricEnrollment, NetworkConditionProfile } from "../features/utility/DeviceState";
import type { BootedDevice } from "../models";
import type { BackoffPolicy } from "../utils/Backoff";
import type { KeepScreenAwakeState } from "../utils/KeepScreenAwakeManager";
import type { Timer } from "../utils/SystemTimer";
import type { DeviceHealthReason } from "./deviceHealthMarkers";
import type { IosAppNetworkLeaseOptions, IosAppNetworkRuleRestorer } from "./iosAppNetworkLease";
import {
  type BiometricEnrollmentRestorer,
  type ClockRestorer,
  type KeepScreenAwakeRestorer,
  type NetworkConditionRestorer,
  type RotationRestorer,
  type ScreenReaderRestorer,
  type Session,
} from "./sessionManager";

/** The per-app rule a session owns on an iOS Simulator (#10264). */
export interface IosAppNetworkRuleSessionState {
  udid: string;
  bundleId: string;
  /** Fixed for this session binding; a later binding allocates a newer one. */
  ownerGeneration: number;
  /** The newest revision this session has sent for the target (apply or reset). */
  lastRevision: number;
  /** The revision the provider acknowledged as installed, while it is believed active. */
  installedRevision?: number;
}

/** Keep-awake restore resolved before any await, like the biometric target below. */
export interface KeepScreenAwakeRestoreTarget {
  restoreGeneration?: number;
  incarnation?: number;
  sessionId: string;
  deviceId: string;
  state: KeepScreenAwakeState;
}

export interface BiometricRestoreTarget {
  restoreGeneration?: number;
  incarnation?: number;
  sessionId: string;
  deviceId: string;
  enrollment: BiometricEnrollment;
}

export interface NetworkConditionRestoreTarget {
  restoreGeneration?: number;
  incarnation?: number;
  sessionId: string;
  deviceId: string;
  profile: NetworkConditionProfile;
  /**
   * iOS Simulator: remove this exact rule, with a reset revision allocated when
   * the target was captured — newer than any apply this session sent.
   */
  iosAppRule?: IosAppNetworkRule;
}

/** What SessionDeviceStateRestore needs from the session manager that owns it (#11795). */
export interface SessionDeviceStateRestoreHost {
  readonly timer: Timer;
  /** Run one restore under the release teardown's identity-replacement fences. */
  dispatchDeviceRestore(
    deviceId: string,
    restore: (
      signal: AbortSignal,
      identitySignal: AbortSignal,
      acknowledge: () => void,
    ) => Promise<void>,
    generation?: number,
    teardownStep?: number,
  ): Promise<void>;
  /** The device's replaced-restore generation; a changed value supersedes a captured restore. */
  restoreGeneration(deviceId: string): number;
  hasIdentityReplacementFence(deviceId: string): boolean;
  /** Track a setup so a bounded release still waits for it. */
  trackSessionSetup(session: Session, createSetup: () => Promise<void>): Promise<void>;
  /** Whether this exact incarnation is still the published session. */
  isPublished(session: Session): boolean;
  /** The pool incarnation the device's health markers are keyed by, if it has one. */
  healthIncarnation(deviceId: string): number | undefined;
  /** Whether a captured restore still targets the current incarnation and restore generation. */
  restoreIncarnationIsCurrent(target: {
    deviceId: string;
    incarnation?: number;
    restoreGeneration?: number;
  }): boolean;
  clearRestoreHealth(
    target: { deviceId: string; incarnation?: number },
    reason: DeviceHealthReason,
  ): void;
  markHealth(deviceId: string, incarnation: number, reason: DeviceHealthReason): void;
  clearHealthMarker(deviceId: string, incarnation: number, reason: DeviceHealthReason): void;
  /** Wait out a device-identity replacement fence; false when the restore was superseded. */
  waitForIdentityReplacement(deviceId: string, generation: number): Promise<boolean>;
  /** Record an exhausted restore as a health marker and start background recovery. */
  abandonRestore(
    target: { deviceId: string; incarnation?: number },
    reason: Exclude<DeviceHealthReason, "clock">,
    restore: () => Promise<void>,
    restoreTimeoutMs?: number,
  ): void;
  /** The tracked session setups still in flight for exactly this session incarnation. */
  sessionSetupsOf(session: Session): Promise<void>[];
  /** Wait for those setups without changing saved state; resolves with what is still pending. */
  waitForSessionSetup(
    sessionId: string,
    setups: readonly Promise<void>[],
    phase?: "release" | "rebind",
  ): Promise<{ pending: Promise<void> | null }>;
  /** Record the deadline of a capped teardown stage so it survives the hand-off to quarantine. */
  noteTeardownBound(bounded: Promise<void>, settlesBy: number): void;
  /** Quarantine the device until the cleanups settle. */
  trackPendingDeviceCleanup(deviceId: string, cleanups: readonly Promise<unknown>[]): void;
  /** True while `session` is live and not releasing. */
  isAdmittedForAutomation(session: Session): boolean;
  /** The clock every session timestamp is stamped and judged with. */
  sessionNow(): number;
  /**
   * Quarantine the device until `cleanup` settles, capped at `capMs`. Must be called
   * synchronously after the work is dispatched so a concurrent release observes it.
   */
  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>, capMs: number): void;
}

export interface SessionDeviceStateRestoreOptions {
  networkCondition: (device: BootedDevice) => NetworkConditionRestorer;
  biometricEnrollment: (device: BootedDevice) => BiometricEnrollmentRestorer;
  keepScreenAwake: (device: BootedDevice) => KeepScreenAwakeRestorer;
  screenReader: (device: BootedDevice) => ScreenReaderRestorer;
  screenReaderBackoff: BackoffPolicy;
  rotation: (device: BootedDevice) => RotationRestorer;
  rotationBackoff: BackoffPolicy;
  clock: (device: BootedDevice) => ClockRestorer;
  /** The registry that serializes clock restores per device; defaults to the process-wide one. */
  clockRegistry?: DeviceClockRestoreRegistry;
  /** Injected iOS per-app rule restorer; else `defaultIosAppNetworkRuleRestorer()`. */
  iosAppNetworkRuleRestorer?: IosAppNetworkRuleRestorer;
  defaultIosAppNetworkRuleRestorer: () => IosAppNetworkRuleRestorer;
  iosLease: IosAppNetworkLeaseOptions;
}
