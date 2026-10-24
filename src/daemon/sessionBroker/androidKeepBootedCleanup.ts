import { SCREEN_STATE_MUTATION_KEY } from "./mutations/screenStateMutation";
import { ActionableError } from "../../models/ActionableError";
import { isDeepStrictEqual } from "node:util";
import { parseAndroidRuntimePermissions } from "../../features/action/parseAndroidRuntimePermissions";
import { shellQuote } from "../../utils/shellQuote";
import { logger } from "../../utils/logger";
import {
  ANDROID_BASELINE_FILE_ROOTS,
  captureAndroidUsers,
  isAndroidResetFile,
  observeSettings,
  parseAndroidBaselinePackages,
  parseDisplayOverride,
  parseNightMode,
  type AndroidBaselineCommand,
} from "./androidMutationBaseline";
import type { DeviceMutationResetContext } from "./mutations/reset";
import type {
  DeviceBaseline,
  DeviceMutationEntry,
  DeviceMutationInput,
  MutationValue,
} from "./mutations/types";

export function isAndroidCriticalSetting(key: string): boolean {
  return /^(?:global|secure):(?:user:\d+:)?(?:adb_enabled|adb_wifi_enabled|development_settings_enabled|airplane_mode_on|wifi_on|mobile_data|enabled_accessibility_services|accessibility_enabled)$/.test(
    key,
  );
}

/**
 * Baseline cleaning covers installed apps, clipboard, rotation, screen-reader, keep-awake,
 * transient opened URLs, raw global/secure/system settings and verified display rows
 * (density, nightMode and display:*). Settings-backed adapter keys (fontScale, timeFormat
 * and accessibility display fields) require a journal revert because they are not raw
 * settings rows. Failed raw settings restores are re-read against the baseline.
 * Screen state is restored by wakeAndUnlock.
 * App-owned interaction breadcrumbs are exempted separately from store preferences.
 * Production file intents use JSON keys and require a revert; CtrlProxy keyboard profiles
 * are not settings rows. Power controls also require their verified journal revert.
 */
export function androidBaselineCleanCovers(
  entry: Pick<DeviceMutationInput, "kind" | "key" | "priorValue">,
): boolean {
  if (
    [
      "installed-app",
      "clipboard",
      "rotation",
      "screen-reader",
      "keep-awake",
      "opened-url",
    ].includes(entry.kind)
  ) {
    return true;
  }
  const settingsKey = /^(?:global|secure|system):/.test(entry.key);
  return (
    entry.kind === "device-setting" &&
    (settingsKey ||
      entry.key.startsWith("display:") ||
      entry.key === SCREEN_STATE_MUTATION_KEY ||
      ["density", "nightMode"].includes(entry.key))
  );
}

/**
 * Settings the session's own tools write under a journal row whose key is not a raw settings key
 * (rotation, TalkBack and keep-awake journal `device`). `androidBaselineCleanCovers` leaves these
 * kinds to the baseline clean, so the clean may delete them when the baseline lacks them.
 */
const TOOL_OWNED_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  rotation: ["system:accelerometer_rotation", "system:user_rotation"],
  "screen-reader": ["secure:enabled_accessibility_services", "secure:accessibility_enabled"],
  "keep-awake": ["global:stay_on_while_plugged_in", "system:screen_off_timeout"],
};

/**
 * Whether the session journal shows the session created a settings key (`namespace:key`,
 * `namespace:user:N:key`): a `device-setting` row on that raw key whose prior value was absent, or
 * a key owned by a tool whose journal row covers it. The Android system creates and maintains
 * settings of its own after the baseline is captured (ringtone and alarm URIs,
 * `systemui.google.opa_enabled`, Phenotype flags, ...), so a key missing from the baseline is not
 * evidence that the session added it (#15178); only these keys may be deleted by cleaning.
 */
export function sessionCreatedSettingMatcher(
  entries: readonly Pick<DeviceMutationEntry, "kind" | "key" | "priorValue">[],
): (key: string) => boolean {
  const rawKeys = new Set(
    entries
      .filter(
        (entry) =>
          entry.kind === "device-setting" &&
          entry.priorValue.state === "absent" &&
          /^(?:global|system|secure):/.test(entry.key),
      )
      .map((entry) => entry.key),
  );
  const owned = new Set(
    entries.flatMap((entry) => (entry.kind in TOOL_OWNED_SETTINGS ? [entry.kind] : [])),
  );
  const ownedKeys = new Set([...owned].flatMap((kind) => TOOL_OWNED_SETTINGS[kind] ?? []));
  return (key) => rawKeys.has(key) || ownedKeys.has(key.replace(/^(\w+):user:\d+:/, "$1:"));
}

export async function cleanAndroidBaseline(
  baseline: DeviceBaseline,
  context: DeviceMutationResetContext,
  command: AndroidBaselineCommand,
  revert: (mutation: DeviceMutationInput) => Promise<void>,
  journalEntries: readonly DeviceMutationEntry[] = [],
): Promise<void> {
  await new AndroidBaselineCleaner(
    baseline,
    context,
    command,
    revert,
    sessionCreatedSettingMatcher(journalEntries),
  ).clean();
}

class AndroidBaselineCleaner {
  private readonly prior: ReadonlyMap<string, MutationValue>;

  constructor(
    private readonly baseline: DeviceBaseline,
    private readonly context: DeviceMutationResetContext,
    private readonly command: AndroidBaselineCommand,
    private readonly revert: (mutation: DeviceMutationInput) => Promise<void>,
    private readonly sessionCreated: (key: string) => boolean,
  ) {
    this.prior = new Map(
      baseline.observations.map((observation) => [
        `${observation.kind}:${observation.key}`,
        observation.value,
      ]),
    );
  }

  private restore(kind: string, key: string, priorValue: MutationValue): Promise<void> {
    return this.revert({ kind, key, priorValue, toolName: "keep-booted-cleaning" });
  }

  async clean(): Promise<void> {
    const users = await captureAndroidUsers(this.command);
    await this.cleanPackages(users);
    await this.cleanDisplay();
    for (const namespace of ["global", "system", "secure"]) {
      for (const user of namespace === "global" ? [0] : users) {
        await this.cleanSettings(namespace, user);
      }
    }
    await this.cleanFiles();
  }

  private async readDisplay(): Promise<ReadonlyMap<string, MutationValue>> {
    const density = parseDisplayOverride(await this.command("shell wm density"), "density");
    const size = parseDisplayOverride(await this.command("shell wm size"), "size");
    const night = parseNightMode(await this.command("shell cmd uimode night"));
    return new Map<string, MutationValue>([
      [
        "display:density",
        density === null ? { state: "absent" } : { state: "present", value: density },
      ],
      ["display:size", size === null ? { state: "absent" } : { state: "present", value: size }],
      ["display:night-mode", { state: "present", value: night }],
    ]);
  }

  private async cleanDisplay(): Promise<void> {
    const current = await this.readDisplay();
    // Display commands rewrite settings rows, which the subsequent settings pass restores.
    for (const [key, value] of current) {
      const prior = this.prior.get(`device-setting:${key}`);
      if (prior && !isDeepStrictEqual(value, prior)) {
        await this.restore("device-setting", key, prior);
      }
    }
    const mismatches = [...(await this.readDisplay())]
      .filter(([key, value]) => {
        const prior = this.prior.get(`device-setting:${key}`);
        return prior && !isDeepStrictEqual(value, prior);
      })
      .map(([key]) => key);
    if (mismatches.length > 0) {
      throw new ActionableError(
        `Android cleaning did not restore live display state: ${mismatches.join(", ")}`,
      );
    }
  }

  private async cleanPackages(users: readonly number[]): Promise<void> {
    for (const user of users) {
      const packages = parseAndroidBaselinePackages(
        await this.command(`shell pm list packages -3 --user ${user}`),
      );
      for (const packageName of packages) {
        await this.cleanPackage(user, packageName);
      }
    }
  }

  private async cleanPackage(user: number, packageName: string): Promise<void> {
    const key = `user:${user}:${packageName}`;
    if (this.prior.get(`installed-app:${key}`)?.state !== "present") {
      await this.restore("installed-app", key, { state: "absent" });
      return;
    }
    const dump = await this.command(`shell dumpsys package ${shellQuote(packageName)}`);
    const permissions = parseAndroidRuntimePermissions(dump, packageName, user);
    if (!permissions) {
      throw new ActionableError(`Android cleaning cannot read runtime permissions for ${key}`);
    }
    for (const [permission, state] of permissions.runtimePermissions) {
      const permissionKey = `runtime:${user}:${packageName}:${permission}`;
      const baselineGrant = this.prior.get(`permission:${permissionKey}`);
      if (
        state.state === "granted" &&
        !(baselineGrant?.state === "present" && baselineGrant.value === true)
      ) {
        await this.restore("permission", permissionKey, { state: "present", value: false });
      }
    }
  }

  private async readSettings(namespace: string, user: number): Promise<Map<string, MutationValue>> {
    const current = new Map<string, MutationValue>();
    observeSettings(
      await this.command(`shell settings --user ${user} list ${namespace}`),
      namespace,
      user,
      (_kind, key, value) => {
        current.set(key, value === null ? { state: "absent" } : { state: "present", value });
      },
    );
    return current;
  }

  private async cleanSettings(namespace: string, user: number): Promise<void> {
    const current = await this.readSettings(namespace, user);
    const failed = new Map<string, MutationValue>();
    const prefix = user === 0 ? `${namespace}:` : `${namespace}:user:${user}:`;
    const baselineSettings = this.baseline.observations.filter(
      (observation) =>
        observation.kind === "device-setting" &&
        observation.key.startsWith(prefix) &&
        (user !== 0 || !observation.key.startsWith(`${namespace}:user:`)),
    );
    let preserved = 0;
    for (const key of new Set([...current.keys(), ...baselineSettings.map((entry) => entry.key)])) {
      const baselineValue = this.prior.get(`device-setting:${key}`);
      const previous = baselineValue ?? { state: "absent" };
      if (isDeepStrictEqual(current.get(key) ?? { state: "absent" }, previous)) {
        continue;
      }
      if (!baselineValue && !this.sessionCreated(key)) {
        // Absent from the baseline and not journaled as created: the system added it, so
        // deleting it would destroy device state the session start already had (#15178).
        preserved++;
        continue;
      }
      try {
        await this.restore("device-setting", key, previous);
      } catch (error) {
        logger.warn(`Android cleaning could not restore setting ${key}`, error);
        await this.context.assertOwned();
        this.context.signal.throwIfAborted();
        failed.set(key, previous);
        if (isAndroidCriticalSetting(key)) {
          throw error;
        }
      }
    }
    if (failed.size > 0) {
      const live = await this.readSettings(namespace, user);
      const dirty = [...failed]
        .filter(
          ([key, previous]) => !isDeepStrictEqual(live.get(key) ?? { state: "absent" }, previous),
        )
        .map(([key]) => key);
      if (dirty.length > 0) {
        throw new ActionableError(
          `Android cleaning settings remain dirty after failed restore: ${dirty.join(", ")}`,
        );
      }
    }
  }

  private async cleanFiles(): Promise<void> {
    for (const root of ANDROID_BASELINE_FILE_ROOTS) {
      const script = `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -type f -print; elif [ -e ${shellQuote(root)} ]; then exit 1; fi`;
      const paths = (await this.command(`shell sh -c ${shellQuote(script)}`))
        .split("\n")
        .filter(Boolean);
      for (const path of paths) {
        if (!path.startsWith(`${root}/`) || !isAndroidResetFile(path)) {
          throw new ActionableError("Android cleaning shared-file inventory is malformed");
        }
        if (this.prior.get(`shared-file:${path}`)?.state !== "present") {
          await this.restore("shared-file", path, { state: "absent" });
        }
      }
    }
  }
}
