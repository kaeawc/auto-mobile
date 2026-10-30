import { AdbPowerClient } from "../../features/utility/power/AndroidPowerClient";
import { wakeSleptScreen } from "../../features/utility/power/PowerRestore";
import { errorMessage } from "../../utils/describeUnknownError";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { createExecResult } from "../../utils/execResult";
import { adbAttemptTimeoutMs, retryAdbWithinBudget } from "./androidResetBudget";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  outputLooksLikeShellFailure,
  packageListingContains,
} from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote, shellQuoteUnlessSafe } from "../../utils/shellQuote";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { cleanAndroidBaseline } from "./androidKeepBootedCleanup";
import {
  clockCommands,
  deviceStateSettingCommands,
  deviceStatePowerVerification,
  networkConditionCommands,
} from "./androidDeviceStateRevert";
import type { AndroidKeepBootedResetPort } from "./androidKeepBootedReset";
import {
  ANDROID_CERTIFIABLE_KINDS,
  captureAndroidMutationBaseline,
  isAndroidResetFile,
} from "./androidMutationBaseline";
import { settingsBackedRawMutations } from "./androidSettingsBackedRevert";
import { appLocaleJournalAppId, appLocalePrior } from "./appLocaleJournalKey";
import { genericBaselineRevert, type BaselineChange } from "./mutations/baseline";
import type { DeviceMutationResetContext } from "./mutations/reset";
import type { DeviceBaseline, DeviceMutationEntry, DeviceMutationInput } from "./mutations/types";
import {
  SCREEN_STATE_MUTATION_KEY,
  isRestorableScreenState,
} from "./mutations/screenStateMutation";
import {
  systemPropertyJournalName,
  systemPropertyRevertValue,
} from "./mutations/systemPropertyMutation";
import { VOLUME_RESTORED_MARKER, volumeRevertScript } from "./mutations/volumeMutation";

interface AndroidRevertCommand {
  command: string;
  success?: string;
  timeoutMs?: number;
  retryable?: boolean;
  wakeSleptScreen?: boolean;
}

/** A key-press volume revert sets and reads every stream, with a legacy setter fallback. */
const VOLUME_REVERT_TIMEOUT_MS = 10_000;
const PACKAGE_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
type AndroidRevertAdapter = (mutation: DeviceMutationInput) => AndroidRevertCommand[] | null;

export class AndroidDeviceMutationResetPort implements AndroidKeepBootedResetPort {
  readonly certifiableKinds: readonly string[] = ANDROID_CERTIFIABLE_KINDS;
  private readonly adapters: Readonly<Record<string, AndroidRevertAdapter>> = {
    "installed-app": (mutation) => this.packageCommands(mutation),
    permission: (mutation) =>
      this.runtimePermissionCommands(mutation) ?? this.appOpsCommands(mutation),
    "device-setting": (mutation) =>
      this.settingCommands(mutation) ??
      this.displayOverrideCommands(mutation) ??
      this.nightModeCommands(mutation) ??
      this.screenStateCommands(mutation) ??
      this.volumeCommands(mutation) ??
      this.settingsBackedCommands(mutation) ??
      this.appLocaleCommands(mutation) ??
      deviceStateSettingCommands(mutation),
    clock: (mutation) =>
      this.timezoneCommands(mutation) ??
      this.settingCommands(mutation) ??
      clockCommands(mutation, this.timer.now()),
    "network-condition": (mutation) => networkConditionCommands(mutation),
    rotation: (mutation) => this.settingCommands(mutation),
    "keep-awake": (mutation) => this.settingCommands(mutation),
    "screen-reader": (mutation) => this.settingCommands(mutation),
    keyboard: (mutation) => this.settingCommands(mutation),
    clipboard: (mutation) => this.clipboardCommands(mutation),
    location: (mutation) => this.locationCommands(mutation),
    preference: (mutation) =>
      this.appDataCommands(mutation) ?? this.systemPropertyCommands(mutation),
    "shared-file": (mutation) => this.fileCommands(mutation),
    "status-bar": (mutation) => this.statusBarCommands(mutation),
  };

  constructor(
    private readonly adb: AdbCommandRunner,
    private readonly timer: Pick<Timer, "now" | "sleep"> = defaultTimer,
    private readonly dozeBackoff: BackoffPolicy = exponentialBackoff({
      initialDelayMs: 250,
      multiplier: 2,
      maxDelayMs: 1_000,
    }),
  ) {}

  canRevert(mutation: DeviceMutationInput): boolean {
    return this.commands(mutation) !== null;
  }

  baselineRevert(
    change: BaselineChange,
    changes: readonly BaselineChange[],
  ): DeviceMutationInput | null {
    const permissionTarget =
      change.kind === "permission" ? /^runtime(?:-flags)?:(\d+):([^:]+):/.exec(change.key) : null;
    const packageName =
      change.kind === "installed-app" && change.key.startsWith("identity:")
        ? change.key.slice("identity:".length)
        : permissionTarget?.[2];
    if (change.priorValue.state === "absent" && packageName) {
      const install = changes.find(
        (candidate) =>
          candidate.kind === "installed-app" &&
          candidate.priorValue.state === "absent" &&
          /^user:\d+:/.test(candidate.key) &&
          (!permissionTarget || candidate.key.startsWith(`user:${permissionTarget[1]}:`)) &&
          candidate.key.endsWith(`:${packageName}`),
      );
      if (install) {
        return {
          kind: install.kind,
          key: install.key,
          priorValue: install.priorValue,
          toolName: "baseline-diff",
        };
      }
    }
    const mutation = {
      kind: change.kind,
      key: change.key,
      priorValue: change.priorValue,
      toolName: "baseline-diff",
    };
    return ["installed-app", "permission", "device-setting", "shared-file"].includes(change.kind) &&
      this.canRevert(mutation)
      ? mutation
      : genericBaselineRevert(change);
  }

  capture(context: DeviceMutationResetContext): Promise<DeviceBaseline> {
    return captureAndroidMutationBaseline((command, timeoutMs) =>
      this.execute(command, context, timeoutMs),
    );
  }

  async cleanBaseline(
    baseline: DeviceBaseline,
    context: DeviceMutationResetContext,
    journalEntries: readonly DeviceMutationEntry[] = [],
  ): Promise<void> {
    await cleanAndroidBaseline(
      baseline,
      context,
      (command, timeoutMs) => this.execute(command, context, timeoutMs),
      (mutation) => this.revert(mutation, context),
      journalEntries,
    );
    const output = await this.execute("shell cmd clipboard clear", context, undefined, true);
    if (this.unsupportedClipboard(output)) {
      logger.warn("Android cleaning skipped unsupported clipboard clear");
    } else if (this.failedOutput(output)) {
      throw new ActionableError("Android clipboard cleaning command failed");
    }
  }

  private unsupportedClipboard(output: string): boolean {
    return /Unknown command:|Can't find service:|No shell command implementation|Service .* not found/i.test(
      output,
    );
  }

  private failedOutput(output: string): boolean {
    return (
      outputLooksLikeShellFailure(output, "") ||
      /^(?:Failure \[.*\]|Error:.*|Unknown command:.*|Unknown option:.*|Permission Denial:.*|usage:.*|Can't find service:.*)\s*$/im.test(
        output.trim(),
      )
    );
  }

  async revert(mutation: DeviceMutationInput, context: DeviceMutationResetContext): Promise<void> {
    const commands = this.commands(mutation);
    if (!commands) {
      throw new ActionableError(`Android cannot restore ${mutation.kind}:${mutation.key}`);
    }
    if (
      mutation.kind === "installed-app" &&
      mutation.priorValue.state === "absent" &&
      (await this.packageAbsent(mutation.key, context))
    ) {
      return;
    }
    for (const { command, success, timeoutMs, retryable, wakeSleptScreen } of commands) {
      const output = await this.execute(
        command,
        context,
        timeoutMs,
        mutation.kind === "clipboard",
        retryable,
      );
      if (mutation.kind === "clipboard" && this.unsupportedClipboard(output)) {
        logger.warn("Android cleaning skipped unsupported journal clipboard clear");
        continue;
      }
      if ((success !== undefined && output !== success) || this.failedOutput(output)) {
        throw new ActionableError("Android reset command failed to confirm success");
      }
      if (wakeSleptScreen) {
        await this.wakeBeforeReadBack(context);
      }
    }
    await this.verifyPower(mutation, context);
  }

  private powerClient(context: DeviceMutationResetContext): AdbPowerClient {
    return new AdbPowerClient({
      execute: async (args) =>
        createExecResult(await this.execute(args.map(shellQuoteUnlessSafe).join(" "), context), ""),
      isScreenOn: async () =>
        /mWakefulness=Awake/.test(
          await this.execute("shell dumpsys power | grep mWakefulness=", context),
        ),
    });
  }

  /** A failed wake never fails the revert: the Doze read-back stays the authority (#15168). */
  private async wakeBeforeReadBack(context: DeviceMutationResetContext): Promise<void> {
    try {
      await wakeSleptScreen({ screenSlept: true }, this.powerClient(context));
    } catch (error) {
      context.signal.throwIfAborted();
      logger.warn(
        `Android reset could not wake the screen before the Doze read-back: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async verifyPower(
    mutation: DeviceMutationInput,
    context: DeviceMutationResetContext,
  ): Promise<void> {
    const verify = deviceStatePowerVerification(mutation);
    if (!verify) {
      return;
    }
    const client = this.powerClient(context);
    let description: string | null;
    try {
      // settleDoze watches the ambient abort signal, so an aborted reset stops the poll at once.
      description = await runWithAbortSignal(context.signal, () =>
        verify(client, {
          timer: this.timer,
          backoff: this.dozeBackoff,
          budgetMs:
            context.deadlineMs === undefined
              ? 3_000
              : Math.max(0, Math.min(3_000, context.deadlineMs - this.timer.now())),
        }),
      );
    } catch (error) {
      throw toActionableError(error, "Android reset could not read back device state");
    }
    if (description !== null) {
      throw new ActionableError(
        `Android reset could not confirm ${mutation.key} was restored: ${description}`,
      );
    }
  }

  private async packageAbsent(
    packageName: string,
    context: DeviceMutationResetContext,
  ): Promise<boolean> {
    const userPackage = /^user:(\d+):(.+)$/.exec(packageName);
    if (!userPackage) {
      throw new ActionableError("Android reset requires a user-scoped package key");
    }
    const inventory = await this.execute(
      `shell pm list packages --user ${userPackage[1]}`,
      context,
    );
    if (
      !packageListingContains(inventory, "android") ||
      inventory
        .split("\n")
        .some((line) => !/^package:[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(line.trim()))
    ) {
      throw new ActionableError("Android reset cannot confirm package absence");
    }
    return !packageListingContains(inventory, userPackage[2]!);
  }

  private async execute(
    command: string,
    context: DeviceMutationResetContext,
    // Legacy callers without a deadline retain one attempt; reset deadlines turn this into a floor.
    timeoutMs = 2000,
    optionalClipboard = false,
    retryable = true,
  ): Promise<string> {
    try {
      const dispatch = async (attemptTimeoutMs: number) => {
        await context.assertOwned();
        context.signal.throwIfAborted();
        return this.adb.executeCommand(command, {
          signal: context.signal,
          timeoutMs: attemptTimeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          noRetry: true,
          waitForProcessSettlementAfterAbort: true,
        });
      };
      const result =
        context.deadlineMs === undefined
          ? await dispatch(timeoutMs)
          : await retryAdbWithinBudget(
              (attemptTimeoutMs) =>
                dispatch(
                  retryable
                    ? attemptTimeoutMs
                    : Math.min(
                        context.deadlineMs! - this.timer.now(),
                        Math.max(
                          timeoutMs,
                          adbAttemptTimeoutMs(context.deadlineMs! - this.timer.now(), 3),
                        ),
                      ),
                ),
              {
                timer: this.timer,
                deadlineMs: context.deadlineMs,
                signal: context.signal,
                label: "Android reset command",
                minAttemptMs: timeoutMs,
                attempts: retryable ? undefined : 1,
              },
            );
      context.signal.throwIfAborted();
      await context.assertOwned();
      if (optionalClipboard && this.unsupportedClipboard(`${result.stdout}\n${result.stderr}`)) {
        return `${result.stdout}\n${result.stderr}`;
      }
      if (result.error || result.stderr.trim()) {
        throw new ActionableError("Android reset command failed");
      }
      return result.stdout.replace(/\r?\n$/, "");
    } catch (error) {
      throw toActionableError(error, "Android reset command failed");
    }
  }

  private commands(mutation: DeviceMutationInput): AndroidRevertCommand[] | null {
    const adapter = Object.hasOwn(this.adapters, mutation.kind)
      ? this.adapters[mutation.kind]
      : undefined;
    return adapter?.(mutation) ?? null;
  }

  private packageCommands({ key, priorValue }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const target = /^user:(\d+):(.+)$/.exec(key);
    return priorValue.state === "absent" && target && PACKAGE_PATTERN.test(target[2]!)
      ? [
          { command: `shell am force-stop --user ${target[1]} ${shellQuote(target[2]!)}` },
          {
            command: `shell pm uninstall --user ${target[1]} ${shellQuote(target[2]!)}`,
            retryable: false,
            success: "Success",
            timeoutMs: 10_000,
          },
        ]
      : null;
  }

  private runtimePermissionCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const prior = priorValue.state === "present" ? priorValue.value : undefined;
    const runtime = /^runtime:(\d+):([A-Za-z0-9_.]+):([A-Za-z0-9_.]+)$/.exec(key);
    return runtime && PACKAGE_PATTERN.test(runtime[2]!) && typeof prior === "boolean"
      ? [
          {
            command: `shell pm ${prior ? "grant" : "revoke"} --user ${runtime[1]} ${shellQuote(runtime[2]!)} ${shellQuote(runtime[3]!)}`,
          },
        ]
      : null;
  }

  private appOpsCommands({ key, priorValue }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const prior = priorValue.state === "present" ? priorValue.value : undefined;
    const absent = priorValue.state === "absent";
    const appops = /^appops:(\d+):([A-Za-z0-9_.]+):([A-Za-z0-9_]+)$/.exec(key);
    return appops &&
      PACKAGE_PATTERN.test(appops[2]!) &&
      (absent ||
        (typeof prior === "string" &&
          ["allow", "ignore", "deny", "default", "foreground"].includes(prior)))
      ? [
          {
            command: `shell cmd appops set --user ${appops[1]} ${shellQuote(appops[2]!)} ${shellQuote(appops[3]!)} ${absent ? "default" : prior}`,
          },
        ]
      : null;
  }

  private settingCommands(mutation: DeviceMutationInput): AndroidRevertCommand[] | null {
    const { key, priorValue } = mutation;
    const prior = priorValue.state === "present" ? priorValue.value : undefined;
    const absent = priorValue.state === "absent";
    const setting =
      /^(global|secure|system):(?:(?:user:(\d+)):)?(?!user:)([A-Za-z0-9_][A-Za-z0-9_.:-]*)$/.exec(
        key,
      );
    if (!setting || (!absent && typeof prior !== "string")) {
      return null;
    }
    if (
      [
        "global:airplane_mode_on",
        "global:wifi_on",
        "global:mobile_data",
        "global:zen_mode",
      ].includes(key) &&
      !absent
    ) {
      return this.connectivityCommands(mutation);
    }
    return [
      {
        command: absent
          ? `shell settings --user ${setting[2] ?? "0"} delete ${setting[1]} ${setting[3]}`
          : `shell settings --user ${setting[2] ?? "0"} put ${setting[1]} ${setting[3]} ${shellQuote(prior as string)}`,
      },
    ];
  }

  /** fontScale, timeFormat and accessibility display rows restore their raw settings rows. */
  private settingsBackedCommands(mutation: DeviceMutationInput): AndroidRevertCommand[] | null {
    const raw = settingsBackedRawMutations(mutation);
    if (!raw) {
      return null;
    }
    const commands = raw.map((row) => this.settingCommands(row));
    return commands.every((command) => command !== null) ? commands.flat() : null;
  }

  /**
   * Puts back an app's locale list (`""` clears its override) for the user changeLocalization
   * targeted, then reads it back: `cmd locale` exits 0 and prints nothing on success, and an
   * unknown package is reported on stderr, which fails the command.
   */
  private appLocaleCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const appId = appLocaleJournalAppId(key);
    const prior = appLocalePrior(priorValue);
    if (appId === null || !PACKAGE_PATTERN.test(appId) || !prior) {
      return null;
    }
    const { userId, locales } = prior;
    return [
      {
        command: `shell cmd locale set-app-locales ${shellQuote(appId)} --user ${userId} --locales ${shellQuote(locales)}`,
        success: "",
      },
      {
        command: `shell cmd locale get-app-locales ${shellQuote(appId)} --user ${userId}`,
        success: `Locales for ${appId} for user ${userId} are [${locales}]`,
      },
    ];
  }

  private connectivityCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const prior = priorValue.state === "present" ? priorValue.value : undefined;
    if (typeof prior !== "string") {
      return null;
    }
    if (key === "global:zen_mode") {
      const modes: Record<string, string> = {
        "0": "off",
        "1": "priority",
        "2": "none",
        "3": "alarms",
      };
      return Object.hasOwn(modes, prior)
        ? [{ command: `shell cmd notification set_dnd ${modes[prior]}` }]
        : null;
    }
    if (prior !== "0" && prior !== "1") {
      return null;
    }
    const command =
      key === "global:airplane_mode_on"
        ? `shell cmd connectivity airplane-mode ${prior === "1" ? "enable" : "disable"}`
        : `shell svc ${key === "global:wifi_on" ? "wifi" : "data"} ${prior === "1" ? "enable" : "disable"}`;
    return [{ command }];
  }

  private displayOverrideCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    if (key !== "display:density" && key !== "display:size") {
      return null;
    }
    const type = key.slice("display:".length);
    const prior = priorValue.state === "present" ? priorValue.value : undefined;
    const absent = priorValue.state === "absent";
    const pattern = type === "density" ? /^\d+$/ : /^\d+x\d+$/;
    return absent || (typeof prior === "string" && pattern.test(prior))
      ? [{ command: `shell wm ${type} ${absent ? "reset" : prior}` }]
      : null;
  }

  /**
   * Puts the screen back after a power-key press or the lock action: wake it and dismiss the
   * keyguard. Only a prior that was awake, unlocked and credential-free is restorable; a reset
   * cannot enter a PIN, so a secure or unreadable prior is left to the next wakeAndUnlock.
   */
  private screenStateCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    return key === SCREEN_STATE_MUTATION_KEY && isRestorableScreenState(priorValue)
      ? [
          { command: "shell input keyevent KEYCODE_WAKEUP" },
          { command: "shell wm dismiss-keyguard" },
        ]
      : null;
  }

  /**
   * Sets each stream a volume row covers back to its journaled level in one device shell, which
   * prints the marker only when every stream reads its level back; any other output fails the
   * revert. Unrestorable priors (unreadable, or a level of 0) have no command.
   */
  private volumeCommands({ key, priorValue }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const script = volumeRevertScript(key, priorValue);
    return script === null
      ? null
      : [
          {
            command: `shell sh -c ${shellQuote(script)}`,
            success: VOLUME_RESTORED_MARKER,
            timeoutMs: VOLUME_REVERT_TIMEOUT_MS,
          },
        ];
  }

  private nightModeCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const prior = priorValue.state === "present" ? priorValue.value : undefined;
    return key === "display:night-mode" &&
      typeof prior === "string" &&
      ["yes", "no", "auto"].includes(prior)
      ? [{ command: `shell cmd uimode night ${prior}` }]
      : null;
  }

  private timezoneCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const prior = priorValue.state === "present" ? priorValue.value : undefined;
    return key === "timezone" && typeof prior === "string" && prior.length > 0
      ? [
          { command: `shell cmd alarm set-timezone ${shellQuote(prior)}` },
          // The prior was read from this property, so only an identical read-back proves restore.
          { command: "shell getprop persist.sys.timezone", success: prior },
        ]
      : null;
  }

  private clipboardCommands({ priorValue }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const prior = priorValue.state === "present" ? priorValue.value : undefined;
    return priorValue.state === "absent" || prior === "" || prior === null
      ? [{ command: "shell cmd clipboard clear" }]
      : null;
  }

  private locationCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    return priorValue.state === "absent" && /^provider:(gps|network|fused)$/.test(key)
      ? [
          {
            command: `shell cmd location providers remove-test-provider ${key.slice("provider:".length)}`,
          },
        ]
      : null;
  }

  private appDataCommands({ key, priorValue }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const appData = /^app-data:(\d+):([A-Za-z0-9_.]+)$/.exec(key);
    return priorValue.state === "absent" && appData && PACKAGE_PATTERN.test(appData[2]!)
      ? [
          { command: `shell am force-stop --user ${appData[1]} ${shellQuote(appData[2]!)}` },
          {
            command: `shell pm clear --user ${appData[1]} ${shellQuote(appData[2]!)}`,
            retryable: false,
            success: "Success",
          },
        ]
      : null;
  }

  /**
   * Puts back a property `setPreference` wrote: `setprop` prints nothing on success, and only a
   * read-back equal to the prior proves the restore. An absent prior is restored as `""`, which
   * `getprop` reads the same as absent (`setprop` cannot delete a property); a `persist.*` name
   * also writes that empty value to disk. Read-only and control properties have no revert.
   */
  private systemPropertyCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const name = systemPropertyJournalName(key);
    const prior = systemPropertyRevertValue(priorValue);
    return name === null || prior === null
      ? null
      : [
          { command: `shell setprop ${name} ${shellQuote(prior)}`, success: "" },
          { command: `shell getprop ${name}`, success: prior },
        ];
  }

  /** Leaves SystemUI demo mode, then puts `sysui_demo_allowed` back to its journaled value. */
  private statusBarCommands({
    key,
    priorValue,
  }: DeviceMutationInput): AndroidRevertCommand[] | null {
    const prior = priorValue.state === "present" ? priorValue.value : undefined;
    if (key !== "device" || (priorValue.state !== "absent" && typeof prior !== "string")) {
      return null;
    }
    return [
      { command: "shell am broadcast -a com.android.systemui.demo -e command exit" },
      {
        command:
          priorValue.state === "absent"
            ? "shell settings delete global sysui_demo_allowed"
            : `shell settings put global sysui_demo_allowed ${shellQuote(prior as string)}`,
      },
    ];
  }

  private fileCommands({ key, priorValue }: DeviceMutationInput): AndroidRevertCommand[] | null {
    if (priorValue.state !== "absent" || !isAndroidResetFile(key)) {
      return null;
    }
    const script = `root=$(readlink -f /sdcard) && [ -n "$root" ] && target=$(readlink -f ${shellQuote(key)}) && [ "$target" = "$root"${shellQuote(key.slice("/sdcard".length))} ] && [ ! -L ${shellQuote(key)} ] && rm -f -- ${shellQuote(key)}`;
    return [
      { command: `shell sh -c ${shellQuote(script)}` },
      {
        command: `shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellQuote(`file://${key}`)}`,
      },
    ];
  }
}
