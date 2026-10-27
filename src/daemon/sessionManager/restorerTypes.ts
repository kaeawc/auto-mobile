import type { DbWriteBarrier } from "../../db/dbWriteBarrier";
import type { ScreenReaderRestoreState } from "../../features/accessibility/ScreenReaderRestore";
import type { RotationRestoreState } from "../../features/action/Rotate";
import type { DeviceClockRestoreState } from "../../features/utility/DeviceClock";
import type {
  BiometricEnrollment,
  NetworkConditionProfile,
} from "../../features/utility/DeviceState";
import type { BootedDevice } from "../../models";
import type { BackoffPolicy } from "../../utils/Backoff";
import type {
  KeepScreenAwakeRestoreOutcome,
  KeepScreenAwakeState,
} from "../../utils/KeepScreenAwakeManager";
import type { IosAppNetworkRuleRestorer } from "../iosAppNetworkLease";
import type { IosAppNetworkRuleSessionState } from "../sessionDeviceStateRestore";
import type { SessionDeviceReboundEmitter } from "../sessionDeviceReboundBroadcast";

/**
 * Narrow seam for restoring keep-awake state on session release. Production uses
 * `KeepScreenAwakeManager`; tests inject a fake to assert (without a real device)
 * that `releaseSession` reads the typed `keepScreenAwake` slot and passes its full
 * payload to `restore` — the behavioral half of the #2973 typed-slot round trip.
 */
export interface KeepScreenAwakeRestorer {
  restore(state: KeepScreenAwakeState): Promise<KeepScreenAwakeRestoreOutcome>;
}

/** Original simulator enrollment restored when a session releases its device. */
export interface BiometricEnrollmentSessionState {
  initialEnrollment: BiometricEnrollment;
}

/** What a pending restore must write, resolved before any await (see below). */
/** One restore a release started; `abandon` records it when the teardown cap expires first. */
export interface ReleaseTeardownStage {
  /** In-flight setup can still drive the serial even when restoration is skipped. */
  setup?: boolean;
  pending: Promise<void> | null;
  abandon?: () => void;
}

/** Narrow seam for restoring iOS Simulator biometric enrollment on release. */
export interface BiometricEnrollmentRestorer {
  restore(enrollment: BiometricEnrollment): Promise<void>;
}

/**
 * Original device-wide network condition restored when a session releases its
 * device (issue #6012). Written the first time a session degrades the network,
 * so release/expiry never hands an impaired device back to the pool.
 */
export interface NetworkConditionSessionState {
  initialProfile: NetworkConditionProfile;
  /**
   * iOS Simulator only (#10264): the one app this session took offline through
   * the network-extension filter. Restoring removes this session's rule rather
   * than resetting the whole device.
   */
  iosAppRule?: IosAppNetworkRuleSessionState;
}

/** What a pending network restore must write, resolved before any await. */

/** Original auto-time value recorded before the first session clock write. */
export type ClockSessionState = DeviceClockRestoreState;

export interface ClockRestorer {
  restore(state: ClockSessionState, signal?: AbortSignal): Promise<void>;
}

/** Original rotation settings recorded before the first session settings write. */
export type RotationSessionState = RotationRestoreState;

export interface RotationRestorer {
  restore(state: RotationSessionState, signal?: AbortSignal): Promise<void>;
}

/** TalkBack/VoiceOver state recorded before the first `accessibility` toggle in a session (#10146). */
export type ScreenReaderSessionState = ScreenReaderRestoreState;

export interface ScreenReaderRestorer {
  restore(state: ScreenReaderSessionState, signal?: AbortSignal): Promise<void>;
}

/** Overrides for the per-session device-state restorers; each omitted one uses production wiring. */
export interface DeviceStateRestorerFactories {
  networkCondition?: (device: BootedDevice) => NetworkConditionRestorer;
  clock?: (device: BootedDevice) => ClockRestorer;
  rotation?: (device: BootedDevice) => RotationRestorer;
  /** Delay before each rotation restore retry; defaults to a short exponential backoff. */
  rotationBackoff?: BackoffPolicy;
  screenReader?: (device: BootedDevice) => ScreenReaderRestorer;
  /** Delay before each screen-reader restore retry; defaults to a short exponential backoff. */
  screenReaderBackoff?: BackoffPolicy;
  /** iOS Simulator per-app network rules (#10264); defaults to the installed controller. */
  iosAppNetworkRule?: IosAppNetworkRuleRestorer;
}

/**
 * Everything SessionManager can be constructed with beyond `(timer, repository)`. Every field is
 * optional and defaults to the production wiring (#11796).
 */
export interface SessionManagerOptions {
  sessionDeviceReboundEmitter?: SessionDeviceReboundEmitter;
  /**
   * Resolve per write: closeDatabase() -> resetDbWriteBarrier() makes the next track()
   * use a fresh barrier, not a pinned drained instance (#2912, #3154, #2885).
   */
  barrier?: () => DbWriteBarrier;
  /** Keep-awake restore seam (#2973); tests assert the typed slot's payload reaches `restore`. */
  keepScreenAwakeRestorer?: (device: BootedDevice) => KeepScreenAwakeRestorer;
  /** Simulator enrollment restore seam, parallel to keep-awake so tests never invoke simctl. */
  biometricEnrollmentRestorer?: (device: BootedDevice) => BiometricEnrollmentRestorer;
  restorers?: DeviceStateRestorerFactories;
}

/** Narrow seam for restoring the device-wide network condition on release. */
export interface NetworkConditionRestorer {
  restore(profile: NetworkConditionProfile): Promise<void>;
}
