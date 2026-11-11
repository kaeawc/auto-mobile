import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  emulatorConsoleFailureReason,
  emulatorConsoleReportsFailure,
} from "../../utils/android-cmdline-tools/emulatorConsoleReply";
import { shellQuote } from "../../utils/shellQuote";
import {
  ANDROID_AUTO_NOTIFICATION_LISTENER,
  ANDROID_AUTO_PACKAGE,
  ANDROID_AUTO_SETTINGS_ACTION,
  HEAD_UNIT_SERVER_PORT,
} from "./androidAutoProjection";

/** The adb-only phone operations Android Auto projection provisioning needs. */
export interface AndroidAutoPhone {
  /** Whether Android Auto runs from a sideloaded update rather than the image's stub. */
  isAndroidAutoSideloaded(signal?: AbortSignal): Promise<boolean>;
  installSplitApks(apkPaths: readonly string[], signal?: AbortSignal): Promise<void>;
  isKeyguardDisabled(signal?: AbortSignal): Promise<boolean>;
  disableKeyguard(signal?: AbortSignal): Promise<void>;
  isStayOnEnabled(signal?: AbortSignal): Promise<boolean>;
  enableStayOn(signal?: AbortSignal): Promise<void>;
  isNotificationListenerAllowed(signal?: AbortSignal): Promise<boolean>;
  allowNotificationListener(signal?: AbortSignal): Promise<void>;
  isHeadUnitServerListening(signal?: AbortSignal): Promise<boolean>;
  openAndroidAutoSettings(signal?: AbortSignal): Promise<void>;
  forceStopAndroidAuto(signal?: AbortSignal): Promise<void>;
  /** `adb emu redir add`: unlike `adb forward`, the redirect survives an adb transport drop. */
  addHeadUnitRedirect(signal?: AbortSignal): Promise<void>;
  /** `adb emu redir del`: frees host port 5277 on a phone emulator that keeps running. */
  removeHeadUnitRedirect(signal?: AbortSignal): Promise<void>;
}

export type AndroidAutoPhoneAdb = Pick<AdbExecutor, "execute">;

const QUERY_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 300_000;
const YES = "yes";

/**
 * Wraps a device-shell condition so the reply is this module's own `yes`/`no`
 * token, never the tool's raw output (whose format varies by Android release).
 */
function yesNo(condition: string): string {
  return `if ${condition}; then echo ${YES}; else echo no; fi`;
}

/** Updated system apps install under /data/app; the image's stub lives on a read-only partition. */
const SIDELOADED_CHECK = yesNo(`pm path ${ANDROID_AUTO_PACKAGE} | grep -q '^package:/data/'`);
const KEYGUARD_DISABLED_CHECK = yesNo(`[ "$(locksettings get-disabled)" = true ]`);
/** `svc power stayon true` sets a non-zero plug mask; 0 (or an unset key) means it is off. */
const STAY_ON_CHECK = yesNo(
  `v=$(settings get global stay_on_while_plugged_in); [ -n "$v" ] && [ "$v" != 0 ] && [ "$v" != null ]`,
);
const LISTENER_CHECK = yesNo(
  `settings get secure enabled_notification_listeners | tr ':' '\\n' | grep -qxF ${shellQuote(ANDROID_AUTO_NOTIFICATION_LISTENER)}`,
);
const SERVER_LISTENING_CHECK = yesNo(
  `netstat -ltn 2>/dev/null | grep -q ':${HEAD_UNIT_SERVER_PORT} '`,
);

export class AdbAndroidAutoPhone implements AndroidAutoPhone {
  constructor(private readonly adb: AndroidAutoPhoneAdb) {}

  isAndroidAutoSideloaded(signal?: AbortSignal): Promise<boolean> {
    return this.query(SIDELOADED_CHECK, "Android Auto install check", signal);
  }

  async installSplitApks(apkPaths: readonly string[], signal?: AbortSignal): Promise<void> {
    const result = await this.run(
      ["install-multiple", "-r", ...apkPaths],
      "adb install-multiple of the Android Auto APKs",
      { timeoutMs: INSTALL_TIMEOUT_MS, signal },
    );
    if (!result.stdout.includes("Success")) {
      throw new ActionableError(
        `adb install-multiple did not report Success for the Android Auto APKs: ${(result.stderr || result.stdout).trim()}`,
      );
    }
  }

  isKeyguardDisabled(signal?: AbortSignal): Promise<boolean> {
    return this.query(KEYGUARD_DISABLED_CHECK, "keyguard check", signal);
  }

  async disableKeyguard(signal?: AbortSignal): Promise<void> {
    await this.shell("locksettings set-disabled true", "locksettings set-disabled", signal);
  }

  isStayOnEnabled(signal?: AbortSignal): Promise<boolean> {
    return this.query(STAY_ON_CHECK, "stay-awake check", signal);
  }

  async enableStayOn(signal?: AbortSignal): Promise<void> {
    await this.shell("svc power stayon true", "svc power stayon", signal);
  }

  isNotificationListenerAllowed(signal?: AbortSignal): Promise<boolean> {
    return this.query(LISTENER_CHECK, "notification access check", signal);
  }

  async allowNotificationListener(signal?: AbortSignal): Promise<void> {
    await this.shell(
      `cmd notification allow_listener ${shellQuote(ANDROID_AUTO_NOTIFICATION_LISTENER)}`,
      "cmd notification allow_listener",
      signal,
    );
  }

  isHeadUnitServerListening(signal?: AbortSignal): Promise<boolean> {
    return this.query(SERVER_LISTENING_CHECK, "head unit server check", signal);
  }

  async openAndroidAutoSettings(signal?: AbortSignal): Promise<void> {
    await this.shell(
      `am start -a ${ANDROID_AUTO_SETTINGS_ACTION} -p ${ANDROID_AUTO_PACKAGE}`,
      "opening Android Auto settings",
      signal,
    );
  }

  async forceStopAndroidAuto(signal?: AbortSignal): Promise<void> {
    await this.shell(`am force-stop ${ANDROID_AUTO_PACKAGE}`, "am force-stop", signal);
  }

  async addHeadUnitRedirect(signal?: AbortSignal): Promise<void> {
    const spec = `tcp:${HEAD_UNIT_SERVER_PORT}:${HEAD_UNIT_SERVER_PORT}`;
    const result = await this.run(["emu", "redir", "add", spec], `adb emu redir add ${spec}`, {
      timeoutMs: QUERY_TIMEOUT_MS,
      signal,
    });
    if (result.error || emulatorConsoleReportsFailure(result.stdout, result.stderr)) {
      throw new ActionableError(
        `adb emu redir add ${spec} failed: ${result.error ?? emulatorConsoleFailureReason(result.stdout, result.stderr)}. The redirect needs an emulator; a physical phone is not supported.`,
      );
    }
  }

  async removeHeadUnitRedirect(signal?: AbortSignal): Promise<void> {
    const spec = `tcp:${HEAD_UNIT_SERVER_PORT}`;
    const result = await this.run(["emu", "redir", "del", spec], `adb emu redir del ${spec}`, {
      timeoutMs: QUERY_TIMEOUT_MS,
      signal,
    });
    if (result.error || emulatorConsoleReportsFailure(result.stdout, result.stderr)) {
      throw new ActionableError(
        `adb emu redir del ${spec} failed: ${result.error ?? emulatorConsoleFailureReason(result.stdout, result.stderr)}.`,
      );
    }
  }

  private async query(script: string, label: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.shell(script, label, signal);
    return result.stdout.trim() === YES;
  }

  private shell(script: string, label: string, signal?: AbortSignal) {
    return this.run(["shell", script], label, { timeoutMs: QUERY_TIMEOUT_MS, signal });
  }

  private async run(
    args: string[],
    label: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ) {
    try {
      return await this.adb.execute(args, { ...options, noRetry: true });
    } catch (error) {
      throw toActionableError(error, `Android Auto provisioning: ${label} failed`);
    }
  }
}
