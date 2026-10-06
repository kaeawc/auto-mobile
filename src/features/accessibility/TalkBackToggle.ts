import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { BootedDevice } from "../../models";
import type {
  ScreenReaderToggleOptions,
  TalkBackResult,
  TalkBackBlockingPrompt,
} from "../../models/AccessibilityResult";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AccessibilityDetector } from "./interfaces/AccessibilityDetector";
import { accessibilityDetector } from "./AccessibilityDetector";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { type SecureSettingsRpc, CtrlProxySecureSettingsRpc } from "./SecureSettingsRpc";
import {
  type TalkBackDialogProbe,
  type TalkBackDialogProbeResult,
  CtrlProxyTalkBackDialogProbe,
} from "./TalkBackDialogProbe";

const TALKBACK_PACKAGE = "com.google.android.marvin.talkback";
const TALKBACK_SERVICE_FALLBACK = `${TALKBACK_PACKAGE}/${TALKBACK_PACKAGE}.TalkBackService`;
const DIALOG_DISMISS_RETRIES = 4; // 1 immediate + 3 × 500ms = 1500ms max wait
const DIALOG_DISMISS_DELAY_MS = 500;
const TALKBACK_STATE_CONFIRM_ATTEMPTS = 4; // 1 immediate + 3 × 500ms = 1500ms max wait
const TALKBACK_STATE_CONFIRM_DELAY_MS = 500;
const UIAUTOMATOR_DUMP_TIMEOUT_MS = 30_000;

/**
 * Longest a TalkBack toggle can take on its own clock: the one fallback
 * `uiautomator dump`, every consent-dialog wait, and every state-confirmation
 * wait. Ordinary adb/CtrlProxy calls add only milliseconds on top.
 */
export const TALKBACK_TOGGLE_WORST_CASE_MS =
  UIAUTOMATOR_DUMP_TIMEOUT_MS +
  (DIALOG_DISMISS_RETRIES - 1) * DIALOG_DISMISS_DELAY_MS +
  (TALKBACK_STATE_CONFIRM_ATTEMPTS - 1) * TALKBACK_STATE_CONFIRM_DELAY_MS;

/** Foreground activity identifies a runtime prompt, not the requested permission. */
export function isTalkBackRuntimePermissionPrompt(app: {
  packageName: string;
  activityName?: string;
}): boolean {
  // Accept the AOSP package too: it hosts the same GrantPermissionsActivity.
  return (
    (app.packageName === "com.google.android.permissioncontroller" ||
      app.packageName === "com.android.permissioncontroller") &&
    app.activityName?.split(".").at(-1) === "GrantPermissionsActivity"
  );
}

async function reportPreviousState(
  options: ScreenReaderToggleOptions | undefined,
  previousEnabled: boolean,
): Promise<void> {
  await options?.beforeChange?.(previousEnabled);
}

interface DialogDismissState {
  dialogSeen: boolean;
  /** A probe or the single fallback dump produced an answer. */
  observed: boolean;
  dumpUsed: boolean;
}

export class TalkBackToggle {
  private readonly adb: AdbExecutor;
  private readonly secureSettings: SecureSettingsRpc;
  private readonly dialogProbe: TalkBackDialogProbe;

  constructor(
    private readonly device: BootedDevice,
    adb: AdbExecutor | null = null,
    private readonly detector: AccessibilityDetector = accessibilityDetector,
    private readonly timer: Timer = defaultTimer,
    secureSettings: SecureSettingsRpc | null = null,
    dialogProbe: TalkBackDialogProbe | null = null,
  ) {
    this.adb = adb ?? defaultAdbClientFactory.create(device);
    this.secureSettings = secureSettings ?? new CtrlProxySecureSettingsRpc(device);
    this.dialogProbe = dialogProbe ?? new CtrlProxyTalkBackDialogProbe(device);
  }

  async toggle(enabled: boolean, options?: ScreenReaderToggleOptions): Promise<TalkBackResult> {
    // Step 1: Verify the Google TalkBack package before enabling it. Disabling
    // relies on the active-service detector so it also removes vendor/AOSP
    // TalkBack components that use the same TalkBackService contract.
    let serviceComponent: string | null = null;
    if (enabled) {
      serviceComponent = await this.detectInstalledService();
      if (!serviceComponent) {
        return {
          supported: false,
          applied: false,
          reason: "TalkBack service not installed on this device",
        };
      }
    }

    // Step 2: Invalidate stale evidence and check TalkBack specifically. Other
    // services (e.g. CtrlProxy) and unavailable reads must not match the request.
    const talkBackCurrentlyEnabled = await this.detectTalkBackEnabled();
    if (talkBackCurrentlyEnabled === null) {
      // Do not overwrite an unreadable service list: other services must be preserved.
      return {
        supported: true,
        applied: false,
        reason:
          "could not determine TalkBack state: device accessibility settings read unavailable",
      };
    }
    if (talkBackCurrentlyEnabled === enabled) {
      return {
        supported: true,
        applied: false,
        currentState: enabled,
      };
    }

    // The state is known and about to change: let the caller record it before any write, so a
    // failure part-way through the write is still restored (#10146).
    await reportPreviousState(options, talkBackCurrentlyEnabled);

    // Step 3: Apply ADB commands. A settings-write failure here (e.g. the a11y
    // path AND the ADB fallback both fail) is wrapped into a typed result rather
    // than propagating raw out of toggle(), matching the graceful contract of the
    // other paths (#3921).
    // Discard pre-change evidence before writing, including during permission-dialog waits.
    this.detector.invalidateCache(this.device.deviceId);
    let blockingPrompt: TalkBackBlockingPrompt | undefined;
    let warning: string | undefined;
    try {
      if (enabled) {
        await this.enableTalkBack(serviceComponent!);
        // Step 4: Confirm the permission dialog is gone before reporting success.
        const dialogResult = await this.dismissPermissionDialog();
        if (dialogResult === "could-not-confirm") {
          const reason = "TalkBack permission dialog dismissal could not be confirmed";
          logger.warn(`[TalkBackToggle] ${reason}`);
          return await this.failedToggleResult(reason);
        }
        blockingPrompt = await this.readBlockingPrompt();
        if (blockingPrompt) {
          // #6499 device check, 2026-09-25: API 36 google_apis arm64,
          // HEAD 21791e9da, GrantPermissionsActivity showed "Allow Android
          // Accessibility Suite to send you notifications?" with
          // permission_allow_button / permission_deny_button. Back did not
          // dismiss it; the caller used tapOn on permission_deny_button.
          warning =
            "A system runtime permission prompt is covering the screen after enabling TalkBack. " +
            "On API 36 this was observed as the Android Accessibility Suite (TalkBack) notifications permission. " +
            "The foreground activity does not identify the requested permission. Nothing was tapped. " +
            "You must answer it: use observe to inspect the prompt, then tapOn its permission_allow_button or permission_deny_button.";
          logger.warn(`[TalkBackToggle] ${warning}`, blockingPrompt);
        } else if (dialogResult === "not-found") {
          logger.warn("[TalkBackToggle] TalkBack permission dialog not found — continuing");
        }
      } else {
        await this.disableTalkBack();
      }
    } catch (error) {
      const reason = errorMessage(error);
      logger.warn(
        `[TalkBackToggle] Failed to ${enabled ? "enable" : "disable"} TalkBack: ${reason}`,
      );
      return await this.failedToggleResult(reason);
    } finally {
      // A partial write or an early dialog failure also invalidates pre-change evidence.
      this.detector.invalidateCache(this.device.deviceId);
    }

    // Step 5: Re-detect immediately, then allow asynchronous state changes a
    // bounded wait. Each read invalidates the same cache as the idempotency check.
    return {
      ...(await this.confirmTalkBackState(enabled)),
      ...(blockingPrompt ? { blockingPrompt, warning } : {}),
    };
  }

  private async failedToggleResult(reason: string): Promise<TalkBackResult> {
    // Partial writes and unconfirmed dialogs can still change the device state.
    const currentState = await this.detectTalkBackEnabled();
    return {
      supported: true,
      applied: false,
      ...(currentState !== null ? { currentState } : {}),
      reason,
    };
  }

  private async confirmTalkBackState(enabled: boolean): Promise<TalkBackResult> {
    let confirmedEnabled = await this.detectTalkBackEnabled();
    for (
      let attempt = 1;
      confirmedEnabled !== enabled && attempt < TALKBACK_STATE_CONFIRM_ATTEMPTS;
      attempt++
    ) {
      await this.timer.sleep(TALKBACK_STATE_CONFIRM_DELAY_MS);
      confirmedEnabled = await this.detectTalkBackEnabled();
    }

    let reason: string | undefined;
    if (confirmedEnabled !== enabled) {
      const waitMs = (TALKBACK_STATE_CONFIRM_ATTEMPTS - 1) * TALKBACK_STATE_CONFIRM_DELAY_MS;
      reason = `TalkBack requested ${enabled ? "enabled" : "disabled"} but observed ${confirmedEnabled === null ? "unknown (could not determine)" : confirmedEnabled ? "enabled" : "disabled"} after ${waitMs}ms of confirmation waits`;
      logger.warn(`[TalkBackToggle] ${reason}`);
    }

    return {
      supported: true,
      applied: confirmedEnabled === enabled,
      ...(confirmedEnabled !== null ? { currentState: confirmedEnabled } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  private async readBlockingPrompt(): Promise<TalkBackBlockingPrompt | undefined> {
    try {
      const app = await this.adb.getForegroundApp();
      if (!app) {
        logger.debug("[TalkBackToggle] Foreground app unavailable; no prompt reported");
        return undefined;
      }
      if (app.activityName && isTalkBackRuntimePermissionPrompt(app)) {
        return {
          kind: "runtime-permission",
          package: app.packageName,
          activity: app.activityName,
        };
      }
    } catch (error) {
      // Prompt detection is advisory; enabled-state read-back remains the source of truth.
      logger.debug("[TalkBackToggle] Foreground prompt read failed:", errorMessage(error));
    }
    return undefined;
  }

  /**
   * Invalidate the stale detection cache and re-detect whether TalkBack
   * specifically is the active service. Used both for the pre-apply idempotency
   * check and the post-apply confirmation so the two never drift.
   */
  private async detectTalkBackEnabled(): Promise<boolean | null> {
    this.detector.invalidateCache(this.device.deviceId);
    const state = await this.detector.resolveState(this.device.deviceId, this.adb);
    return state === null ? null : state.service === "talkback";
  }

  // Why: try the a11y service first to skip ADB round-trip latency; fall back to ADB
  // because Settings.Secure writes require system-app privileges that the service may lack.
  private async writeSecureSetting(
    key: string,
    value: string,
    valueType: "string" | "int" = "string",
  ): Promise<void> {
    try {
      const result = await this.secureSettings.put(key, value, valueType);
      if (result.success) {
        return;
      }
    } catch (error) {
      logger.debug(`[TalkBackToggle] a11y settings put failed for secure/${key}: ${error}`);
    }
    await this.adb.executeCommand(`shell settings put secure ${key} ${value}`);
  }

  private async deleteSecureSetting(key: string): Promise<void> {
    try {
      const result = await this.secureSettings.put(key, null);
      if (result.success) {
        return;
      }
    } catch (error) {
      logger.debug(`[TalkBackToggle] a11y settings delete failed for secure/${key}: ${error}`);
    }
    await this.adb.executeCommand(`shell settings delete secure ${key}`);
  }

  private async readSecureSetting(key: string): Promise<string> {
    try {
      const result = await this.secureSettings.get(key);
      if (result.success) {
        return result.found ? (result.value ?? "") : "";
      }
    } catch (error) {
      logger.debug(`[TalkBackToggle] a11y settings get failed for secure/${key}: ${error}`);
    }
    const adbResult = await this.adb.executeCommand(`shell settings get secure ${key}`);
    return adbResult.stdout.trim();
  }

  /**
   * Add TalkBack to the enabled services list while preserving any other
   * active accessibility services (e.g. CtrlProxy).
   */
  private async enableTalkBack(serviceComponent: string): Promise<void> {
    const otherServices = await this.getOtherServices();
    const updatedServices = [...otherServices, serviceComponent].join(":");
    await this.writeSecureSetting("enabled_accessibility_services", updatedServices);
    await this.writeSecureSetting("accessibility_enabled", "1", "int");
  }

  /**
   * Remove TalkBack from the enabled services list while preserving any other
   * active accessibility services (e.g. CtrlProxy).  Only clears the master
   * accessibility_enabled flag when no other services remain.
   */
  private async disableTalkBack(): Promise<void> {
    const otherServices = await this.getOtherServices();

    if (otherServices.length === 0) {
      await this.deleteSecureSetting("enabled_accessibility_services");
      await this.writeSecureSetting("accessibility_enabled", "0", "int");
    } else {
      // Other services are still active — update the list without TalkBack
      // and leave accessibility_enabled at 1
      await this.writeSecureSetting("enabled_accessibility_services", otherServices.join(":"));
    }
  }

  /**
   * Read the current enabled_accessibility_services setting and return all
   * entries that are NOT part of TalkBack, preserving other active services.
   */
  private async getOtherServices(): Promise<string[]> {
    const currentServices = await this.readSecureSetting("enabled_accessibility_services");

    const otherServices: string[] = [];
    if (currentServices && currentServices !== "null") {
      for (const s of currentServices.split(":")) {
        const trimmed = s.trim();
        if (
          trimmed &&
          !trimmed.includes(TALKBACK_PACKAGE) &&
          !trimmed.includes("TalkBackService")
        ) {
          otherServices.push(trimmed);
        }
      }
    }
    return otherServices;
  }

  /**
   * Check PackageManager for TalkBack rather than `dumpsys accessibility`.
   * The latter only reports enabled services, so it cannot discover the
   * installed-but-disabled TalkBack that this toggle needs to enable.
   */
  private async detectInstalledService(): Promise<string | null> {
    try {
      const result = await this.adb.executeCommand(`shell pm list packages ${TALKBACK_PACKAGE}`);
      const installed = result.stdout
        .split("\n")
        .some((line) => line.trim() === `package:${TALKBACK_PACKAGE}`);

      if (!installed) {
        logger.debug("[TalkBackToggle] TalkBack package not found");
        return null;
      }

      logger.debug("[TalkBackToggle] TalkBack package found; using known service component");
      return TALKBACK_SERVICE_FALLBACK;
    } catch (error) {
      logger.error("[TalkBackToggle] Failed to detect TalkBack package:", error);
      return null;
    }
  }

  /**
   * After enabling TalkBack, Android may show a consent dialog that must be
   * accepted before automation can continue. A write through `settings put`
   * normally shows none, so stop as soon as the setting reads enabled. Otherwise
   * look for the dialog through the CtrlProxy hierarchy, which does not restart
   * any accessibility service. `uiautomator dump` does, so it is a fallback used
   * at most once per call and only while CtrlProxy cannot answer (#10147).
   * Match the positive button by resource-id for locale independence, but
   * only when the TalkBack dialog context is confirmed — android:id/button1
   * is a generic ID reused by many dialogs.
   */
  private async dismissPermissionDialog(): Promise<
    "not-found" | "dismissed" | "could-not-confirm"
  > {
    const state: DialogDismissState = { dialogSeen: false, observed: false, dumpUsed: false };
    for (let attempt = 0; attempt < DIALOG_DISMISS_RETRIES; attempt++) {
      if (attempt > 0) {
        await this.timer.sleep(DIALOG_DISMISS_DELAY_MS);
      }
      const outcome = await this.dismissAttempt(state);
      if (outcome) {
        return outcome;
      }
    }
    // Nothing could be observed, or a dialog was seen and never confirmed gone.
    return state.dialogSeen || !state.observed ? "could-not-confirm" : "not-found";
  }

  private async dismissAttempt(
    state: DialogDismissState,
  ): Promise<"not-found" | "dismissed" | undefined> {
    if ((await this.detectTalkBackEnabled()) === true) {
      logger.debug("[TalkBackToggle] TalkBack reads enabled; no consent dialog to dismiss");
      return state.dialogSeen ? "dismissed" : "not-found";
    }
    const seen = await this.lookForDialog(state);
    if (seen.kind === "unavailable") {
      return undefined;
    }
    state.observed = true;
    if (seen.kind === "none") {
      return state.dialogSeen ? "dismissed" : undefined;
    }
    state.dialogSeen = true;
    if (!seen.tap) {
      return undefined;
    }
    await this.adb.executeCommand(`shell input tap ${seen.tap.x} ${seen.tap.y}`);
    // Read back right after the tap, without a dump: the fallback dump is spent.
    const after = await this.lookForDialog(state);
    if (after.kind === "none") {
      logger.debug("[TalkBackToggle] TalkBack permission dialog dismissed");
      return "dismissed";
    }
    return undefined;
  }

  private async lookForDialog(state: DialogDismissState): Promise<TalkBackDialogProbeResult> {
    const probed = await this.dialogProbe.probe();
    if (probed.kind !== "unavailable" || state.dumpUsed) {
      return probed;
    }
    state.dumpUsed = true;
    try {
      return this.classifyDump(await this.dumpWindowHierarchy());
    } catch (error) {
      logger.warn("[TalkBackToggle] Dialog fallback hierarchy dump failed:", error);
      return { kind: "unavailable" };
    }
  }

  private classifyDump(xml: string): TalkBackDialogProbeResult {
    const nodeMatch = this.findTalkBackPermissionButton(xml);
    if (!nodeMatch) {
      return { kind: "none" };
    }
    const boundsMatch = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(nodeMatch[0]);
    if (!boundsMatch) {
      return { kind: "dialog", tap: null };
    }
    return {
      kind: "dialog",
      tap: {
        x: Math.round((parseInt(boundsMatch[1], 10) + parseInt(boundsMatch[3], 10)) / 2),
        y: Math.round((parseInt(boundsMatch[2], 10) + parseInt(boundsMatch[4], 10)) / 2),
      },
    };
  }

  /** Match button1 only when the TalkBack dialog context is present. */
  private findTalkBackPermissionButton(xml: string): RegExpExecArray | null {
    if (!xml.includes("TalkBack")) {
      return null;
    }
    return /<node[^>]*resource-id="android:id\/button1"[^>]*\/?>/.exec(xml);
  }

  /**
   * Capture the current window hierarchy XML. Dumps to a device file and reads
   * it back rather than to `/dev/tty`: `uiautomator dump /dev/tty` frequently
   * prints its own status line ("UI hierarchy dumped to: /dev/tty") to stdout
   * instead of the XML, so the consent dialog is never matched and dismissal
   * silently stalls (#3921).
   */
  private async dumpWindowHierarchy(): Promise<string> {
    const remotePath = "/sdcard/window_dump.xml";
    await this.adb.executeCommand(
      `shell uiautomator dump ${remotePath}`,
      UIAUTOMATOR_DUMP_TIMEOUT_MS,
    );
    const catResult = await this.adb.executeCommand(`shell cat ${remotePath}`);
    return catResult.stdout;
  }
}
