import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { BootedDevice } from "../../models";
import type { TalkBackResult } from "../../models/AccessibilityResult";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AccessibilityDetector } from "../../utils/interfaces/AccessibilityDetector";
import { accessibilityDetector } from "../../utils/AccessibilityDetector";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { type SecureSettingsRpc, CtrlProxySecureSettingsRpc } from "./SecureSettingsRpc";

const TALKBACK_PACKAGE = "com.google.android.marvin.talkback";
const TALKBACK_SERVICE_FALLBACK = `${TALKBACK_PACKAGE}/${TALKBACK_PACKAGE}.TalkBackService`;
const DIALOG_DISMISS_RETRIES = 4; // 1 immediate + 3 × 500ms = 1500ms max wait
const DIALOG_DISMISS_DELAY_MS = 500;

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
    try {
      if (enabled) {
        await this.enableTalkBack(serviceComponent!);
        // Step 4: Best-effort permission dialog dismissal
        await this.dismissPermissionDialog();
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

    // Step 5: Invalidate the detection cache and re-detect to CONFIRM the state
    // actually changed — never report success optimistically. If dialog dismissal
    // failed (or TalkBack never fully activated), `applied` reflects the real
    // post-apply state instead of the requested one (#3921).
    const confirmedEnabled = await this.detectTalkBackEnabled();

    return {
      supported: true,
      applied: confirmedEnabled === enabled,
      currentState: confirmedEnabled,
    };
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
  private async dismissPermissionDialog(): Promise<void> {
    for (let attempt = 0; attempt < DIALOG_DISMISS_RETRIES; attempt++) {
      if (attempt > 0) {
        await this.timer.sleep(DIALOG_DISMISS_DELAY_MS);
      }
      try {
        const xml = await this.dumpWindowHierarchy();

        // Guard: only tap when the TalkBack consent dialog is on screen.
        // "TalkBack" is a brand name that stays untranslated in all locales,
        // preventing accidental taps on unrelated system dialogs.
        if (!xml.includes("TalkBack")) {
          continue;
        }

        // Match by resource-id rather than text to support non-English locales
        const nodeMatch = /<node[^>]*resource-id="android:id\/button1"[^>]*\/?>/.exec(xml);
        if (nodeMatch) {
          const boundsMatch = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(nodeMatch[0]);
          if (boundsMatch) {
            const x = Math.round((parseInt(boundsMatch[1], 10) + parseInt(boundsMatch[3], 10)) / 2);
            const y = Math.round((parseInt(boundsMatch[2], 10) + parseInt(boundsMatch[4], 10)) / 2);
            await this.adb.executeCommand(`shell input tap ${x} ${y}`);
            logger.debug("[TalkBackToggle] Dismissed TalkBack permission dialog");
            return;
          }
        }
      } catch (error) {
        logger.debug(`[TalkBackToggle] Dialog dismissal attempt ${attempt + 1} failed:`, error);
      }
    }
    logger.warn("[TalkBackToggle] TalkBack permission dialog not found — continuing");
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
    await this.adb.executeCommand(`shell uiautomator dump ${remotePath}`);
    const catResult = await this.adb.executeCommand(`shell cat ${remotePath}`);
    return catResult.stdout;
  }
}
