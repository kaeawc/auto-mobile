import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  outputLooksLikeShellFailure,
  packageListingContains,
} from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { shellQuote } from "../../utils/shellQuote";
import { logger } from "../../utils/logger";
import { cleanAndroidBaseline } from "./androidKeepBootedCleanup";
import type { AndroidKeepBootedResetPort } from "./androidKeepBootedReset";
import {
  ANDROID_CERTIFIABLE_KINDS,
  captureAndroidMutationBaseline,
  isAndroidResetFile,
} from "./androidMutationBaseline";
import { genericBaselineRevert, type BaselineChange } from "./mutations/baseline";
import type { DeviceMutationResetContext } from "./mutations/reset";
import type { DeviceBaseline, DeviceMutationInput } from "./mutations/types";

interface AndroidRevertCommand {
  command: string;
  success?: string;
  timeoutMs?: number;
}

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
      this.nightModeCommands(mutation),
    clock: (mutation) => this.timezoneCommands(mutation) ?? this.settingCommands(mutation),
    rotation: (mutation) => this.settingCommands(mutation),
    "keep-awake": (mutation) => this.settingCommands(mutation),
    "screen-reader": (mutation) => this.settingCommands(mutation),
    keyboard: (mutation) => this.settingCommands(mutation),
    clipboard: (mutation) => this.clipboardCommands(mutation),
    location: (mutation) => this.locationCommands(mutation),
    preference: (mutation) => this.appDataCommands(mutation),
    "shared-file": (mutation) => this.fileCommands(mutation),
  };

  constructor(private readonly adb: AdbCommandRunner) {}

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
  ): Promise<void> {
    await cleanAndroidBaseline(
      baseline,
      context,
      (command, timeoutMs) => this.execute(command, context, timeoutMs),
      (mutation) => this.revert(mutation, context),
    );
    const output = await this.execute("shell cmd clipboard clear", context, 2000, true);
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
    for (const { command, success, timeoutMs } of commands) {
      const output = await this.execute(command, context, timeoutMs, mutation.kind === "clipboard");
      if (mutation.kind === "clipboard" && this.unsupportedClipboard(output)) {
        logger.warn("Android cleaning skipped unsupported journal clipboard clear");
        continue;
      }
      if ((success !== undefined && output !== success) || this.failedOutput(output)) {
        throw new ActionableError("Android reset command failed to confirm success");
      }
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
    timeoutMs = 2000,
    optionalClipboard = false,
  ): Promise<string> {
    await context.assertOwned();
    context.signal.throwIfAborted();
    try {
      const result = await this.adb.executeCommand(command, {
        signal: context.signal,
        timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        noRetry: true,
        waitForProcessSettlementAfterAbort: true,
      });
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
      ? [{ command: `shell cmd alarm set-timezone ${shellQuote(prior)}` }]
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
            success: "Success",
          },
        ]
      : null;
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
