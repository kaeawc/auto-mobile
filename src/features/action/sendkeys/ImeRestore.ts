import type { TypingSession } from "./TypingSession";
import type { SendKeysTextClient, TextActionResult } from "../SendKeys";
import type { KeyboardProfileId } from "../keyboardProfiles";
import type { ImeSubtypeSnapshot } from "../AndroidImeCatalog";
import type { BootedDevice } from "../../../models";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { runOutsideRequestContext } from "../../../utils/AbortContext";
import {
  AndroidImeCatalog,
  AUTO_MOBILE_IME_ID,
  createForegroundUserSource,
  imeUserArgs,
  pinnedUser,
} from "../AndroidImeCatalog";
import { quarantineAndroidIme, type AndroidImeRecoverySnapshot } from "../androidImeLock";
import { ImeRestorationError } from "./ImeSpan";
export interface SendKeysImeRecoverySnapshot extends AndroidImeRecoverySnapshot {
  /** Verify the captured user's state even if the foreground user has since changed. */
  userId?: number;
}
type DefaultImeReadResult =
  | { success: true; imeId: string | null }
  | { success: false; error: string };
export interface ImeRestoreHost {
  session: TypingSession;
  adb: AdbExecutor;
  device: Pick<BootedDevice, "deviceId">;
  textClient: Pick<SendKeysTextClient, "supportsKeyboardProfiles" | "setKeyboardProfile">;
  checkAbort(signal?: AbortSignal, error?: unknown): void;
}
export class ImeRestore {
  constructor(private readonly host: ImeRestoreHost) {}

  /**
   * Every `ime` and `settings` command of one span (read, activate, restore) must target the
   * same user, so the foreground user is resolved once here. `ime` defaults to the current
   * user and `settings` to user 0.
   */
  async pinImeUser(
    signal?: AbortSignal,
  ): Promise<{ success: true } | { success: false; error: string }> {
    try {
      this.host.session.imeUserId = await createForegroundUserSource(
        this.host.adb,
      ).foregroundUserId(signal);
      return { success: true };
    } catch (error) {
      this.host.checkAbort(signal, error);
      logger.warn("[SendKeys] Failed to resolve the foreground Android user", error);
      return {
        success: false,
        error: `Failed to resolve the foreground Android user: ${errorMessage(error)}`,
      };
    }
  }

  /** The pinned user as ` --user <id>` command text; empty for user 0. */
  imeUserFlag(): string {
    const userId = this.host.session.imeUserId;
    if (userId === undefined) {
      throw new Error("IME user was not pinned before an IME command.");
    }
    const args = imeUserArgs(userId);
    return args.length === 0 ? "" : ` ${args.join(" ")}`;
  }

  pinnedImeCatalog(): AndroidImeCatalog {
    const userId = this.host.session.imeUserId;
    if (userId === undefined) {
      throw new Error("IME user was not pinned before an IME command.");
    }
    return new AndroidImeCatalog(this.host.adb, this.host.device.deviceId, pinnedUser(userId));
  }

  async verifySafeImeRecovery(
    snapshot: SendKeysImeRecoverySnapshot,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (snapshot.wasEnabled === undefined) {
      return false;
    }
    if (snapshot.imeId === AUTO_MOBILE_IME_ID) {
      return false;
    }
    try {
      const catalog = await new AndroidImeCatalog(
        this.host.adb,
        this.host.device.deviceId,
        snapshot.userId === undefined
          ? createForegroundUserSource(this.host.adb)
          : pinnedUser(snapshot.userId),
      ).pinForeground(signal);
      const state = await catalog.list(signal);
      const safe = state.installed.some(
        (ime) => ime.id === snapshot.imeId && ime.enabled && ime.active,
      );
      const commitImeEnabled =
        state.installed.find((ime) => ime.id === AUTO_MOBILE_IME_ID)?.enabled ?? false;
      const commitImeStateMatches = snapshot.wasEnabled ? commitImeEnabled : !commitImeEnabled;
      return (
        commitImeStateMatches &&
        safe &&
        state.activeImeId === snapshot.imeId &&
        (await catalog.readSubtype(snapshot.imeId, signal)).id === snapshot.subtypeId
      );
    } catch (error) {
      logger.warn("[SendKeys] Quarantined keyboard recovery could not be verified", error);
      return false;
    }
  }

  async checkKeyboardProfileSupport(profile?: KeyboardProfileId): Promise<TextActionResult> {
    if (!profile || (await this.host.textClient.supportsKeyboardProfiles())) {
      return { success: true };
    }
    const error =
      "The installed control-proxy build does not support keyboard profiles; update/re-cut the APK.";
    logger.warn(`[SendKeys] ${error}`);
    return { success: false, error };
  }

  async setRequestedKeyboardProfile(
    profile?: KeyboardProfileId,
  ): Promise<{ success: boolean; previousProfileId?: string; error?: string }> {
    if (!profile) {
      return { success: true };
    }
    const result = await this.host.textClient.setKeyboardProfile(profile);
    return result.success
      ? result
      : { success: false, error: result.error ?? "Failed to set keyboard profile." };
  }

  async restoreKeyboardProfileIfNeeded(
    requested?: KeyboardProfileId,
    previous?: string,
  ): Promise<void> {
    if (requested && previous && previous !== requested) {
      await this.restoreKeyboardProfile(previous);
    }
  }

  async restoreKeyboardProfile(profileId: string): Promise<void> {
    try {
      const result = await runOutsideRequestContext(() =>
        this.host.textClient.setKeyboardProfile(profileId),
      );
      if (!result.success) {
        logger.warn(
          `[SendKeys] Failed to restore keyboard profile: ${result.error ?? "unknown error"}`,
        );
      }
    } catch (error) {
      logger.warn("[SendKeys] Failed to restore keyboard profile", error);
    }
  }

  async readDefaultIme(): Promise<DefaultImeReadResult> {
    try {
      const result = await this.host.adb.executeCommand(
        `shell settings${this.imeUserFlag()} get secure default_input_method`,
      );
      const stderr = result.stderr.trim();
      if (stderr) {
        const error = `Failed to read the current default IME: ${stderr}`;
        logger.warn(`[SendKeys] ${error}`);
        return { success: false, error };
      }
      const imeId = result.stdout.trim();
      return { success: true, imeId: !imeId || imeId === "null" ? null : imeId };
    } catch (error) {
      logger.warn("[SendKeys] Failed to read the current default IME", error);
      return {
        success: false,
        error: `Failed to read the current default IME: ${errorMessage(error)}`,
      };
    }
  }

  async readCommitImeEnabled(): Promise<
    { success: true; enabled: boolean } | { success: false; error: string }
  > {
    try {
      const result = await this.host.adb.executeCommand(`shell ime list${this.imeUserFlag()} -s`);
      if (result.stderr.trim()) {
        logger.warn(`[SendKeys] Failed to list enabled IMEs: ${result.stderr.trim()}`);
        return { success: false, error: `Failed to list enabled IMEs: ${result.stderr.trim()}` };
      }
      return {
        success: true,
        enabled: result.stdout.split(/\r?\n/).some((id) => id.trim() === this.commitImeId),
      };
    } catch (error) {
      logger.warn("[SendKeys] Failed to list enabled IMEs", error);
      return { success: false, error: `Failed to list enabled IMEs: ${errorMessage(error)}` };
    }
  }

  async activateCommitIme(wasEnabled: boolean): Promise<boolean> {
    // Android IME ids are ComponentName.flattenToShortString(): the class is
    // abbreviated to a leading "." because it lives under the package, and that
    // short form is what `settings get secure default_input_method` stores.
    const imeId = this.commitImeId;
    try {
      if (!wasEnabled) {
        const enableResult = await this.host.adb.executeCommand(
          `shell ime enable${this.imeUserFlag()} ${imeId}`,
        );
        if (enableResult.stderr.trim()) {
          logger.warn(
            `[SendKeys] Failed to enable the text-commit IME: ${enableResult.stderr.trim()}`,
          );
          return false;
        }
      }
      const setResult = await this.host.adb.executeCommand(
        `shell ime set${this.imeUserFlag()} ${imeId}`,
      );
      if (setResult.stderr.trim()) {
        logger.warn(`[SendKeys] Failed to select the text-commit IME: ${setResult.stderr.trim()}`);
        return false;
      }
      const activeResult = await this.readDefaultIme();
      if (!activeResult.success) {
        return false;
      }
      if (activeResult.imeId !== imeId) {
        logger.warn(
          `[SendKeys] Text-commit IME activation verification failed: expected ${imeId}, got ${activeResult.imeId ?? "none"}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      logger.warn("[SendKeys] Failed to activate the text-commit IME", error);
      return false;
    }
  }

  async restoreIme(
    priorImeId: string | null,
    wasEnabled: boolean,
    subtype: ImeSubtypeSnapshot,
  ): Promise<void> {
    if (priorImeId === this.commitImeId) {
      // The commit IME was already the keyboard, so nothing was switched away from (#10409).
      return;
    }
    const catalog = this.pinnedImeCatalog();
    try {
      // Cleanup must complete even when the ambient request signal has been cancelled.
      await runOutsideRequestContext(async () => {
        await this.restoreComponentAndSubtype(catalog, priorImeId, subtype);
        await this.verifyRestoredIme(catalog, priorImeId, wasEnabled);
      });
    } catch (error) {
      const snapshot: SendKeysImeRecoverySnapshot | undefined =
        priorImeId === null
          ? undefined
          : {
              imeId: priorImeId,
              subtypeId: subtype.id,
              wasEnabled,
              userId: this.host.session.imeUserId,
            };
      quarantineAndroidIme(this.host.device.deviceId, snapshot);
      logger.warn("[SendKeys] Original keyboard restoration failed", error);
      const recovery =
        priorImeId === null
          ? 'run "keyboard listImes" and select an enabled IME, or restart the daemon.'
          : `run "keyboard setIme ${priorImeId}" or restart the daemon.`;
      throw new ImeRestorationError(
        `Could not restore the original keyboard ${priorImeId ?? "(none)"}; ${recovery}`,
        { cause: error },
      );
    }
  }

  async restoreComponentAndSubtype(
    catalog: AndroidImeCatalog,
    priorImeId: string | null,
    subtype: ImeSubtypeSnapshot,
  ): Promise<void> {
    let componentError: unknown;
    try {
      if (priorImeId !== null) {
        // The caller already holds the per-device lock; select() would deadlock.
        await catalog.selectWithinLock(priorImeId);
      }
    } catch (error) {
      componentError = error;
    }
    try {
      // Restore subtype after component, including when component selection fails.
      await catalog.restoreSubtypeWithinLock(priorImeId ?? AUTO_MOBILE_IME_ID, subtype);
    } catch (error) {
      if (componentError !== undefined) {
        throw new AggregateError(
          [componentError, error],
          "IME component and subtype restoration failed.",
        );
      }
      throw error;
    }
    if (componentError !== undefined) {
      throw componentError;
    }
  }

  async verifyRestoredIme(
    catalog: AndroidImeCatalog,
    priorImeId: string | null,
    wasEnabled: boolean,
  ): Promise<void> {
    if (priorImeId !== null) {
      const after = await catalog.list();
      if (after.activeImeId !== priorImeId) {
        throw new Error(`Expected ${priorImeId}, got ${after.activeImeId ?? "none"}.`);
      }
    }
    if (!wasEnabled) {
      await this.disableCommitIme();
    }
    const enabled = await this.readCommitImeEnabled();
    if (!enabled.success || enabled.enabled !== wasEnabled) {
      throw new Error("Text-commit IME enabled state did not return to its original value.");
    }
  }

  get commitImeId(): string {
    return AUTO_MOBILE_IME_ID;
  }

  async disableCommitIme(): Promise<void> {
    // This removes the companion from the keyboard picker; activateCommitIme re-enables it next time.
    const result = await this.host.adb.executeCommand(
      `shell ime disable${this.imeUserFlag()} ${this.commitImeId}`,
    );
    if (result.stderr.trim()) {
      throw new Error(`Failed to disable the text-commit IME: ${result.stderr.trim()}`);
    }
  }
}
