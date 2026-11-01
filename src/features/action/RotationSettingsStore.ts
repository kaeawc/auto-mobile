/**
 * RotationSettingsStore - reads and writes the rotation-related Android settings.
 *
 * Extracted from Rotate (max-class-lines): CtrlProxy-first/ADB-fallback settings access,
 * compare-and-skip restoration with read-back, rollback, and auto-rotate restoration.
 */

import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ActionableError } from "../../models/ActionableError";
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
  ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
  unlockDeviceStateRotationEntry,
  type RotationContext,
  type RotationRestoreSlot,
  type RotationRestoreState,
  type RotationSettingCleanup,
  type RotationSettingKey,
} from "./RotationSupport";

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
    throwIfAborted(signal);
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.ctx().device);
      const a11yResult = await awaitWhileRequestIsLive(
        a11y.requestSettingsGet(namespace, key),
        signal,
      );
      if (a11yResult.success) {
        return a11yResult.found ? (a11yResult.value ?? null) : null;
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
      return !out || out === "null" ? null : out;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Failed to read ${namespace} setting ${key}: ${error}`);
      return null;
    }
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
    const targets: Array<readonly [RotationSettingKey, number]> = [];
    if (state.userRotation !== null) {
      targets.push(["user_rotation", state.userRotation]);
    }
    if (state.accelerometerRotation !== null) {
      targets.push(["accelerometer_rotation", state.accelerometerRotation]);
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
      if (lock !== undefined) {
        try {
          await this.writeSetting(
            {
              namespace: "secure",
              key: DEVICE_STATE_ROTATION_LOCK,
              value: lock,
              valueType: "string",
            },
            signal,
            cleanup,
          );
        } catch (error) {
          throwIfAborted(signal);
          // A failed lock write must not leave user_rotation and accelerometer_rotation
          // unrestored; the accelerometer_rotation read-back below decides the outcome.
          logger.warn(
            `[Rotate] Failed to restore device_state_rotation_lock=${lock}; restoring the rotation settings anyway: ${errorMessage(error)}`,
            error,
          );
        }
      }
      if (state.userRotation !== null) {
        await this.writeSystemSetting("user_rotation", String(state.userRotation), signal, cleanup);
      }
      if (state.accelerometerRotation !== null) {
        await this.writeSystemSetting(
          "accelerometer_rotation",
          String(state.accelerometerRotation),
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
    });
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

  async readUserRotation(signal?: AbortSignal): Promise<number | null> {
    const raw = await this.readSystemSetting("user_rotation", signal);
    if (raw === null || raw.trim() === "") {
      return null;
    }
    const value = Number(raw);
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

  private async readCommittedDeviceState(): Promise<number> {
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
