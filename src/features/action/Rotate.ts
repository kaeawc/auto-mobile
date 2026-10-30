import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { Mutex } from "async-mutex";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { parseAndroidDisplayInfos } from "../../utils/android-cmdline-tools/AndroidDisplayParsers";
import { BaseVisualChange, type DisplayFenceDependencies } from "./BaseVisualChange";
import { BootedDevice, ObserveResult, RotateResult } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { ProgressCallback } from "./BaseVisualChange";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../observe/ios";
import { readWindowManagerRotation } from "../../utils/android-cmdline-tools/readWindowManagerRotation";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { observedIosOrientation, verifyIosRotation } from "./iosRotateVerification";
import { ROTATION_READ_FLOOR_MS } from "../observe/Idle";
import {
  orientationFromRotation,
  readNaturalLandscape,
  rotationForOrientation,
} from "./OrientationReader";
import { resolveRotateCall, type RotateCall } from "./ActionCall";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";
import { RotationSettingsStore } from "./RotationSettingsStore";
import {
  RotationOrientationReader,
  ERROR_RECOVERY_SETTLE_PROFILE,
  SETTLE_WAIT_POLL_INTERVAL_MS,
} from "./RotationOrientationReader";
import { RotationOutcomes, type AutoRotatePlan } from "./RotationOutcomes";
import { RotationEndConfirmation } from "./RotationEndConfirmation";
import {
  DEVICE_STATE_ROTATION_LOCK,
  ROTATION_RETURN_CONFIRMATION_TIMEOUT_MS,
  ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
  type RotationCallSettings,
  type RotationContext,
  type RotationRestoreSlot,
  type RotationRestoreState,
  type RotationSettingCleanup,
} from "./RotationSupport";

export { unlockDeviceStateRotationEntry } from "./RotationSupport";
export type { RotationRestoreSlot, RotationRestoreState } from "./RotationSupport";

interface AndroidRotationWrites {
  settings?: RotationCallSettings;
  restoreOnFailure: (result: RotateResult) => Promise<RotateResult>;
}

export interface RotateOptions {
  deadlineMs?: number;
  sessionRotation?: <T>(mutation: (slot?: RotationRestoreSlot) => Promise<T>) => Promise<T>;
}

/** Bound on `cmd display get-displays` when enumerating displays. */
const DISPLAY_LIST_TIMEOUT_MS = 2_000;
// Reads of a non-default display's rotation after `cmd window user-rotation -d` (150ms apart).
const DISPLAY_ROTATION_CONFIRM_ATTEMPTS = 5;

type RotationPerf = ReturnType<typeof createGlobalPerformanceTracker>;

/** The per-call inputs every Android rotation step needs (#11835). */
interface AndroidRotationRun {
  orientation: "portrait" | "landscape";
  perf: RotationPerf;
  lockOrientation: boolean | undefined;
  signal?: AbortSignal;
}

export class Rotate extends BaseVisualChange {
  // Serializes the read-auto-rotate -> disable -> rotate -> restore-auto-rotate
  // critical section per device, so two concurrent rotations against the SAME
  // device cannot interleave: without this, one rotation could read the
  // other's temporary `accelerometer_rotation=0` as the "prior state" and
  // later restore auto-rotate to the wrong value (#6199 review). Keyed by
  // deviceId (not per-instance) since a new Rotate is constructed per tool
  // call. Deliberately NOT shared across different devices.
  private static readonly rotationLocks = new Map<string, Mutex>();

  private readonly store: RotationSettingsStore;
  private readonly reader: RotationOrientationReader;
  private readonly outcomes: RotationOutcomes;
  private readonly endConfirmation: RotationEndConfirmation;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    timer: Timer = defaultTimer,
    private readonly options: RotateOptions = {},
    collaborators: DisplayFenceDependencies = {},
  ) {
    super(device, adb, timer, undefined, collaborators);
    const ctx = (): RotationContext => ({
      device: this.device,
      adb: this.adb,
      timer: this.timer,
      awaitIdle: this.awaitIdle,
      deadlineMs: this.options.deadlineMs,
    });
    this.store = new RotationSettingsStore(ctx);
    this.reader = new RotationOrientationReader(ctx, this.store);
    this.outcomes = new RotationOutcomes(ctx, this.reader, this.store);
    this.endConfirmation = new RotationEndConfirmation(ctx, this.reader, this.store, (signal) =>
      this.readLiveRotation(signal),
    );
  }

  /** Live rotation read, also the seam tests drive the end-of-call confirmation through. */
  private readLiveRotation(signal?: AbortSignal): Promise<number | null> {
    return this.reader.readLiveRotation(signal);
  }

  private readLiveRotationWithSettleWait(
    requestedOrientation: "portrait" | "landscape",
    signal?: AbortSignal,
  ): Promise<number | null> {
    return this.reader.readLiveRotationWithSettleWait(
      requestedOrientation,
      signal,
      ERROR_RECOVERY_SETTLE_PROFILE,
    );
  }

  getCurrentOrientation(signal?: AbortSignal): Promise<string> {
    return this.reader.getCurrentOrientation(signal);
  }

  async getRestoreState(
    signal?: AbortSignal,
  ): Promise<RotationRestoreState | { orientation: string }> {
    throwIfAborted(signal);
    if (this.device.platform === "ios") {
      throw new ActionableError("iOS rotation restore state is unobservable");
    }
    const state: RotationRestoreState = { accelerometerRotation: null, userRotation: null };
    await this.captureSessionRotationOriginals({
      state,
      captureAccelerometer: true,
      captureUser: true,
      signal,
    });
    await this.captureDeviceStateRotationLock(state, signal);
    return state;
  }

  /**
   * Check if orientation is locked
   * @returns Promise with boolean indicating if auto-rotation is disabled
   */
  async isOrientationLocked(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    return (await this.reader.getAutoRotateState(signal)) === "locked";
  }

  private getRotationLock(): Mutex {
    let lock = Rotate.rotationLocks.get(this.device.deviceId);
    if (!lock) {
      lock = new Mutex();
      Rotate.rotationLocks.set(this.device.deviceId, lock);
    }
    return lock;
  }

  /** Restore recorded settings through the same CtrlProxy-first/ADB fallback as rotation. */
  async restoreRotationSettings(state: RotationRestoreState, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.getRotationLock().runExclusive(() =>
      this.store.writeRotationSettings({ state, signal, skipIfCurrent: true }),
    );
  }

  async execute(orientation: "portrait" | "landscape", call?: RotateCall): Promise<RotateResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    orientation: "portrait" | "landscape",
    progress?: ProgressCallback,
    lockOrientation?: boolean,
    signal?: AbortSignal,
    display?: number,
  ): Promise<RotateResult>;
  async execute(
    orientation: "portrait" | "landscape",
    progressOrCall?: ProgressCallback | RotateCall,
    lockOrientationArg?: boolean,
    signalArg?: AbortSignal,
    displayArg?: number,
  ): Promise<RotateResult> {
    const {
      progress,
      lockOrientation,
      signal,
      display = 0,
    } = resolveRotateCall(progressOrCall, lockOrientationArg, signalArg, displayArg);
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("rotate");

    try {
      switch (this.device.platform) {
        case "ios":
          if (display !== 0) {
            throw new ActionableError(
              "Selecting a non-default display for rotate is supported only on Android devices.",
            );
          }
          return await this.executeIosRotation(orientation, progress, perf, signal);
        case "android":
          if (display !== 0) {
            return await this.rotateNonDefaultDisplay(
              orientation,
              display,
              lockOrientation,
              signal,
            );
          }
          return await this.executeAndroidRotation(
            { orientation, perf, lockOrientation, signal },
            progress,
          );
        default:
          throw unsupportedPlatformError(this.device.platform, "rotate the device");
      }
    } catch (error) {
      throw toActionableError(
        error,
        signal?.aborted
          ? "Rotation cancelled; device may still complete the change"
          : "Failed to rotate device",
      );
    }
  }

  private async rotateNonDefaultDisplay(
    orientation: "portrait" | "landscape",
    display: number,
    lockOrientation: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<RotateResult> {
    await this.assertDisplayExists(display, signal);
    const naturalLandscape = await readNaturalLandscape(this.adb, signal, display);
    const rotation = rotationForOrientation(orientation, naturalLandscape);
    const mode = lockOrientation === false ? "free" : "lock";
    await this.adb.executeCommand(
      `shell cmd window user-rotation -d ${display} ${mode} ${rotation}`,
    );
    // The command returning is not proof the display rotated (#10362): read the target
    // display's own rotation back before reporting the requested orientation.
    const actualRotation = await this.readDisplayRotationUntil(
      display,
      (value) => orientationFromRotation(value, naturalLandscape) === orientation,
      signal,
    );
    const base = { orientation, value: rotation, rotationPerformed: true };
    if (actualRotation === null) {
      const warning = `Display ${display}'s orientation after rotation could not be confirmed (live rotation read failed); the requested ${orientation} orientation may not be held.`;
      return { ...base, success: true, currentOrientation: "unknown", warning, message: warning };
    }
    const actual = orientationFromRotation(actualRotation, naturalLandscape) ?? "unknown";
    if (actual === orientation) {
      return {
        ...base,
        success: true,
        currentOrientation: orientation,
        message: `Rotated display ${display} to ${orientation}`,
      };
    }
    const error = `Requested ${orientation} on display ${display}, but the display is actually in ${actual} (rotation ${actualRotation}) after the rotation settled.`;
    return {
      ...base,
      success: false,
      currentOrientation: actual,
      rotationPerformed: false,
      error,
      message: error,
    };
  }

  /**
   * Poll one display's live WindowManager rotation until `reached` accepts it, within a bounded
   * budget: at most {@link DISPLAY_ROTATION_CONFIRM_ATTEMPTS} reads, no new read once
   * {@link ROTATION_RETURN_CONFIRMATION_TIMEOUT_MS} has elapsed, and each read capped at
   * {@link ROTATION_READ_FLOOR_MS}. Returns the last rotation read, or null when none was readable.
   */
  private async readDisplayRotationUntil(
    display: number,
    reached: (rotation: number) => boolean,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const start = this.timer.now();
    let last: number | null = null;
    for (let attempt = 1; attempt <= DISPLAY_ROTATION_CONFIRM_ATTEMPTS; attempt++) {
      throwIfAborted(signal);
      try {
        const rotation = await readWindowManagerRotation(this.adb, {
          displayId: display,
          signal,
          timeoutMs: ROTATION_READ_FLOOR_MS,
        });
        last = rotation ?? last;
        if (rotation !== null && reached(rotation)) {
          return rotation;
        }
      } catch (error) {
        throwIfAborted(signal);
        logger.warn(
          `[Rotate] Failed to read display ${display} rotation: ${errorMessage(error)}`,
          error,
        );
      }
      if (
        attempt === DISPLAY_ROTATION_CONFIRM_ATTEMPTS ||
        this.timer.now() - start >= ROTATION_RETURN_CONFIRMATION_TIMEOUT_MS
      ) {
        break;
      }
      await awaitWhileRequestIsLive(this.timer.sleep(SETTLE_WAIT_POLL_INTERVAL_MS), signal);
    }
    return last;
  }

  private async assertDisplayExists(display: number, signal?: AbortSignal): Promise<void> {
    let availableDisplayIds: string[] = [];
    try {
      const displayOutput = await this.adb.executeCommand("shell cmd display get-displays", {
        timeoutMs: DISPLAY_LIST_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
      throwIfAborted(signal);
      availableDisplayIds = parseAndroidDisplayInfos(displayOutput.stdout).map(
        ({ logicalId }) => logicalId,
      );
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      logger.debug(`[Rotate] Could not read Android displays: ${error}`);
    }
    if (availableDisplayIds.length === 0) {
      logger.debug("[Rotate] Android display list is empty; skipping display existence check");
      return;
    }
    if (!availableDisplayIds.includes(String(display))) {
      throw new ActionableError(
        `display ${display} not found; available: ${availableDisplayIds.join(", ")}`,
      );
    }
  }

  private async executeIosRotation(
    orientation: "portrait" | "landscape",
    progress: ProgressCallback | undefined,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    signal?: AbortSignal,
  ): Promise<RotateResult> {
    throwIfAborted(signal);
    let previousObservation: ObserveResult | undefined;
    let runner: Pick<IosCtrlProxy, "requestRotate"> | undefined;
    const result: RotateResult = await this.observedInteraction(
      async (observation) => {
        previousObservation = observation;
        try {
          throwIfAborted(signal);
          const client = IOSCtrlProxyClient.getInstance(this.device);
          runner = client;
          const result = await perf.track("iOSRotation", () =>
            awaitWhileRequestIsLive(client.requestRotate(orientation, 5000, perf), signal),
          );

          if (!result.success) {
            return {
              success: false,
              orientation,
              value: orientation === "portrait" ? 0 : 1,
              error: result.error ?? "Failed to rotate iOS device",
              currentOrientation: result.currentOrientation,
              previousOrientation: result.previousOrientation,
              rotationPerformed: result.rotationPerformed,
            };
          }

          return {
            success: true,
            orientation,
            value: result.value,
            currentOrientation: result.currentOrientation,
            previousOrientation: result.previousOrientation,
            rotationPerformed: result.rotationPerformed,
            orientationLockHandled: false,
            message: result.rotationPerformed
              ? `Successfully rotated from ${result.previousOrientation} to ${result.currentOrientation}`
              : `Device is already in ${orientation} orientation`,
          };
        } catch (error) {
          throwIfAborted(signal);
          throw toActionableError(error, "Failed to rotate iOS device");
        }
      },
      {
        // The runner can report a successful no-op. A hierarchy diff is not
        // evidence that its screen rotated, and a no-op needs no visual change.
        ...OBSERVED_INTERACTION_PROFILES.noTreeResolution,
        timeoutMs: SETTLE_BUDGET_MS.lifecycle,
        progress,
        perf,
        signal,
        skipUiStability: true,
      },
    );
    const verified = verifyIosRotation(result, orientation, previousObservation);
    return verified.success
      ? verified
      : await this.restoreIosOrientationAfterFailure(verified, runner, previousObservation, {
          perf,
          signal,
        });
  }

  /**
   * A rotate the display could not honor (SpringBoard ignores landscape) still leaves the device
   * orientation changed, so the next app launches rotated. Put the prior orientation back.
   */
  private async restoreIosOrientationAfterFailure(
    failed: RotateResult,
    client: Pick<IosCtrlProxy, "requestRotate"> | undefined,
    previousObservation: ObserveResult | undefined,
    call: { perf: RotationPerf; signal?: AbortSignal },
  ): Promise<RotateResult> {
    const { perf, signal } = call;
    const prior = observedIosOrientation(previousObservation);
    if (!client || prior === "unknown" || prior === failed.orientation) {
      return failed;
    }
    try {
      throwIfAborted(signal);
      const restored = await perf.track("iOSRotationRestore", () =>
        awaitWhileRequestIsLive(client.requestRotate(prior, 5000, perf), signal),
      );
      if (!restored.success) {
        throw new Error(restored.error ?? "runner reported failure");
      }
      return failed;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`iOS rotation restore to ${prior} failed: ${errorMessage(error)}`, error);
      return {
        ...failed,
        warning: `The device orientation could not be restored to ${prior} after the failed rotate; the next app may open rotated.`,
      };
    }
  }

  private async executeAndroidRotation(
    run: AndroidRotationRun,
    progress: ProgressCallback | undefined,
  ): Promise<RotateResult> {
    throwIfAborted(run.signal);
    this.reader.beginCall();
    try {
      return await this.runAndroidRotation(run, progress);
    } finally {
      this.reader.endCall();
    }
  }

  private async runAndroidRotation(
    run: AndroidRotationRun,
    progress: ProgressCallback | undefined,
  ): Promise<RotateResult> {
    const { orientation, perf, signal } = run;
    const observationOptions = {
      usesObservationForResolution: false,
      changeExpected: true,
      timeoutMs: SETTLE_BUDGET_MS.lifecycle,
      progress,
      perf,
      signal,
      // Rotation animations are incorrectly detected as unstable by gfxinfo.
      skipUiStability: true,
    };
    // The call's own user_rotation write, kept so the end-of-call check can undo it (#14955).
    const written: AndroidRotationWrites = { restoreOnFailure: async (result) => result };
    const result: RotateResult = await this.observedInteraction(
      // The read-auto-rotate -> disable -> rotate -> restore-auto-rotate
      // sequence below must run atomically per device: interleaving it with
      // a concurrent rotation on the same device would let one call observe
      // the other's temporary accelerometer_rotation=0 as the "prior state"
      // (#6199 review). Different devices use independent locks and never
      // wait on each other.
      async () => {
        const acquisition = this.getRotationLock().acquire();
        let release: () => void;
        try {
          release = await awaitWhileRequestIsLive(acquisition, signal);
        } catch (error) {
          // Cancelled waiters must release their eventual acquisition without dispatching.
          void acquisition.then((unlock) => unlock());
          throw toActionableError(error, "Could not acquire the device rotation lock");
        }
        try {
          const mutation = (slot?: RotationRestoreSlot) =>
            this.performAndroidRotation(run, slot, written);
          const result = this.options.sessionRotation
            ? await this.options.sessionRotation(mutation)
            : await mutation();
          // Decide from the completed action under the lock, not a racy pre-read.
          // Successful no-ops still receive a fresh observation without requiring a diff.
          if (result.success && result.rotationPerformed === false) {
            observationOptions.changeExpected = false;
          }
          return result;
        } finally {
          release();
        }
      },
      observationOptions,
    );
    return this.endConfirmation.confirmAndroidOrientationAtReturn({
      result,
      orientation,
      signal,
      settings: written.settings,
      restoreOnFailure: written.restoreOnFailure,
    });
  }

  private async captureSessionRotationOriginals(options: {
    state: RotationRestoreState;
    captureAccelerometer: boolean;
    captureUser: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const { state, captureAccelerometer, captureUser, signal } = options;
    // Retry only originals for settings this path will change. Unknown,
    // untouched auto-rotate still preserves the direct-mode #6199 guard.
    if (captureAccelerometer && state.accelerometerRotation === null) {
      const retry = await this.reader.getAutoRotateState(signal);
      if (retry === "unknown") {
        throw new ActionableError(
          "The current rotation setting accelerometer_rotation could not be read; retry rotation when settings are readable.",
        );
      }
      state.accelerometerRotation = retry === "locked" ? 0 : 1;
    }
    if (captureUser && state.userRotation === null) {
      const retry = await this.store.readUserRotation(signal);
      if (retry === null) {
        throw new ActionableError(
          "The current rotation setting user_rotation could not be read; retry rotation when settings are readable.",
        );
      }
      state.userRotation = retry;
    }
  }

  /** Captured once, with the session's first originals, before any write can change it. */
  private async captureDeviceStateRotationLock(
    state: RotationRestoreState,
    signal?: AbortSignal,
  ): Promise<void> {
    const lock = await this.store.readSetting("secure", DEVICE_STATE_ROTATION_LOCK, signal);
    if (lock !== null) {
      state.deviceStateRotationLock = lock;
    }
  }

  private rotationCallSettings(
    autoRotateState: "locked" | "enabled" | "unknown",
    slot?: RotationRestoreSlot,
    signal?: AbortSignal,
  ): RotationCallSettings {
    const accelerometerRotation =
      autoRotateState === "locked" ? 0 : autoRotateState === "enabled" ? 1 : null;
    const settings: RotationCallSettings = {
      previousUserRotation: null,
      started: false,
      writtenUserRotation: null,
      beforeWrite: async (options = {}) => {
        const original = slot?.get(); // Retirement fences every admitted write.
        if (!settings.started) {
          settings.previousUserRotation = await this.store.readUserRotation(signal);
        }
        const state = original ?? {
          accelerometerRotation,
          userRotation: settings.previousUserRotation,
        };
        if (slot) {
          await this.captureSessionRotationOriginals({
            state,
            captureAccelerometer: options.accelerometerRotation === true,
            captureUser: options.captureUserRotation === true || options.userRotation !== undefined,
            signal,
          });
          if (!settings.started && settings.previousUserRotation === null) {
            settings.previousUserRotation = state.userRotation;
          }
          if (!original) {
            await this.captureDeviceStateRotationLock(state, signal);
          }
          throwIfAborted(signal);
          slot.get();
          if (!original) {
            slot.record(state);
          }
        }
        settings.started = true;
        if (options.userRotation !== undefined) {
          settings.writtenUserRotation = options.userRotation;
        }
      },
    };
    return settings;
  }

  private async finishAndroidRotation(
    result: RotateResult,
    settings: RotationCallSettings,
    run: Pick<AndroidRotationRun, "lockOrientation" | "signal">,
    slot?: RotationRestoreSlot,
  ): Promise<RotateResult> {
    const { lockOrientation, signal } = run;
    if (
      settings.started &&
      !result.success &&
      result.currentOrientation !== "unknown" &&
      result.currentOrientation !== result.orientation
    ) {
      const warning = await this.store.rollbackUserRotation({
        previous: settings.previousUserRotation,
        written: settings.writtenUserRotation,
        signal,
        slot,
      });
      result.warning = [result.warning, warning].filter(Boolean).join(" ") || undefined;
    }
    return this.store.completeSessionRestore(result, lockOrientation, slot, signal);
  }

  /**
   * The read-auto-rotate -> disable -> rotate -> restore-auto-rotate critical
   * section for Android rotation. Callers MUST run this under
   * {@link getRotationLock} to serialize it per device (#6199 review).
   */
  private async performAndroidRotation(
    run: AndroidRotationRun,
    slot?: RotationRestoreSlot,
    written?: AndroidRotationWrites,
  ): Promise<RotateResult> {
    const { orientation, perf, lockOrientation, signal } = run;
    throwIfAborted(signal);
    // Read the natural axes first so the requested value and every orientation read agree.
    const value = rotationForOrientation(orientation, await this.reader.readNaturalAxes(signal));

    // Run getCurrentOrientation and getAutoRotateState in parallel
    const [currentOrientation, autoRotateState] = await perf.track("getOrientationState", () =>
      Promise.all([this.getCurrentOrientation(signal), this.reader.getAutoRotateState(signal)]),
    );

    const settings = this.rotationCallSettings(autoRotateState, slot, signal);
    if (written) {
      written.settings = settings;
    }
    const plan = this.outcomes.resolveAutoRotatePlan(
      autoRotateState,
      lockOrientation,
      slot !== undefined,
    );
    const {
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
      shouldRestoreAutoRotate,
      canForceAutoRotateOff,
    } = plan;
    const cleanup: RotationSettingCleanup = {
      needed: false,
      assertCurrentDevice: () => {
        slot?.get();
      },
    };
    if (written) {
      written.restoreOnFailure = (result) =>
        this.outcomes.restoreAutoRotateAfterFailedLock(result, plan, settings, {
          cleanup,
          sessionMode: slot !== undefined,
        });
    }
    await this.planDeviceStateLock(cleanup, {
      shouldRestoreAutoRotate: !slot && preserveLock && wasAutoRotateEnabled,
      autoRotateState,
      signal,
    });
    const alreadyApplied = await this.outcomes.handleAlreadyAppliedOrientation(
      orientation,
      value,
      currentOrientation,
      {
        autoRotateState,
        plan: {
          preserveLock,
          restoreAutomaticRotation,
          beforeWrite: settings.beforeWrite,
          cleanup,
          signal,
        },
      },
    );
    if (alreadyApplied.kind === "handled") {
      await this.outcomes.restoreAutoRotateAfterFailedLock(alreadyApplied.result, plan, settings, {
        cleanup,
        sessionMode: slot !== undefined,
      });
      return this.finishAndroidRotation(
        alreadyApplied.result,
        settings,
        { lockOrientation, signal },
        slot,
      );
    }
    logger.debug(
      `[Rotate] Continuing with requested rotation: ${alreadyApplied.reason.replaceAll("-", " ")}`,
    );

    // Auto-rotate must be off for `user_rotation` writes to take effect,
    // regardless of whether it was already off beforehand. Remember the
    // pre-existing value so it can be restored once the forced rotation
    // completes, instead of leaving auto-rotate permanently disabled
    // (#6129). An explicit persistent request takes ownership of this state,
    // while omission and false preserve the known prior auto-rotate state.

    try {
      this.outcomes.logAutoRotatePlan(autoRotateState, preserveLock, restoreAutomaticRotation);

      await perf.track("setRotation", async () => {
        await settings.beforeWrite({
          accelerometerRotation: canForceAutoRotateOff,
          captureUserRotation: true,
        });
        if (canForceAutoRotateOff) {
          // user_rotation is honored only after automatic rotation is disabled.
          // Keeping these writes ordered avoids a target write racing ahead of
          // the lock on devices where the settings provider completes slowly.
          throwIfAborted(signal);
          cleanup.needed = shouldRestoreAutoRotate && autoRotateState !== "locked";
          await this.planDeviceStateLock(cleanup, {
            shouldRestoreAutoRotate: shouldRestoreAutoRotate || plan.restoreAfterConfirmation,
            autoRotateState,
            signal,
          });
          await this.store.writeSystemSetting("accelerometer_rotation", "0", signal, cleanup);
        } else {
          logger.debug(
            "[Rotate] accelerometer_rotation is unconfirmed; writing user_rotation without changing the lock state",
          );
        }
        await settings.beforeWrite({ userRotation: value });
        await this.store.writeSystemSetting("user_rotation", String(value), signal, cleanup);
      });

      // Wait for rotation to complete (also serves as verification)
      await perf.track("waitForRotation", () =>
        this.awaitIdle.waitForRotation(value, undefined, signal),
      );

      // Note: We skip explicit verification since waitForRotation already confirms
      // the rotation completed successfully by polling dumpsys window

      // waitForRotation(value) above already confirmed the device reached the
      // requested orientation while auto-rotate was forced off. The local
      // `currentOrientation` remains the legitimate prior value (see #6057).
      let achievedOrientation: string = orientation;
      let warning: string | undefined;
      let restoreConfirmed = true;

      if (shouldRestoreAutoRotate || plan.restoreAfterConfirmation) {
        ({ achievedOrientation, warning, restoreConfirmed } =
          await this.outcomes.restoreAutoRotateAndConfirmOrientation(orientation, signal, cleanup));
      }

      const result = await this.outcomes.finalizeAndroidRotation({
        orientation,
        value,
        currentOrientation,
        achievedOrientation,
        warning,
        restoreConfirmed,
        preserveLock,
        restoreAutomaticRotation,
        wasAutoRotateEnabled,
        signal,
      });
      await this.outcomes.restoreAutoRotateAfterFailedLock(result, plan, settings, {
        cleanup,
        sessionMode: slot !== undefined,
      });
      return this.finishAndroidRotation(result, settings, { lockOrientation, signal }, slot);
    } catch (error) {
      return this.recoverAndroidRotation({
        error,
        orientation,
        value,
        currentOrientation,
        settings,
        cleanup,
        plan,
        lockOrientation,
        slot,
        signal,
      });
    }
  }

  /**
   * Decide, before this call forces auto-rotate off, how turning it back on treats
   * `device_state_rotation_lock`: auto-rotate that was on gets the map captured now (before the
   * `accelerometer_rotation=0` write records a lock in it); an explicit unlock of auto-rotate
   * that was not on clears the committed state's lock when it turns auto-rotate on.
   */
  private async planDeviceStateLock(
    cleanup: RotationSettingCleanup,
    options: {
      shouldRestoreAutoRotate: boolean;
      autoRotateState: "locked" | "enabled" | "unknown";
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const { shouldRestoreAutoRotate, autoRotateState, signal } = options;
    if (!shouldRestoreAutoRotate) {
      return;
    }
    if (autoRotateState !== "enabled") {
      cleanup.deviceStateLock = { kind: "clear" };
      return;
    }
    const value = await this.store.readSetting("secure", DEVICE_STATE_ROTATION_LOCK, signal);
    if (value !== null) {
      cleanup.deviceStateLock = { kind: "restore", value };
    }
  }

  private async confirmAndroidRotationAfterError(options: {
    orientation: "portrait" | "landscape";
    settings: RotationCallSettings;
    slot?: RotationRestoreSlot;
    signal?: AbortSignal;
  }): Promise<{ achievedOrientation: string; warning?: string }> {
    const { orientation, settings, slot, signal } = options;
    if (settings.writtenUserRotation === null) {
      return { achievedOrientation: "unknown" };
    }
    try {
      slot?.get();
      const liveRotation = await raceWithDeadline(
        () => this.readLiveRotationWithSettleWait(orientation, signal),
        {
          timer: this.timer,
          timeoutMs: ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
          signal,
          label: "Confirm rotation after error",
        },
      );
      if (liveRotation !== null) {
        return {
          achievedOrientation: await this.reader.orientationOfRotation(liveRotation, signal),
        };
      }
      return {
        achievedOrientation: "unknown",
        warning:
          "Orientation is unconfirmed; user_rotation was left unchanged because the rotation outcome is unknown.",
      };
    } catch (error) {
      logger.warn("Failed to confirm orientation after rotation error", error);
      return { achievedOrientation: "unknown", warning: `Orientation is unconfirmed: ${error}` };
    }
  }

  private async restoreAutoRotateAfterError(options: {
    settings: RotationCallSettings;
    cleanup: RotationSettingCleanup;
    shouldRestoreAutoRotate: boolean;
    signal?: AbortSignal;
  }): Promise<ActionableError | undefined> {
    const { settings, cleanup, shouldRestoreAutoRotate, signal } = options;
    // Restore temporary/explicit-unlock operations, including cancelled pending
    // writes. Persistent requests retain their lock; retirement fences cleanup.
    let restoreFailure: ActionableError | undefined;
    if (signal?.aborted ? cleanup.needed : settings.started && shouldRestoreAutoRotate) {
      try {
        await this.store.restoreAutoRotateSetting(cleanup);
        logger.info("Restored auto-rotate after error");
      } catch (error) {
        logger.warn(`Failed to restore auto-rotate: ${errorMessage(error)}`, error);
        restoreFailure = toActionableError(error, "Failed to restore auto-rotate");
      }
    }
    if (signal?.aborted && restoreFailure) {
      throw new ActionableError(
        "Rotation cancelled; accelerometer_rotation may be left changed (auto-rotate may remain disabled)",
        { cause: restoreFailure },
      );
    }
    throwIfAborted(signal);
    return restoreFailure;
  }

  private async recoverAndroidRotation(options: {
    error: unknown;
    orientation: "portrait" | "landscape";
    value: number;
    currentOrientation: string;
    settings: RotationCallSettings;
    cleanup: RotationSettingCleanup;
    plan: AutoRotatePlan;
    lockOrientation?: boolean;
    slot?: RotationRestoreSlot;
    signal?: AbortSignal;
  }): Promise<RotateResult> {
    const {
      error,
      orientation,
      value,
      currentOrientation,
      settings,
      cleanup,
      plan,
      lockOrientation,
      slot,
      signal,
    } = options;
    const {
      shouldRestoreAutoRotate,
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
    } = plan;
    logger.warn("Failed to change device orientation", error);
    if (!settings.started && error instanceof ActionableError) {
      throw error;
    }
    const restoreFailure = await this.restoreAutoRotateAfterError({
      settings,
      cleanup,
      shouldRestoreAutoRotate,
      signal,
    });
    const confirmation = await this.confirmAndroidRotationAfterError({
      orientation,
      settings,
      slot,
      signal,
    });
    let { achievedOrientation, warning } = confirmation;
    if (achievedOrientation === orientation) {
      let restoreConfirmed = !restoreFailure;
      if (plan.restoreAfterConfirmation) {
        const restored = await this.outcomes.restoreAutoRotateAndConfirmOrientation(
          orientation,
          signal,
          cleanup,
        );
        achievedOrientation = restored.achievedOrientation;
        warning = [warning, restored.warning].filter(Boolean).join(" ") || undefined;
        restoreConfirmed = restored.restoreConfirmed;
      }
      const result = await this.outcomes.finalizeAndroidRotation({
        orientation,
        value,
        currentOrientation,
        achievedOrientation,
        warning: [
          restoreFailure?.message,
          warning,
          `Rotation was confirmed after an earlier error: ${error}`,
        ]
          .filter(Boolean)
          .join(" "),
        restoreConfirmed,
        preserveLock,
        restoreAutomaticRotation,
        wasAutoRotateEnabled,
        signal,
      });
      await this.outcomes.restoreAutoRotateAfterFailedLock(result, plan, settings, {
        cleanup,
        sessionMode: slot !== undefined,
      });
      return this.finishAndroidRotation(result, settings, { lockOrientation, signal }, slot);
    }
    if (achievedOrientation !== "unknown") {
      const rollbackWarning = await this.store.rollbackUserRotation({
        previous: settings.previousUserRotation,
        written: settings.writtenUserRotation,
        signal,
        slot,
      });
      warning = [warning, rollbackWarning].filter(Boolean).join(" ") || undefined;
    }
    warning = [warning, restoreFailure?.message].filter(Boolean).join(" ") || undefined;
    return this.outcomes.restoreAutoRotateAfterFailedLock(
      {
        success: false,
        warning,
        orientation,
        value,
        currentOrientation: achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: false,
        orientationLockHandled: wasAutoRotateEnabled,
        orientationLockState: await this.reader.getOrientationLockState(signal),
        error: `Failed to change device orientation: ${error}`,
      },
      plan,
      settings,
      { cleanup, sessionMode: slot !== undefined },
    );
  }
}
