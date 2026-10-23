import { posix } from "node:path";
import { z } from "zod/v4";
import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { classifyCleanReleaseError } from "../cleanReleaseFailure";
import type { Timer } from "../../../utils/SystemTimer";
import type { SimCtl } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import type { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import {
  SIMCTL_PRIVACY_TCC_SERVICES,
  type TccServiceRowReader,
} from "../../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import type { UserTrustStoreReader } from "../../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { isProcessAlreadyGoneError } from "../../../utils/ios-cmdline-tools/iosProcessErrors";
import { getIosInstalledAppBundleId } from "../../../utils/ios-cmdline-tools/iosInstalledApp";
import { parsePlist } from "../../../utils/ios-cmdline-tools/XctestrunPlist";
import { looksLikeMissingIosDefault } from "../../../features/preferences/preferenceValues";
import type { DeviceMutationResetContext, DeviceMutationResetPort } from "./reset";
import { DEVICE_MUTATION_KINDS, type DeviceBaseline, type DeviceMutationInput } from "./types";
import type { BaselineChange } from "./baseline";
import { parseNotifyutilState } from "../../../utils/ios-cmdline-tools/notifyutil";
import { iosBiometricEnrollmentTarget, iosBiometricRevertArgs } from "./iosBiometricRevert";
import {
  IOS_ACCESSIBILITY_RESIDUE_DOMAIN,
  IOS_KEYBOARD_DEFAULTS_DOMAIN,
  type IosResidueInspector,
} from "../../../utils/ios-cmdline-tools/SimulatorResidueReader";
import {
  hasResidueBaseline,
  IOS_RESIDUE_KINDS,
  planResidueRevert,
  residueFromBaseline,
  residueIsClean,
  residueObservations,
} from "./iosResidue";

const IOS_SETTING_VALUE_SCHEMAS = {
  appearance: z.enum(["light", "dark"]),
  nightMode: z.enum(["light", "dark"]),
  "content-size": z.enum([
    "extra-small",
    "small",
    "medium",
    "large",
    "extra-large",
    "extra-extra-large",
    "extra-extra-extra-large",
    "accessibility-medium",
    "accessibility-large",
    "accessibility-extra-large",
    "accessibility-extra-extra-large",
    "accessibility-extra-extra-extra-large",
  ]),
  "increase-contrast": z.enum(["enabled", "disabled"]),
  // `com.apple.Accessibility` defaults, as the displayConfig prior read returns them.
  reduceMotion: z.enum(["0", "1"]),
  boldText: z.enum(["0", "1"]),
  locale: z.string().min(1),
  language: z.array(z.string().min(1)).min(1),
  calendarSystem: z.string().min(1),
  "force-24-hour-time": z.boolean(),
  "force-12-hour-time": z.boolean(),
} as const;

const globalsSchema = z.object({
  AppleLocale: IOS_SETTING_VALUE_SCHEMAS.locale.optional(),
  AppleLanguages: IOS_SETTING_VALUE_SCHEMAS.language.optional(),
  AppleCalendar: IOS_SETTING_VALUE_SCHEMAS.calendarSystem.optional(),
  AppleICUForce24HourTime: IOS_SETTING_VALUE_SCHEMAS["force-24-hour-time"].optional(),
  AppleICUForce12HourTime: IOS_SETTING_VALUE_SCHEMAS["force-12-hour-time"].optional(),
});

const IOS_GLOBAL_SETTING_KEYS = {
  locale: "AppleLocale",
  language: "AppleLanguages",
  calendarSystem: "AppleCalendar",
  "force-24-hour-time": "AppleICUForce24HourTime",
  "force-12-hour-time": "AppleICUForce12HourTime",
} as const;

export const IOS_UNOBSERVABLE_BASELINE_REASONS = {
  "app-group": "simctl lists app-owned group paths, not complete shared/orphan container contents.",
  "keep-awake": "simctl cannot inventory the simulator's effective idle-timer assertions.",
  rotation: "simctl has no complete orientation readback and restoration API.",
  "screen-reader": "simctl cannot read back effective VoiceOver state.",
  notification: "simctl cannot inventory or remove all delivered and pending notifications.",
  contact: "simctl cannot inventory and restore the complete Contacts store.",
  calendar: "simctl cannot inventory and restore the complete Calendar store.",
  clock: "simctl cannot observe all effective clock and automatic time-zone state.",
  "network-condition": "simctl cannot inventory effective simulator and host network shaping.",
  "biometric-enrollment": "simctl cannot read back complete biometric enrollment state.",
  profile: "simctl cannot inventory and restore all configuration profiles.",
  certificate: "simctl cannot inventory and restore complete certificate trust settings.",
  "opened-url": "simctl cannot inventory persistent effects of arbitrary URL handlers.",
  preference: "simctl cannot inventory every app's arbitrary preferences and live caches.",
  account: "simctl cannot inventory and restore all provider and system accounts.",
} as const;

/**
 * The journal records display settings under their displayConfig names; the baseline
 * observes the simctl-vocabulary ones. Both revert the same simulator setting.
 */
const IOS_JOURNAL_SETTING_ALIASES: Readonly<Record<string, string>> = {
  contentSize: "content-size",
  increaseContrast: "increase-contrast",
};

/** Accessibility defaults with no simctl subcommand, reverted through `defaults`. */
const IOS_ACCESSIBILITY_DEFAULT_KEYS = {
  reduceMotion: "ReduceMotionEnabled",
  boldText: "EnhancedTextLegibilityEnabled",
} as const;

function iosSettingKey(key: string): string {
  return Object.hasOwn(IOS_JOURNAL_SETTING_ALIASES, key) ? IOS_JOURNAL_SETTING_ALIASES[key]! : key;
}

function iosAccessibilityDefaultKey(key: string): string | undefined {
  return Object.entries(IOS_ACCESSIBILITY_DEFAULT_KEYS).find(([setting]) => setting === key)?.[1];
}

function accessibilityDefaultCommand(udid: string, key: string, prior: unknown): string[] {
  return [
    "spawn",
    udid,
    "defaults",
    prior === undefined ? "delete" : "write",
    "com.apple.Accessibility",
    key,
    ...(prior === undefined ? [] : ["-bool", prior === "1" ? "YES" : "NO"]),
  ];
}

function iosGlobalSettingKey(key: string): string | undefined {
  return Object.entries(IOS_GLOBAL_SETTING_KEYS).find(([setting]) => setting === key)?.[1];
}

async function iosGlobalSettingObservations(xml: string): Promise<DeviceBaseline["observations"]> {
  const plist = await parsePlist(xml);
  if (!(plist instanceof Map)) {
    throw new ActionableError("iOS global settings export is not a dictionary");
  }
  const globals = globalsSchema.parse(Object.fromEntries(plist));
  return Object.entries(IOS_GLOBAL_SETTING_KEYS).map(([key, preference]) => {
    const value = globals[preference];
    return {
      kind: "device-setting",
      key,
      value: value === undefined ? { state: "absent" } : { state: "present", value },
    };
  });
}

function canRestoreIosSetting(mutation: DeviceMutationInput): boolean {
  const prior = mutation.priorValue;
  if (prior.state !== "present") {
    // An absent Simulator accessibility default is off, and a restore deletes it again.
    return (
      prior.state === "absent" &&
      (iosGlobalSettingKey(mutation.key) !== undefined ||
        iosAccessibilityDefaultKey(mutation.key) !== undefined)
    );
  }
  const settingKey = iosSettingKey(mutation.key);
  const schema = Object.entries(IOS_SETTING_VALUE_SCHEMAS).find(([key]) => key === settingKey)?.[1];
  return schema?.safeParse(prior.value).success ?? false;
}

const RESET_DEFAULT_KINDS = [
  "keychain",
  "permission",
  "location",
  "status-bar",
  "clipboard",
] as const;

export interface IosResetFiles {
  realpath(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

export interface IosResetPasteboard {
  assertSettled(deviceId: string): void;
  write(deviceId: string, text: string, signal: AbortSignal): Promise<void>;
}

export interface IosMutationResetDependencies {
  simctl: Pick<SimCtl, "executeCommandArgs"> & Pick<SimCtlClient, "listAppsOrThrow">;
  files: IosResetFiles;
  pasteboard: IosResetPasteboard;
  privacyGrants: Pick<TccServiceRowReader, "readServiceRows">;
  trustStore: UserTrustStoreReader;
  residue: IosResidueInspector;
}

interface IosAppGroupCleanup {
  baselineIds: Set<string>;
  baselinePaths: Set<string>;
  removedPaths: Set<string>;
}

export class IosDeviceMutationResetPort implements DeviceMutationResetPort {
  constructor(
    private readonly dependencies: IosMutationResetDependencies,
    private readonly timer: Pick<Timer, "now">,
  ) {}

  canRevert(mutation: DeviceMutationInput): boolean {
    const prior = mutation.priorValue;
    if (prior.state === "unobservable") {
      return false;
    }
    if (
      ["installed-app", "app-group", "keychain", "permission", "location", "status-bar"].includes(
        mutation.kind,
      )
    ) {
      return prior.state === "absent";
    }
    switch (mutation.kind) {
      case "clipboard":
        return prior.state === "absent" || typeof prior.value === "string";
      case "device-setting":
        return canRestoreIosSetting(mutation);
      case "biometric-enrollment":
        return iosBiometricEnrollmentTarget(mutation) !== undefined;
      case "preference":
        return (
          mutation.key.split(":").length === 2 &&
          mutation.key.split(":").every(Boolean) &&
          (prior.state === "absent" || ["string", "boolean", "number"].includes(typeof prior.value))
        );
      default:
        return false;
    }
  }

  baselineRevert(change: BaselineChange): DeviceMutationInput | null {
    const mutation = {
      kind: change.kind,
      key: change.key,
      priorValue: change.priorValue,
      toolName: "baseline-diff",
    };
    return change.kind === "device-setting" && this.canRevert(mutation) ? mutation : null;
  }

  async assertSettled(context: DeviceMutationResetContext): Promise<void> {
    await context.assertOwned();
    this.dependencies.pasteboard.assertSettled(context.scope.deviceId);
  }

  async capture(context: DeviceMutationResetContext): Promise<DeviceBaseline> {
    try {
      return await this.captureObservable(context);
    } catch (error) {
      logger.warn(`iOS baseline inventory is unobservable: ${errorMessage(error)}`, error);
      context.signal.throwIfAborted();
      await context.assertOwned();
      if (classifyCleanReleaseError(error) === "retryable") {
        throw toActionableError(error, "iOS baseline inventory is temporarily unavailable");
      }
      throw toActionableError(error, "iOS baseline app inventory is unavailable");
    }
  }

  private async captureObservable(context: DeviceMutationResetContext): Promise<DeviceBaseline> {
    await this.assertSettled(context);
    await context.assertOwned();
    const apps = await this.dependencies.simctl.listAppsOrThrow(context.scope.deviceId, {
      signal: context.signal,
      timeoutMs: 10_000,
    });
    await context.assertOwned();
    const observations: DeviceBaseline["observations"] = apps.map((app) => {
      const key = getIosInstalledAppBundleId(app);
      if (!key) {
        throw new ActionableError("iOS baseline app inventory contains an unidentified bundle");
      }
      return {
        kind: "installed-app",
        key,
        value: { state: "present", value: z.json().parse(app) },
      };
    });
    const completeKinds = ["installed-app"];
    try {
      const settings = await this.captureSettings(context);
      observations.push(...settings);
      completeKinds.push("device-setting");
    } catch (error) {
      await this.inventoryFailure(error, context, "device-setting");
    }
    try {
      observations.push(
        ...residueObservations(
          await this.dependencies.residue.read(context.scope.deviceId, context.signal),
        ),
      );
      completeKinds.push(...IOS_RESIDUE_KINDS);
    } catch (error) {
      await this.inventoryFailure(error, context, "out-of-band residue");
    }
    return {
      observations,
      completeKinds,
      unobservable: DEVICE_MUTATION_KINDS.filter(
        (kind) => kind in IOS_UNOBSERVABLE_BASELINE_REASONS || !completeKinds.includes(kind),
      ),
    };
  }

  private async inventoryFailure(
    error: unknown,
    context: DeviceMutationResetContext,
    kind: string,
  ): Promise<void> {
    logger.warn(`iOS ${kind} inventory is unobservable: ${errorMessage(error)}`, error);
    context.signal.throwIfAborted();
    await context.assertOwned();
    if (classifyCleanReleaseError(error) === "retryable") {
      throw toActionableError(error, `iOS ${kind} inventory is temporarily unavailable`);
    }
  }

  private async captureSettings(
    context: DeviceMutationResetContext,
  ): Promise<DeviceBaseline["observations"]> {
    const udid = context.scope.deviceId;
    const appearance = IOS_SETTING_VALUE_SCHEMAS.appearance.parse(
      (await this.command(context, ["ui", udid, "appearance"])).stdout.trim(),
    );
    const contentSize = IOS_SETTING_VALUE_SCHEMAS["content-size"].parse(
      (await this.command(context, ["ui", udid, "content_size"])).stdout.trim(),
    );
    const contrast = IOS_SETTING_VALUE_SCHEMAS["increase-contrast"].parse(
      (await this.command(context, ["ui", udid, "increase_contrast"])).stdout.trim(),
    );
    const globals = await this.command(context, ["spawn", udid, "defaults", "export", "-g", "-"]);
    return [
      ...["appearance", "nightMode"].map((key) => ({
        kind: "device-setting",
        key,
        value: { state: "present" as const, value: appearance },
      })),
      {
        kind: "device-setting",
        key: "content-size",
        value: { state: "present", value: contentSize },
      },
      {
        kind: "device-setting",
        key: "increase-contrast",
        value: { state: "present", value: contrast },
      },
      ...(await iosGlobalSettingObservations(globals.stdout)),
    ];
  }

  async revert(mutation: DeviceMutationInput, context: DeviceMutationResetContext): Promise<void> {
    if (!this.canRevert(mutation)) {
      throw new ActionableError(`Unsupported iOS reset mutation ${mutation.kind}:${mutation.key}`);
    }
    const udid = context.scope.deviceId;
    const prior = mutation.priorValue.state === "present" ? mutation.priorValue.value : undefined;
    switch (mutation.kind) {
      case "installed-app":
        await this.terminate(mutation.key, context);
        await this.clearAppGroups(mutation.key, context);
        await this.command(context, ["uninstall", udid, mutation.key]);
        break;
      case "app-group":
        await this.terminate(mutation.key, context);
        await this.clearAppGroups(mutation.key, context);
        break;
      case "clipboard": {
        await context.assertOwned();
        const pasteboardStarted = this.timer.now();
        try {
          await this.dependencies.pasteboard.write(
            udid,
            typeof prior === "string" ? prior : "",
            context.signal,
          );
        } finally {
          context.recordPhase?.("simctl:pbcopy", this.timer.now() - pasteboardStarted);
        }
        await context.assertOwned();
        break;
      }
      case "biometric-enrollment":
        await this.revertBiometricEnrollment(mutation, context);
        break;
      default:
        await this.revertByCommand(mutation, context);
    }
  }

  private async revertByCommand(
    mutation: DeviceMutationInput,
    context: DeviceMutationResetContext,
  ): Promise<void> {
    const args = this.revertCommand(mutation, context.scope.deviceId);
    try {
      await this.command(context, args);
    } catch (error) {
      if (args[0] !== "spawn" || args[3] !== "delete" || !looksLikeMissingIosDefault(error)) {
        throw toActionableError(error, "iOS reset command failed");
      }
      // An absent preference already satisfies the requested deletion.
      logger.debug(`iOS reset preference already absent: ${errorMessage(error)}`);
      context.signal.throwIfAborted();
      await context.assertOwned();
    }
  }

  private async revertBiometricEnrollment(
    mutation: DeviceMutationInput,
    context: DeviceMutationResetContext,
  ): Promise<void> {
    const enrolled = iosBiometricEnrollmentTarget(mutation);
    if (enrolled === undefined) {
      throw new ActionableError("iOS cannot restore an unreadable biometric enrollment");
    }
    const result = await this.command(
      context,
      iosBiometricRevertArgs(context.scope.deviceId, enrolled),
    );
    if (parseNotifyutilState(result.stdout) !== enrolled) {
      throw new ActionableError("iOS biometric enrollment did not read back as restored");
    }
  }

  private revertCommand(mutation: DeviceMutationInput, udid: string): string[] {
    switch (mutation.kind) {
      case "keychain":
        return ["keychain", udid, "reset"];
      case "permission":
        return [
          "privacy",
          udid,
          "reset",
          "all",
          ...(mutation.key === "device" ? [] : [mutation.key]),
        ];
      case "location":
        return ["location", udid, "clear"];
      case "status-bar":
        return ["status_bar", udid, "clear"];
      case "device-setting":
        return this.settingCommand(mutation, udid);
      case "preference":
        return this.preferenceCommand(mutation, udid);
      default:
        throw new ActionableError(`Unsupported iOS reset command ${mutation.kind}`);
    }
  }

  private settingCommand(mutation: DeviceMutationInput, udid: string): string[] {
    const prior = mutation.priorValue.state === "present" ? mutation.priorValue.value : undefined;
    const settingKey = iosSettingKey(mutation.key);
    if (["appearance", "nightMode", "content-size", "increase-contrast"].includes(settingKey)) {
      return [
        "ui",
        udid,
        settingKey === "content-size"
          ? "content_size"
          : settingKey === "increase-contrast"
            ? "increase_contrast"
            : "appearance",
        String(prior),
      ];
    }
    const accessibilityKey = iosAccessibilityDefaultKey(mutation.key);
    if (accessibilityKey) {
      return accessibilityDefaultCommand(udid, accessibilityKey, prior);
    }
    const preference = iosGlobalSettingKey(mutation.key);
    if (!preference) {
      throw new ActionableError(`Unsupported iOS setting ${mutation.key}`);
    }
    return [
      "spawn",
      udid,
      "defaults",
      prior === undefined ? "delete" : "write",
      ".GlobalPreferences",
      preference,
      ...(prior === undefined
        ? []
        : Array.isArray(prior)
          ? ["-array", ...prior.map(String)]
          : typeof prior === "boolean"
            ? ["-bool", String(prior)]
            : ["-string", String(prior)]),
    ];
  }

  private preferenceCommand(mutation: DeviceMutationInput, udid: string): string[] {
    const prior = mutation.priorValue.state === "present" ? mutation.priorValue.value : undefined;
    const [domain, key] = mutation.key.split(":");
    return [
      "spawn",
      udid,
      "defaults",
      prior === undefined ? "delete" : "write",
      domain,
      key,
      ...(prior === undefined
        ? []
        : [
            typeof prior === "boolean"
              ? "-bool"
              : typeof prior === "number"
                ? Number.isInteger(prior)
                  ? "-int"
                  : "-float"
                : "-string",
            String(prior),
          ]),
    ];
  }

  async sanitize(context: DeviceMutationResetContext): Promise<void> {
    await context.assertOwned();
    if (!context.baseline?.completeKinds.includes("installed-app")) {
      throw new ActionableError("iOS reset requires a captured app baseline; erase required");
    }
    const started = this.timer.now();
    const apps = await this.dependencies.simctl
      .listAppsOrThrow(context.scope.deviceId, {
        signal: context.signal,
        timeoutMs: 10_000,
      })
      .finally(() => context.recordPhase?.("app-inventory", this.timer.now() - started));
    await context.assertOwned();
    const baselineApps = new Set(
      context.baseline?.observations
        .filter((entry) => entry.kind === "installed-app" && entry.value.state === "present")
        .map((entry) => entry.key),
    );
    const sessionApps = apps
      .filter((app) => app.ApplicationType === "User")
      .filter((app) => {
        const bundleId = getIosInstalledAppBundleId(app);
        if (!bundleId) {
          throw new ActionableError("iOS reset app inventory contains an unidentified bundle");
        }
        return !baselineApps.has(bundleId);
      });
    const cleanup = sessionApps.length > 0 ? await this.appGroupCleanup(context) : undefined;
    for (const app of sessionApps) {
      const bundleId = getIosInstalledAppBundleId(app)!;
      await this.terminate(bundleId, context);
      await this.clearAppGroups(bundleId, context, cleanup);
      await this.command(context, ["uninstall", context.scope.deviceId, bundleId]);
    }
    for (const kind of RESET_DEFAULT_KINDS) {
      await this.revert(
        { kind, key: "device", priorValue: { state: "absent" }, toolName: "baseline-reset" },
        context,
      );
    }
    await this.resetSurvivingPrivacyGrants(context);
    await this.assertNoUserTrustedCertificates(context);
    await this.restoreSettings(context);
    await this.sanitizeResidue(context);
  }

  /**
   * Photos, Documents and Safari files, keyboard defaults and the increase-contrast defaults are changed outside the tools the
   * journal records, and `simctl` cannot undo a photo. Compare them against the baseline: revert
   * what can be reverted, and refuse the keep-booted reset (so erase runs) for the rest, so a
   * `clean` receipt never hides leftover state.
   */
  private async sanitizeResidue(context: DeviceMutationResetContext): Promise<void> {
    await context.assertOwned();
    if (!hasResidueBaseline(context.baseline) || !context.baseline) {
      throw new ActionableError("iOS reset requires a residue baseline; erase required");
    }
    const baseline = residueFromBaseline(context.baseline);
    const read = async (phase: string) => {
      const started = this.timer.now();
      try {
        const snapshot = await this.dependencies.residue.read(
          context.scope.deviceId,
          context.signal,
        );
        await context.assertOwned();
        return snapshot;
      } finally {
        context.recordPhase?.(phase, this.timer.now() - started);
      }
    };
    const plan = planResidueRevert(baseline, await read("residue:inspect"));
    if (plan.unrevertible.length > 0) {
      throw new ActionableError(`${plan.unrevertible.join("; ")}; erase required`);
    }
    if (residueIsClean(plan)) {
      return;
    }
    for (const { area, names } of plan.removals) {
      await context.assertOwned();
      await this.dependencies.residue.removeEntries(
        context.scope.deviceId,
        area,
        names,
        context.signal,
      );
    }
    for (const [domain, changes] of [
      [IOS_KEYBOARD_DEFAULTS_DOMAIN, plan.keyboard],
      [IOS_ACCESSIBILITY_RESIDUE_DOMAIN, plan.accessibility],
    ] as const) {
      for (const { key, prior } of changes) {
        await this.revert(
          {
            kind: "preference",
            key: `${domain}:${key}`,
            priorValue:
              prior === undefined ? { state: "absent" } : { state: "present", value: prior },
            toolName: "baseline-reset",
          },
          context,
        );
      }
    }
    if (!residueIsClean(planResidueRevert(baseline, await read("residue:verify")))) {
      throw new ActionableError("iOS out-of-band residue survived reset; erase required");
    }
  }

  /**
   * `simctl keychain reset` leaves the user trust settings alone and nothing else here removes a
   * trusted root, so one that survives would let the next session's TLS traffic be intercepted.
   * Pool-entry simulators are created with no user-trusted roots, so any row means the session
   * added it: refuse the keep-booted reset so the erase fallback wipes it (#14828).
   */
  private async assertNoUserTrustedCertificates(
    context: DeviceMutationResetContext,
  ): Promise<void> {
    await context.assertOwned();
    context.signal.throwIfAborted();
    const started = this.timer.now();
    try {
      const certificates = await this.dependencies.trustStore.readUserTrustedCertificates(
        context.scope.deviceId,
        context.signal,
      );
      await context.assertOwned();
      context.signal.throwIfAborted();
      if (certificates.length > 0) {
        throw new ActionableError(
          `iOS reset cannot remove ${certificates.length} user-trusted root certificate(s); erase required`,
        );
      }
    } finally {
      context.recordPhase?.("trust-store:verify", this.timer.now() - started);
    }
  }

  private async resetSurvivingPrivacyGrants(context: DeviceMutationResetContext): Promise<void> {
    const udid = context.scope.deviceId;
    const readRows = async () => {
      await context.assertOwned();
      context.signal.throwIfAborted();
      const started = this.timer.now();
      try {
        return await this.dependencies.privacyGrants.readServiceRows(
          udid,
          SIMCTL_PRIVACY_TCC_SERVICES,
          context.signal,
        );
      } catch (error) {
        throw toActionableError(error, "iOS privacy grant verification failed");
      } finally {
        context.recordPhase?.("tcc:privacy-verify", this.timer.now() - started);
      }
    };
    const rows = await readRows();
    await context.assertOwned();
    context.signal.throwIfAborted();
    if (rows.length === 0) {
      return;
    }
    const clients = [...new Set(rows.map((row) => row.client))].sort();
    logger.warn(
      `iOS privacy grants survived global reset; resetting clients: ${clients.join(", ")}`,
    );
    for (const client of clients) {
      await this.command(context, ["privacy", udid, "reset", "all", client]);
    }
    const remaining = await readRows();
    await context.assertOwned();
    context.signal.throwIfAborted();
    if (remaining.length > 0) {
      throw new ActionableError(
        "iOS privacy grants survived reset: " +
          remaining.map((row) => `${row.service}:${row.client}`).join(", "),
      );
    }
  }

  private async restoreSettings(context: DeviceMutationResetContext): Promise<void> {
    const defaults: Record<string, DeviceMutationInput["priorValue"]> = {
      appearance: { state: "present", value: "light" },
      "content-size": { state: "present", value: "large" },
      "increase-contrast": { state: "present", value: "disabled" },
      ...Object.fromEntries(
        Object.keys(IOS_GLOBAL_SETTING_KEYS).map((key) => [key, { state: "absent" }]),
      ),
    };
    for (const [key, defaultValue] of Object.entries(defaults)) {
      const observation =
        context.baseline?.observations.find(
          (entry) => entry.kind === "device-setting" && entry.key === key,
        ) ??
        (key === "appearance"
          ? context.baseline?.observations.find(
              (entry) => entry.kind === "device-setting" && entry.key === "nightMode",
            )
          : undefined);
      const mutation = {
        kind: "device-setting",
        key,
        priorValue: observation?.value ?? defaultValue,
        toolName: "baseline-reset",
      };
      if (!this.canRevert(mutation)) {
        logger.warn(`iOS reset using simulator default for unsupported baseline setting ${key}`);
        mutation.priorValue = defaultValue;
      }
      await this.revert(mutation, context);
    }
  }

  private async command(context: DeviceMutationResetContext, args: string[]) {
    const started = this.timer.now();
    try {
      context.signal.throwIfAborted();
      await context.assertOwned();
      const result = await this.dependencies.simctl.executeCommandArgs(
        args,
        10_000,
        context.signal,
      );
      if (result.error) {
        throw new ActionableError(`iOS reset ${args[0]} failed: ${result.error}`);
      }
      await context.assertOwned();
      context.signal.throwIfAborted();
      return result;
    } finally {
      context.recordPhase?.(`simctl:${args[0]}`, this.timer.now() - started);
      context.recordPhase?.(
        `simctl:${args[0]}:${args.slice(2, args[0] === "spawn" ? 6 : 3).join(":")}`,
        this.timer.now() - started,
      );
    }
  }

  private async clearAppGroups(
    bundleId: string,
    context: DeviceMutationResetContext,
    cleanup?: IosAppGroupCleanup,
  ): Promise<void> {
    const groups = await this.appGroups(bundleId, context);
    if (Object.keys(groups).length === 0) {
      return;
    }
    const state = cleanup ?? (await this.appGroupCleanup(context));
    this.excludeSharedGroups(groups, state);
    for (const path of Object.values(groups)) {
      await context.assertOwned();
      if (state.removedPaths.has(path)) {
        continue;
      }
      // simctl runs only on macOS, so container paths are POSIX whatever host runs the daemon.
      const { isAbsolute, normalize, sep } = posix;
      const parent = `${sep}${context.scope.deviceId}${sep}data${sep}Containers${sep}Shared${sep}AppGroup${sep}`;
      if (
        !isAbsolute(path) ||
        normalize(path) !== path ||
        !path.includes(parent) ||
        path.slice(path.indexOf(parent) + parent.length).includes(sep) ||
        path.endsWith(sep) ||
        (await this.dependencies.files.realpath(path)) !== path
      ) {
        throw new ActionableError("iOS reset refused an unproven app-group container path");
      }
      await context.assertOwned();
      const started = this.timer.now();
      try {
        await this.dependencies.files.remove(path);
        state.removedPaths.add(path);
      } finally {
        context.recordPhase?.("app-group-remove", this.timer.now() - started);
      }
      await context.assertOwned();
    }
  }

  private async appGroupCleanup(context: DeviceMutationResetContext): Promise<IosAppGroupCleanup> {
    const cleanup: IosAppGroupCleanup = {
      baselineIds: new Set(),
      baselinePaths: new Set(),
      removedPaths: new Set(),
    };
    for (const app of context.baseline?.observations.filter(
      (entry) =>
        entry.kind === "installed-app" &&
        entry.value.state === "present" &&
        entry.value.value !== null &&
        typeof entry.value.value === "object" &&
        !Array.isArray(entry.value.value) &&
        entry.value.value.ApplicationType === "User",
    ) ?? []) {
      const baselineGroups = await this.appGroups(app.key, context);
      for (const [groupId, path] of Object.entries(baselineGroups)) {
        cleanup.baselineIds.add(groupId);
        cleanup.baselinePaths.add(path);
      }
    }
    return cleanup;
  }

  private excludeSharedGroups(groups: Record<string, string>, cleanup: IosAppGroupCleanup): void {
    for (const [groupId, path] of Object.entries(groups)) {
      if (
        groupId.startsWith("group.com.apple.") ||
        cleanup.baselineIds.has(groupId) ||
        cleanup.baselinePaths.has(path)
      ) {
        logger.warn(`iOS reset retained protected or baseline-shared app-group ${groupId}`);
        delete groups[groupId];
      }
    }
  }

  private async terminate(bundleId: string, context: DeviceMutationResetContext): Promise<void> {
    try {
      await this.command(context, ["terminate", context.scope.deviceId, bundleId]);
    } catch (error) {
      if (!isProcessAlreadyGoneError(errorMessage(error))) {
        throw toActionableError(error, "iOS reset could not terminate app");
      }
      // An already-exited process satisfies the termination postcondition.
      logger.debug(`iOS reset app already terminated: ${errorMessage(error)}`);
      await context.assertOwned();
    }
  }

  private async appGroups(
    bundleId: string,
    context: DeviceMutationResetContext,
  ): Promise<Record<string, string>> {
    const result = await this.command(context, [
      "get_app_container",
      context.scope.deviceId,
      bundleId,
      "groups",
    ]);
    const groups: Record<string, string> = {};
    for (const line of result.stdout.split("\n").filter((entry) => entry.trim() !== "")) {
      const fields = line.split("\t");
      if (fields.length !== 2 || !fields[0] || !fields[1] || Object.hasOwn(groups, fields[0])) {
        throw new ActionableError("iOS reset received invalid app-group inventory");
      }
      groups[fields[0]] = fields[1];
    }
    return groups;
  }
}
