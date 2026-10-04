import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { BootedDevice } from "../../models";
import type { TalkBackResult, TalkBackBlockingPrompt } from "../../models/AccessibilityResult";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AccessibilityDetector } from "./interfaces/AccessibilityDetector";
import { accessibilityDetector } from "./AccessibilityDetector";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { type SecureSettingsRpc, CtrlProxySecureSettingsRpc } from "./SecureSettingsRpc";

const TALKBACK_PACKAGE = "com.google.android.marvin.talkback";
const TALKBACK_SERVICE_FALLBACK = `${TALKBACK_PACKAGE}/${TALKBACK_PACKAGE}.TalkBackService`;
const DIALOG_DISMISS_RETRIES = 4; // 1 immediate + 3 × 500ms = 1500ms max wait
const DIALOG_DISMISS_DELAY_MS = 500;
const TALKBACK_STATE_CONFIRM_ATTEMPTS = 4; // 1 immediate + 3 × 500ms = 1500ms max wait
const TALKBACK_STATE_CONFIRM_DELAY_MS = 500;
const UIAUTOMATOR_DUMP_TIMEOUT_MS = 30_000;

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

export class TalkBackToggle {
  private readonly adb: AdbExecutor;
  private readonly secureSettings: SecureSettingsRpc;

  constructor(
    private readonly device: BootedDevice,
    adb: AdbExecutor | null = null,
    private readonly detector: AccessibilityDetector = accessibilityDetector,
    private readonly timer: Timer = defaultTimer,
    secureSettings: SecureSettingsRpc | null = null,
  ) {
    this.adb = adb ?? defaultAdbClientFactory.create(device);
    this.secureSettings = secureSettings ?? new CtrlProxySecureSettingsRpc(device);
  }

  async toggle(enabled: boolean): Promise<TalkBackResult> {
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

    // Step 2: Idempotency — invalidate stale cache, then check if TalkBack is
    // already in the requested state.  Use detectMethod rather than
    // isAccessibilityEnabled so that other active services (e.g. CtrlProxy)
    // do not cause a false positive.
    const talkBackCurrentlyEnabled = await this.detectTalkBackEnabled();
    if (talkBackCurrentlyEnabled === enabled) {
      return {
        supported: true,
        applied: false,
        currentState: enabled,
      };
    }

    // Step 3: Apply ADB commands. A settings-write failure here (e.g. the a11y
    // path AND the ADB fallback both fail) is wrapped into a typed result rather
    // than propagating raw out of toggle(), matching the graceful contract of the
    // other paths (#3921).
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
          return {
            supported: true,
            applied: false,
            currentState: talkBackCurrentlyEnabled,
            reason,
          };
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
      return {
        supported: true,
        applied: false,
        currentState: talkBackCurrentlyEnabled,
        reason,
      };
    }

    // Step 5: Re-detect immediately, then allow asynchronous state changes a
    // bounded wait. Each read invalidates the same cache as the idempotency check.
    return {
      ...(await this.confirmTalkBackState(enabled)),
      ...(blockingPrompt ? { blockingPrompt, warning } : {}),
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
      reason = `TalkBack requested ${enabled ? "enabled" : "disabled"} but observed ${confirmedEnabled ? "enabled" : "disabled"} after ${waitMs}ms of confirmation waits`;
      logger.warn(`[TalkBackToggle] ${reason}`);
    }

    return {
      supported: true,
      applied: confirmedEnabled === enabled,
      currentState: confirmedEnabled,
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
  private async detectTalkBackEnabled(): Promise<boolean> {
    this.detector.invalidateCache(this.device.deviceId);
    const service = await this.detector.detectMethod(this.device.deviceId, this.adb);
    return service === "talkback";
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
   * After enabling TalkBack, Android shows a permission dialog that must be
   * accepted before automation can continue.  Check immediately (no initial
   * delay), then retry with delays to allow the dialog time to appear.
   * Match the positive button by resource-id for locale independence, but
   * only when the TalkBack dialog context is confirmed — android:id/button1
   * is a generic ID reused by many dialogs.
   */
  private async dismissPermissionDialog(): Promise<
    "not-found" | "dismissed" | "could-not-confirm"
  > {
    let dialogSeen = false;
    let dumpSucceeded = false;
    let observedXml: string | null = null;

    for (let attempt = 0; attempt < DIALOG_DISMISS_RETRIES; attempt++) {
      if (attempt > 0) {
        await this.timer.sleep(DIALOG_DISMISS_DELAY_MS);
      }
      let xml: string;
      try {
        xml = observedXml ?? (await this.dumpWindowHierarchy());
        dumpSucceeded = true;
      } catch (error) {
        logger.warn(`[TalkBackToggle] Dialog dismissal attempt ${attempt + 1} dump failed:`, error);
        observedXml = null;
        continue;
      }
      observedXml = null;

      const nodeMatch = this.findTalkBackPermissionButton(xml);
      if (!nodeMatch) {
        if (dialogSeen) {
          logger.debug("[TalkBackToggle] TalkBack permission dialog dismissed");
          return "dismissed";
        }
        continue;
      }

      dialogSeen = true;
      const boundsMatch = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(nodeMatch[0]);
      if (boundsMatch) {
        const x = Math.round((parseInt(boundsMatch[1], 10) + parseInt(boundsMatch[3], 10)) / 2);
        const y = Math.round((parseInt(boundsMatch[2], 10) + parseInt(boundsMatch[4], 10)) / 2);
        await this.adb.executeCommand(`shell input tap ${x} ${y}`);
        // Read back immediately after the tap. Reuse a still-matched dump on
        // the next attempt so the happy path costs just one extra dump.
        try {
          observedXml = await this.dumpWindowHierarchy();
          dumpSucceeded = true;
        } catch (error) {
          logger.warn(
            `[TalkBackToggle] Dialog dismissal attempt ${attempt + 1} read-back dump failed:`,
            error,
          );
          observedXml = null;
          continue;
        }
        if (!this.findTalkBackPermissionButton(observedXml)) {
          logger.debug("[TalkBackToggle] TalkBack permission dialog dismissed");
          return "dismissed";
        }
      }
    }

    if (dialogSeen || !dumpSucceeded) {
      return "could-not-confirm";
    }
    return "not-found";
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
