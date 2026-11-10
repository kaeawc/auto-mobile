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
import type { AccessibilityDetector } from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { accessibilityDetector } from "../../ctrlProxy/accessibility/AccessibilityDetector";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import {
  blockingPromptForForegroundActivity,
  isRuntimePermissionPrompt,
} from "../observe/BlockingSystemPrompt";
import { parseAndroidRuntimePermissions } from "../action/parseAndroidRuntimePermissions";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
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

/** The shared runtime-permission prompt check, under the name TalkBack callers already use. */
// #6499 device check, 2026-09-25: API 36 google_apis arm64, HEAD 21791e9da,
// GrantPermissionsActivity showed "Allow Android Accessibility Suite to send you
// notifications?" with permission_allow_button / permission_deny_button. Back did not
// dismiss it; the caller used tapOn on permission_deny_button.
const BLOCKING_PROMPT_WARNING =
  "A system runtime permission prompt is covering the screen after enabling TalkBack. " +
  "On API 36 this was observed as the Android Accessibility Suite (TalkBack) notifications permission. " +
  "The foreground activity does not identify the requested permission. Nothing was tapped. " +
  "You must answer it: use observe to inspect the prompt, then tapOn its permission_allow_button or permission_deny_button.";
/** TalkBack had no runtime permission left to request, so another app raised the prompt. */
const OTHER_APP_PROMPT_WARNING =
  "A system runtime permission prompt is covering the screen after enabling TalkBack. " +
  "TalkBack has no runtime permission left to request, so another app raised it. Nothing was tapped. " +
  "You must answer it: use observe to inspect the prompt, then tapOn its permission_allow_button or permission_deny_button.";

/**
 * The warning for a prompt seen after enabling TalkBack. `talkBackMayPrompt` is false only when
 * TalkBack's permission state shows it cannot be TalkBack's own permission prompt.
 */
function blockingPromptWarning(prompt: TalkBackBlockingPrompt, talkBackMayPrompt: boolean): string {
  if (prompt.kind === "system-dialog") {
    return (
      `A system window (${prompt.package}/${prompt.activity}) is covering the screen after enabling TalkBack. ` +
      "Nothing was tapped. Use observe to inspect it, then dismiss it (tapOn its button, or pressButton back)."
    );
  }
  return talkBackMayPrompt ? BLOCKING_PROMPT_WARNING : OTHER_APP_PROMPT_WARNING;
}

export const isTalkBackRuntimePermissionPrompt = isRuntimePermissionPrompt;

/**
 * Bounded wait after a successful enable for a runtime prompt TalkBack raises late: on
 * 0.0.88 a permission controller prompt appeared about 3 s after the toggle returned (#17668).
 */
export const TALKBACK_PROMPT_SETTLE_MS = 4_000;
export const TALKBACK_PROMPT_SETTLE_POLL_MS = 500;
/**
 * Consecutive identical prompt-free foreground reads that count as a stable screen. The window
 * only ends on them when TalkBack has no runtime permission left to request: a stable screen
 * alone is no evidence, because the #17668 prompt appeared over an unchanged app.
 */
export const TALKBACK_PROMPT_STABLE_READS = 2;
/** Flags under which Android no longer shows a runtime prompt for a denied permission. */
const NON_PROMPTABLE_PERMISSION_FLAGS = ["USER_FIXED", "POLICY_FIXED", "SYSTEM_FIXED"];

/** Whether a foreground read in the settle window saw a prompt, a readable screen, or nothing. */
type SettleRead =
  | { kind: "prompt"; prompt: TalkBackBlockingPrompt }
  | { kind: "screen"; signature: string }
  | { kind: "unknown" };

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

/** The CtrlProxy seams TalkBackToggle reads and writes through; each defaults to the device's. */
export interface TalkBackToggleCtrlProxy {
  secureSettings?: SecureSettingsRpc | null;
  dialogProbe?: TalkBackDialogProbe | null;
}

export interface TalkBackToggleTiming {
  timer?: Timer;
  /**
   * After an applied enable with no prompt yet, keep reading the foreground for this long and
   * report a runtime prompt that appears in it. 0 (the default) reads once; the `accessibility`
   * tool passes {@link TALKBACK_PROMPT_SETTLE_MS}. Session restore leaves it 0 so its
   * worst-case budget is unchanged. The window ends early once the screen is stable and
   * TalkBack has no runtime permission it could still prompt for.
   */
  promptSettleMs?: number;
  /** The request's abort signal: a cancelled call stops waiting in the settle window. */
  signal?: AbortSignal;
}

export class TalkBackToggle {
  private readonly adb: AdbExecutor;
  private readonly secureSettings: SecureSettingsRpc;
  private readonly dialogProbe: TalkBackDialogProbe;
  private readonly timer: Timer;
  private readonly promptSettleMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(
    private readonly device: BootedDevice,
    adb: AdbExecutor | null = null,
    private readonly detector: AccessibilityDetector = accessibilityDetector,
    {
      timer = defaultTimer,
      promptSettleMs = 0,
      signal,
      secureSettings,
      dialogProbe,
    }: TalkBackToggleCtrlProxy & TalkBackToggleTiming = {},
  ) {
    this.timer = timer;
    this.promptSettleMs = promptSettleMs;
    this.signal = signal;
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
          logger.warn(`[TalkBackToggle] ${blockingPromptWarning(blockingPrompt, true)}`);
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
    return await this.confirmWithBlockingPrompt(enabled, blockingPrompt);
  }

  /** Confirm the state, then report a prompt already seen or one raised in the settle window. */
  private async confirmWithBlockingPrompt(
    enabled: boolean,
    seenPrompt: TalkBackBlockingPrompt | undefined,
  ): Promise<TalkBackResult> {
    const confirmed = await this.confirmTalkBackState(enabled);
    if (seenPrompt) {
      // Seen before TalkBack's permission state was read, so it may be TalkBack's own.
      return {
        ...confirmed,
        blockingPrompt: seenPrompt,
        warning: blockingPromptWarning(seenPrompt, true),
      };
    }
    if (!enabled || !confirmed.applied) {
      return confirmed;
    }
    const late = await this.awaitLateBlockingPrompt();
    if (!late) {
      return confirmed;
    }
    const warning = blockingPromptWarning(late.prompt, late.talkBackMayPrompt);
    logger.warn(`[TalkBackToggle] ${warning}`);
    return { ...confirmed, blockingPrompt: late.prompt, warning };
  }

  /**
   * Poll the foreground through the settle window; a prompt TalkBack raises late lands here, and
   * so does any other system prompt (another app's permission prompt, a SystemUI or framework
   * dialog). End early once {@link TALKBACK_PROMPT_STABLE_READS} reads agree and TalkBack has no
   * runtime permission left to request; a prompt read never counts toward that stable screen. An
   * abort of the request rejects the wait.
   */
  private async awaitLateBlockingPrompt(): Promise<
    { prompt: TalkBackBlockingPrompt; talkBackMayPrompt: boolean } | undefined
  > {
    const polls = Math.floor(this.promptSettleMs / TALKBACK_PROMPT_SETTLE_POLL_MS);
    if (polls === 0) {
      return undefined;
    }
    throwIfAborted(this.signal);
    const promptPossible = await this.talkBackMayStillPrompt();
    let lastSignature: string | undefined;
    let stableReads = 0;
    for (let poll = 0; poll < polls; poll++) {
      await awaitWhileRequestIsLive(this.timer.sleep(TALKBACK_PROMPT_SETTLE_POLL_MS), this.signal);
      const read = await this.readSettleForeground();
      throwIfAborted(this.signal);
      if (read.kind === "prompt") {
        return { prompt: read.prompt, talkBackMayPrompt: promptPossible };
      }
      const signature = read.kind === "screen" ? read.signature : undefined;
      stableReads = signature !== undefined && signature === lastSignature ? stableReads + 1 : 1;
      lastSignature = signature;
      if (
        !promptPossible &&
        signature !== undefined &&
        stableReads >= TALKBACK_PROMPT_STABLE_READS
      ) {
        logger.debug(
          `[TalkBackToggle] Screen stable with no pending TalkBack permission after ${(poll + 1) * TALKBACK_PROMPT_SETTLE_POLL_MS}ms; ending settle window`,
        );
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Whether TalkBack may still raise a runtime permission prompt: some runtime permission is
   * neither granted nor fixed. Unreadable or absent permission state counts as possible, so the
   * full window runs.
   */
  private async talkBackMayStillPrompt(): Promise<boolean> {
    try {
      const result = await this.adb.executeCommand(`shell dumpsys package ${TALKBACK_PACKAGE}`, {
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
      });
      if (outputLooksLikeShellFailure(result.stdout, result.stderr ?? "")) {
        return true;
      }
      const runtime = parseAndroidRuntimePermissions(
        result.stdout,
        TALKBACK_PACKAGE,
      )?.runtimePermissions;
      if (!runtime || runtime.size === 0) {
        return true;
      }
      return [...runtime.values()].some(({ state, raw }) => {
        const flags = typeof raw?.flags === "string" ? raw.flags : "";
        return (
          state !== "granted" && !NON_PROMPTABLE_PERMISSION_FLAGS.some((f) => flags.includes(f))
        );
      });
    } catch (error) {
      // Advisory: an unreadable permission state only keeps the full settle window.
      logger.debug("[TalkBackToggle] TalkBack permission read failed:", errorMessage(error));
      return true;
    }
  }

  private async readSettleForeground(): Promise<SettleRead> {
    try {
      const app = await this.adb.getForegroundApp(this.signal);
      if (!app) {
        logger.debug("[TalkBackToggle] Foreground app unavailable; no prompt reported");
        return { kind: "unknown" };
      }
      const prompt = blockingPromptForForegroundActivity(app);
      if (prompt) {
        return { kind: "prompt", prompt };
      }
      return { kind: "screen", signature: `${app.packageName}/${app.activityName ?? ""}` };
    } catch (error) {
      // Prompt detection is advisory; enabled-state read-back remains the source of truth, and
      // an unreadable settle poll only resets the stability count.
      logger.debug("[TalkBackToggle] Foreground prompt read failed:", errorMessage(error));
      return { kind: "unknown" };
    }
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
    const read = await this.readSettleForeground();
    return read.kind === "prompt" ? read.prompt : undefined;
  }

  /**
   * Invalidate the stale detection cache and re-detect whether TalkBack
   * specifically is the active service. Used both for the pre-apply idempotency
   * check and the post-apply confirmation so the two never drift.
   */
  async detectTalkBackEnabled(): Promise<boolean | null> {
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
    await this.adb.executeCommand(`shell uiautomator dump ${remotePath}`, {
      timeoutMs: UIAUTOMATOR_DUMP_TIMEOUT_MS,
    });
    const catResult = await this.adb.executeCommand(`shell cat ${remotePath}`);
    return catResult.stdout;
  }
}
