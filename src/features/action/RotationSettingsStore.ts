/**
 * RotationSettingsStore - reads and writes the rotation-related Android settings.
 *
 * Extracted from Rotate (max-class-lines): CtrlProxy-first/ADB-fallback settings access,
 * compare-and-skip restoration with read-back, rollback, and auto-rotate restoration.
 */

import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import {
  parseAndroidCommittedStateIdentifier,
  parseAndroidDeviceStates,
} from "../../utils/android-cmdline-tools/AndroidDisplayInventory";
import { RotationSettingManagedError } from "../../models/RotationSettingManagedError";
import type { SettingsNamespace, SettingsValueType } from "../observe/android/types";
import { RotateResult } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  DEVICE_STATE_ROTATION_LOCK,
  DEVICE_STATE_SNAPSHOT_ATTEMPTS,
  ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
  UNSETTLED_DEVICE_STATE,
  unlockDeviceStateRotationEntry,
  type RotationContext,
  type RotationRestoreSlot,
  type RotationRestoreState,
  type RotationSettingCleanup,
  type RotationSettingKey,
} from "./RotationSupport";

export type SettingReadOutcome =
  | { status: "value"; value: string }
  | { status: "unset" }
  | { status: "unreadable" };

export class RotationSettingsStore {
  constructor(private readonly ctx: () => RotationContext) {}

  /**
   * Get the current device orientation
   * @returns Promise with current orientation ("portrait" or "landscape")
   */
  async readSystemSetting(key: string, signal?: AbortSignal): Promise<string | null> {
    return this.readSetting("system", key, signal);
  }

  async readSetting(
    namespace: SettingsNamespace,
    key: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const outcome = await this.readSettingOutcome(namespace, key, signal);
    return outcome.status === "value" ? outcome.value : null;
  }

  /**
   * Like {@link readSetting}, but tells an absent key (`settings get` prints `null`; fresh API
   * 24/27 images never write `user_rotation`) apart from a read that failed (#19063).
   */
  async readSettingOutcome(
    namespace: SettingsNamespace,
    key: string,
    signal?: AbortSignal,
  ): Promise<SettingReadOutcome> {
    throwIfAborted(signal);
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.ctx().device);
      const a11yResult = await awaitWhileRequestIsLive(
        a11y.requestSettingsGet(namespace, key),
        signal,
      );
      if (a11yResult.success) {
        return a11yResult.found && a11yResult.value !== null && a11yResult.value !== undefined
          ? { status: "value", value: a11yResult.value }
          : { status: "unset" };
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.debug(`[Rotate] a11y settings get failed for ${key}: ${error}`);
    }
    throwIfAborted(signal);
    try {
      const result = await awaitWhileRequestIsLive(
        this.ctx().adb.executeCommand(`shell settings get ${namespace} ${key}`),
        signal,
      );
      const out = result.stdout.trim();
      return !out || out === "null" ? { status: "unset" } : { status: "value", value: out };
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Failed to read ${namespace} setting ${key}: ${error}`);
      return { status: "unreadable" };
    }
  }

  /**
   * Captured once, with the session's first originals, before any write can change it. Android
   * keeps auto-rotate per device state, so the posture and `accelerometer_rotation` are read as
   * one snapshot: the committed state is read before and after the setting, and the snapshot is
   * retried while they differ. A posture that never settles is recorded as
   * {@link UNSETTLED_DEVICE_STATE}, and release then leaves auto-rotate to the restored lock map.
   */
  async captureDeviceStateRotationLock(
    state: RotationRestoreState,
    signal?: AbortSignal,
  ): Promise<void> {
    const lock = await this.readSetting("secure", DEVICE_STATE_ROTATION_LOCK, signal);
    if (lock === null) {
      return;
    }
    state.deviceStateRotationLock = lock;
    for (let attempt = 0; attempt < DEVICE_STATE_SNAPSHOT_ATTEMPTS; attempt++) {
      const before = await this.readCommittedDeviceState();
      throwIfAborted(signal);
      if (before < 0) {
        return; // Unreadable posture: keep the captured value (the pre-#18833 behaviour).
      }
      const autoRotate =
        state.accelerometerRotation === null
          ? null
          : await this.readSystemSetting("accelerometer_rotation", signal);
      const after = await this.readCommittedDeviceState();
      throwIfAborted(signal);
      if (after < 0) {
        return;
      }
      if (before === after) {
        state.deviceStateRotationLockState = after;
        if (autoRotate === "0" || autoRotate === "1") {
          state.accelerometerRotation = autoRotate === "0" ? 0 : 1;
        }
        return;
      }
    }
    logger.info(
      `[Rotate] Device state kept changing while auto-rotate was captured; release leaves accelerometer_rotation to device_state_rotation_lock.`,
    );
    state.deviceStateRotationLockState = UNSETTLED_DEVICE_STATE;
  }

  async writeRotationSettings(options: {
    state: RotationRestoreState;
    signal?: AbortSignal;
    assertCurrentDevice?: () => void;
    /** Session restore only: rollback paths already compare their own live values first. */
    skipIfCurrent?: boolean;
  }): Promise<void> {
    const { state, signal, assertCurrentDevice, skipIfCurrent } = options;
    const cleanup: RotationSettingCleanup = { needed: false, assertCurrentDevice };
    const accelerometerRotation = skipIfCurrent
      ? await this.accelerometerRestoreTarget(state, signal)
      : state.accelerometerRotation;
    const targets: Array<readonly [RotationSettingKey, number]> = [];
    if (state.userRotation !== null) {
      targets.push(["user_rotation", state.userRotation]);
    }
    if (accelerometerRotation !== null) {
      targets.push(["accelerometer_rotation", accelerometerRotation]);
    }
    // No observation or device discovery is needed for a settings-only restoration.
    // Teardown drains admitted mutations before restoring; late setup hands off after writes settle.
    const lock = state.deviceStateRotationLock;
    await runWithAbortSignal(signal, async () => {
      // Compare-and-skip: settings that already hold the restore values need no write and no
      // read-back, which a window manager owning a folded panel's rotation could never verify.
      if (
        skipIfCurrent &&
        (await this.settingsAlreadyMatch(targets, signal)) &&
        (lock === undefined ||
          (await this.readSetting("secure", DEVICE_STATE_ROTATION_LOCK, signal)) === lock)
      ) {
        return;
      }
      // The per-state lock goes back first: while it still records the session's lock, the
      // window manager reverts an accelerometer_rotation=1 write to 0 (mt-0083 D1). It is not
      // read back itself; the accelerometer_rotation read-back below verifies its effect.
      const lockWriteError =
        lock === undefined ? undefined : await this.restoreDeviceStateLock(lock, signal, cleanup);
      if (state.userRotation !== null) {
        await this.writeSystemSetting("user_rotation", String(state.userRotation), signal, cleanup);
      }
      if (accelerometerRotation !== null) {
        await this.writeSystemSetting(
          "accelerometer_rotation",
          String(accelerometerRotation),
          signal,
          cleanup,
        );
      }
      for (const [key, expected] of targets) {
        const actual = await this.readSystemSetting(key, signal);
        if (actual !== String(expected)) {
          throw await this.readBackMismatch(key, expected, actual, signal);
        }
      }
      // Without an accelerometer_rotation read-back nothing verifies the map: read it back, and
      // surface a failed write or mismatch so the release retry runs.
      if (lock !== undefined && accelerometerRotation === null) {
        await this.verifyDeviceStateLock(lock, lockWriteError, signal);
      }
    });
  }

  private async verifyDeviceStateLock(
    lock: string,
    writeError: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (writeError !== undefined) {
      throw toActionableError(writeError, `Failed to restore device_state_rotation_lock=${lock}`);
    }
    const actual = await this.readSetting("secure", DEVICE_STATE_ROTATION_LOCK, signal);
    if (actual !== lock) {
      throw new ActionableError(
        `Restoration of device_state_rotation_lock=${lock} did not verify by read-back (read ${actual ?? "unset"}).`,
      );
    }
  }

  /** Writes the captured per-state lock map; returns the write error instead of throwing. */
  private async restoreDeviceStateLock(
    lock: string,
    signal: AbortSignal | undefined,
    cleanup: RotationSettingCleanup,
  ): Promise<unknown> {
    try {
      await this.writeSetting(
        { namespace: "secure", key: DEVICE_STATE_ROTATION_LOCK, value: lock, valueType: "string" },
        signal,
        cleanup,
      );
      return undefined;
    } catch (error) {
      throwIfAborted(signal);
      // A failed lock write must not leave user_rotation and accelerometer_rotation
      // unrestored; the caller's read-back (or its explicit check) decides the outcome.
      logger.warn(
        `[Rotate] Failed to restore device_state_rotation_lock=${lock}; restoring the rotation settings anyway: ${errorMessage(error)}`,
        error,
      );
      return error;
    }
  }

  /**
   * The `accelerometer_rotation` value a session release writes. Android keeps auto-rotate per
   * device state: restoring `device_state_rotation_lock` re-applies the current posture's own
   * setting, so when the device left the posture the original was captured in, the captured
   * value belongs to another posture and writing it would overwrite the current posture's entry.
   * An unreadable current posture keeps the captured value (the pre-#18833 behaviour).
   */
  private async accelerometerRestoreTarget(
    state: RotationRestoreState,
    signal?: AbortSignal,
  ): Promise<0 | 1 | null> {
    const captured = state.deviceStateRotationLockState;
    if (
      state.accelerometerRotation === null ||
      state.deviceStateRotationLock === undefined ||
      captured === undefined
    ) {
      return state.accelerometerRotation;
    }
    if (captured === UNSETTLED_DEVICE_STATE) {
      logger.info(
        "[Rotate] Auto-rotate was captured while the device state kept changing; device_state_rotation_lock decides accelerometer_rotation.",
      );
      return null;
    }
    const current = await this.readCommittedDeviceState();
    throwIfAborted(signal);
    if (current < 0 || current === captured) {
      return state.accelerometerRotation;
    }
    logger.info(
      `[Rotate] Device state changed from ${captured} to ${current} since auto-rotate was captured; device_state_rotation_lock decides accelerometer_rotation for this posture.`,
    );
    return null;
  }

  private async settingsAlreadyMatch(
    targets: ReadonlyArray<readonly [RotationSettingKey, number]>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (const [key, expected] of targets) {
      if ((await this.readSystemSetting(key, signal)) !== String(expected)) {
        return false;
      }
    }
    return targets.length > 0;
  }

  /**
   * A foldable's window manager re-applies rotation per device state (posture), so a mismatch
   * there is a typed non-retryable outcome; elsewhere it stays a generic verification failure.
   */
  private async readBackMismatch(
    key: RotationSettingKey,
    expected: number,
    actual: string | null,
    signal?: AbortSignal,
  ): Promise<ActionableError> {
    let foldable = false;
    try {
      const { stdout } = await awaitWhileRequestIsLive(
        this.ctx().adb.executeCommand("shell cmd device_state print-states"),
        signal,
      );
      foldable = parseAndroidDeviceStates(stdout).length > 1;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[Rotate] Could not read device states after ${key} read-back mismatch: ${errorMessage(error)}`,
        error,
      );
    }
    return foldable
      ? new RotationSettingManagedError({ key, expected, actual })
      : new ActionableError(
          `Restoration of ${key}=${expected} did not verify by read-back (read ${actual ?? "unset"}).`,
        );
  }

  /**
   * The current `user_rotation`; an unset key is Android's default 0 (portrait), and `null`
   * means the read itself failed or returned a non-integer.
   */
  async readUserRotation(signal?: AbortSignal): Promise<number | null> {
    const outcome = await this.readSettingOutcome("system", "user_rotation", signal);
    if (outcome.status === "unset") {
      return 0;
    }
    if (outcome.status === "unreadable" || outcome.value.trim() === "") {
      return null;
    }
    const value = Number(outcome.value);
    return Number.isSafeInteger(value) ? value : null;
  }

  async rollbackUserRotation(options: {
    previous: number | null;
    written: number | null;
    signal?: AbortSignal;
    slot?: RotationRestoreSlot;
  }): Promise<string | undefined> {
    const { previous, written, signal, slot } = options;
    if (written === null || signal?.aborted || previous === null) {
      return;
    }
    try {
      slot?.get();
      const current = await this.readUserRotation(signal);
      if (current !== written) {
        return "Skipped user_rotation rollback: its current value no longer matches this call's write (another actor may have changed it).";
      }
      if (current === previous) {
        return;
      }
      await raceWithDeadline(
        () =>
          this.writeRotationSettings({
            state: { userRotation: previous, accelerometerRotation: null },
            signal,
            assertCurrentDevice: () => {
              slot?.get();
            },
          }),
        {
          timer: this.ctx().timer,
          timeoutMs: ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
          signal,
          label: "Rollback user_rotation",
        },
      );
    } catch (error) {
      logger.warn(
        `Failed to roll back user_rotation after rotation failure: ${errorMessage(error)}`,
        error,
      );
      return `Failed to roll back user_rotation: ${error}`;
    }
  }

  async completeSessionRestore(
    result: RotateResult,
    lockOrientation: boolean | undefined,
    slot?: RotationRestoreSlot,
    signal?: AbortSignal,
  ): Promise<RotateResult> {
    if (lockOrientation !== false || result.orientationLockState !== "unlocked" || !slot) {
      return result;
    }
    const state = slot.get();
    if (!state) {
      return result;
    }
    try {
      await raceWithDeadline(
        () =>
          this.writeRotationSettings({
            state: { userRotation: state.userRotation, accelerometerRotation: null },
            signal,
            assertCurrentDevice: () => {
              slot.get();
            },
          }),
        {
          timer: this.ctx().timer,
          timeoutMs: ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
          signal,
          label: "Restore original user_rotation",
        },
      );
      // Explicit unlock applies immediately; retain the first originals until
      // release/rebind so a subsequent rotate cannot redefine the session baseline.
    } catch (error) {
      logger.warn(
        `Failed to restore original user_rotation after explicit automatic rotation: ${errorMessage(error)}`,
        error,
      );
      result.warning = [result.warning, `Failed to restore original user_rotation: ${error}`]
        .filter(Boolean)
        .join(" ");
    }
    return result;
  }

  async restoreAutoRotateSetting(cleanup: RotationSettingCleanup): Promise<void> {
    await raceWithDeadline(
      () =>
        runWithAbortSignal(undefined, async () => {
          if (cleanup.pendingWrite) {
            try {
              await cleanup.pendingWrite;
            } catch (error) {
              // A failed write may have applied; its settlement still orders the restore.
              logger.warn(
                `[Rotate] Pending setting write failed before cleanup: ${errorMessage(error)}`,
                error,
              );
            }
          }
          const hasDeviceStateLock = await this.prepareDeviceStateLockForAutoRotate(cleanup);
          await this.writeSystemSetting("accelerometer_rotation", "1", undefined, cleanup);
          if (hasDeviceStateLock) {
            // A device-state lock that still records a lock reverts this write; only the
            // read-back shows whether auto-rotate actually came back on.
            const actual = await this.readSystemSetting("accelerometer_rotation");
            if (actual !== "1") {
              throw new ActionableError(
                `accelerometer_rotation=1 read back ${actual ?? "unset"} after restoring device_state_rotation_lock.`,
              );
            }
          }
          cleanup.needed = false;
        }),
      {
        timer: this.ctx().timer,
        timeoutMs: ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
        label: "Restore accelerometer_rotation=1",
      },
    );
  }

  /**
   * Put `device_state_rotation_lock` back before auto-rotate is turned on (see
   * {@link RotationSettingCleanup.deviceStateLock}). Returns whether the device has the setting,
   * so the caller reads `accelerometer_rotation` back only there; other devices are unchanged.
   */
  private async prepareDeviceStateLockForAutoRotate(
    cleanup: RotationSettingCleanup,
  ): Promise<boolean> {
    const plan = cleanup.deviceStateLock;
    if (plan === undefined) {
      return false;
    }
    let value: string | null;
    if (plan.kind === "restore") {
      value = plan.value;
    } else {
      const current = await this.readSetting("secure", DEVICE_STATE_ROTATION_LOCK);
      if (current === null) {
        return false;
      }
      value = unlockDeviceStateRotationEntry(current, await this.readCommittedDeviceState());
    }
    if (value !== null) {
      try {
        await this.writeSetting(
          { namespace: "secure", key: DEVICE_STATE_ROTATION_LOCK, value, valueType: "string" },
          undefined,
          cleanup,
        );
      } catch (error) {
        // Still turn auto-rotate on; the accelerometer_rotation read-back decides the outcome.
        logger.warn(
          `[Rotate] Failed to write device_state_rotation_lock before restoring auto-rotate: ${errorMessage(error)}`,
          error,
        );
      }
    }
    return true;
  }

  /** The committed device state identifier, or -1 when it cannot be read. */
  async readCommittedDeviceState(): Promise<number> {
    try {
      const { stdout } = await this.ctx().adb.executeCommand("shell cmd device_state state", {
        timeoutMs: ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
      });
      const identifier = parseAndroidCommittedStateIdentifier(stdout);
      if (identifier !== undefined) {
        return identifier;
      }
      logger.warn(`[Rotate] Could not parse the committed device state from: ${stdout.trim()}`);
    } catch (error) {
      logger.warn(
        `[Rotate] Could not read the committed device state: ${errorMessage(error)}`,
        error,
      );
    }
    // No entry matches -1, so the lock map is left unchanged.
    return -1;
  }

  async writeSystemSetting(
    key: string,
    value: string,
    signal?: AbortSignal,
    cleanup?: RotationSettingCleanup,
  ): Promise<void> {
    await this.writeSetting({ namespace: "system", key, value, valueType: "int" }, signal, cleanup);
  }

  async writeSetting(
    setting: {
      namespace: SettingsNamespace;
      key: string;
      value: string;
      valueType: SettingsValueType;
    },
    signal?: AbortSignal,
    cleanup?: RotationSettingCleanup,
  ): Promise<void> {
    const { namespace, key, value, valueType } = setting;
    throwIfAborted(signal);
    cleanup?.assertCurrentDevice?.();
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.ctx().device);
      cleanup?.assertCurrentDevice?.();
      const write = a11y.requestSettingsPut(namespace, key, value, { valueType });
      if (cleanup) {
        cleanup.pendingWrite = write;
      }
      const a11yResult = await awaitWhileRequestIsLive(write, signal);
      if (a11yResult.success) {
        return;
      }
      logger.debug(`[Rotate] a11y settings put failed for ${key}: ${a11yResult.error}`);
    } catch (error) {
      throwIfAborted(signal);
      logger.debug(`[Rotate] a11y settings put threw for ${key}: ${error}`);
    }
    throwIfAborted(signal);
    cleanup?.assertCurrentDevice?.();
    const write = this.ctx().adb.executeCommand(`shell settings put ${namespace} ${key} ${value}`);
    if (cleanup) {
      cleanup.pendingWrite = write;
    }
    await awaitWhileRequestIsLive(write, signal);
  }
}
