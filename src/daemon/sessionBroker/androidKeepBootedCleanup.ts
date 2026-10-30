import { SCREEN_STATE_MUTATION_KEY } from "./mutations/screenStateMutation";
import { ActionableError } from "../../models/ActionableError";
import { isDeepStrictEqual } from "node:util";
import { parseAndroidRuntimePermissions } from "../../features/action/parseAndroidRuntimePermissions";
import { shellQuote } from "../../utils/shellQuote";
import { logger } from "../../utils/logger";
import { appContainerFileAppId } from "./mutations/appContainerFileKey";
import { baselineHoldsApp } from "./mutations/appInventory";
import { launchedAppId } from "./mutations/launchedApp";
import {
  ANDROID_BASELINE_FILE_ROOTS,
  ANDROID_DOWNLOAD_ENTRIES_KEY,
  ANDROID_USER_FILES_ROOT,
  androidAccountDigest,
  androidAccountKey,
  captureAndroidUsers,
  isAndroidResetFile,
  observeSettings,
  parseAndroidAccountDigests,
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
 * opened URLs (cleaning clears the preinstalled apps that can handle them), raw global/secure/system settings and verified display rows
 * (density, nightMode and display:*). Settings-backed adapter keys (fontScale, timeFormat,
 * textDirection and accessibility display fields) and per-app locales
 * require a journal revert because they are not raw
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

function baselineDownloadEntries(baseline: DeviceBaseline): ReadonlySet<string> | undefined {
  const observation = baseline.observations.find(
    (entry) => entry.kind === "shared-file" && entry.key === ANDROID_DOWNLOAD_ENTRIES_KEY,
  );
  if (observation?.value.state !== "present" || typeof observation.value.value !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(observation.value.value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? new Set(parsed)
      : undefined;
  } catch (error) {
    // An unreadable inventory proves nothing, so the namespace stays uncovered.
    logger.debug("Android baseline Downloads inventory is not JSON", error);
    return undefined;
  }
}

/** The baseline lists exactly user 0, so a `user_files` write without a userId landed there. */
function baselineHasOnlyUserZero(baseline: DeviceBaseline): boolean {
  const users = baseline.observations
    .filter(
      (entry) =>
        entry.kind === "installed-app" &&
        entry.key.startsWith("users:") &&
        entry.value.state === "present",
    )
    .map((entry) => entry.key);
  return users.length === 1 && users[0] === "users:0";
}

function parseUserFilesKey(
  entry: Pick<DeviceMutationInput, "kind" | "key">,
): { namespace: string; user: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.key);
  } catch (error) {
    // Raw paths and legacy keys are not user_files scopes; other coverage rules handle them.
    logger.debug("Android journal file key is not JSON; not a user_files scope", error);
    return undefined;
  }
  const length = entry.kind === "media" ? 5 : entry.kind === "shared-file" ? 6 : -1;
  return Array.isArray(parsed) &&
    parsed.length === length &&
    parsed[0] === "user_files" &&
    parsed[1] === null &&
    parsed[2] === null &&
    typeof parsed[3] === "string" &&
    (length === 5 || typeof parsed[5] === "string")
    ? { namespace: parsed[3], user: parsed[4] }
    : undefined;
}

/** The user-0 directory a namespace stages into, trimmed as staging does; undefined if unsafe. */
function userFilesDirectory(raw: string): string | undefined {
  const namespace = raw.trim();
  const directory = `${ANDROID_USER_FILES_ROOT}/${namespace}`;
  return namespace.length > 0 && !/[/\\]/.test(namespace) && isAndroidResetFile(directory)
    ? directory
    : undefined;
}

/**
 * The `/sdcard/Download/<namespace>` directory of a `putAppFile` `user_files` row (`shared-file`
 * write or namespace reset, or its `indexMedia` `media` row) that baseline cleaning provably
 * restores, or undefined. Coverage needs user 0 (`"default"` resolves to the current user, so it
 * counts only when the baseline lists user 0 alone) and a readable Downloads entry inventory that
 * lacks the namespace path: the session could then neither overwrite nor delete a baseline file
 * there, the file sweep deletes everything under it (each deletion is media-rescanned), and
 * cleaning removes the then-empty namespace directory tree.
 */
export function androidUserFilesNamespaceCovered(
  entry: Pick<DeviceMutationInput, "kind" | "key">,
  baseline: DeviceBaseline | null | undefined,
): string | undefined {
  const scope = baseline ? parseUserFilesKey(entry) : undefined;
  if (!baseline || !scope) {
    return undefined;
  }
  const directory = userFilesDirectory(scope.namespace);
  const entries = baselineDownloadEntries(baseline);
  return (scope.user === 0 || (scope.user === "default" && baselineHasOnlyUserZero(baseline))) &&
    directory !== undefined &&
    entries !== undefined &&
    !entries.has(directory) &&
    !baseline.observations.some(
      (observation) =>
        observation.kind === "shared-file" && observation.key.startsWith(`${directory}/`),
    )
    ? directory
    : undefined;
}

/**
 * Journal file rows baseline cleaning restores without a journal revert: app-container writes
 * into apps absent from the baseline inventory (cleaning uninstalls them with their data) and
 * covered `user_files` namespaces.
 */
export function androidBaselineFileCovers(
  entry: Pick<DeviceMutationInput, "kind" | "key">,
  baseline: DeviceBaseline | null | undefined,
): boolean {
  if (!baseline || (entry.kind !== "shared-file" && entry.kind !== "media")) {
    return false;
  }
  const appId = entry.kind === "shared-file" ? appContainerFileAppId(entry.key) : undefined;
  return appId !== undefined
    ? !baselineHoldsApp(baseline, appId)
    : androidUserFilesNamespaceCovered(entry, baseline) !== undefined;
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

const ANDROID_PACKAGE_NAME = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

/**
 * Preinstalled packages cleaning refuses to `pm clear`; a session that launched one, or opened a
 * URL one can handle, escalates to the baseline fallback instead. Their data is device-wide
 * rather than app-private (the framework, SystemUI, content providers holding contacts, media,
 * downloads and the settings database, telephony, Bluetooth, NFC), account state (Google Play
 * services and framework, Play Store), install and permission UI the platform depends on, the
 * home screen layout (launchers) or the input method the automation types through; clearing them
 * can break the device or the automation stack. AutoMobile's own packages are listed too.
 * Each entry matches the package and its `.`-separated sub-packages.
 */
export const ANDROID_UNCLEARABLE_PACKAGES = [
  "android",
  "com.android.bluetooth",
  "com.android.externalstorage",
  "com.android.inputmethod",
  "com.android.keychain",
  "com.android.launcher3",
  "com.android.location.fused",
  "com.android.networkstack",
  "com.android.nfc",
  "com.android.packageinstaller",
  "com.android.permissioncontroller",
  "com.android.phone",
  "com.android.providers",
  "com.android.se",
  "com.android.server.telecom",
  "com.android.shell",
  "com.android.systemui",
  "com.android.vending",
  "com.google.android.apps.nexuslauncher",
  "com.google.android.ext.services",
  "com.google.android.gms",
  "com.google.android.gsf",
  "com.google.android.inputmethod",
  "com.google.android.networkstack",
  "com.google.android.packageinstaller",
  "com.google.android.permissioncontroller",
  "dev.jasonpearson.automobile",
] as const;

export function isAndroidUnclearablePackage(packageName: string): boolean {
  return ANDROID_UNCLEARABLE_PACKAGES.some(
    (entry) => packageName === entry || packageName.startsWith(`${entry}.`),
  );
}

/** Whether the baseline holds `packageName` for `user` as a preinstalled (non `-3`) package. */
function baselinePreinstalled(
  prior: ReadonlyMap<string, MutationValue>,
  user: number,
  packageName: string,
): boolean {
  return (
    prior.get(`installed-app:user:${user}:${packageName}`)?.state === "present" &&
    !prior.has(`installed-app:identity:${packageName}`)
  );
}

/** Packages `cmd package query-activities --components` lists; malformed output throws. */
export function parseQueryActivitiesComponents(output: string): string[] {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 1 && lines[0] === "No activities found") {
    return [];
  }
  if (lines.length === 0) {
    throw new ActionableError("Android cleaning read an empty URL handler inventory");
  }
  return lines.map((line) => {
    const match = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\/[A-Za-z0-9_.$]+$/.exec(line);
    if (!match?.[1]) {
      throw new ActionableError("Android cleaning cannot read the URL handler inventory");
    }
    return match[1];
  });
}

export async function cleanAndroidBaseline(
  baseline: DeviceBaseline,
  context: DeviceMutationResetContext,
  command: AndroidBaselineCommand,
  revert: (mutation: DeviceMutationInput) => Promise<void>,
  journalEntries: readonly DeviceMutationEntry[] = [],
): Promise<void> {
  const namespaces = new Set(
    journalEntries.flatMap((entry) => androidUserFilesNamespaceCovered(entry, baseline) ?? []),
  );
  await new AndroidBaselineCleaner(baseline, context, command, revert, {
    sessionCreated: sessionCreatedSettingMatcher(journalEntries),
    userFilesNamespaces: [...namespaces].sort(),
    launches: journaledAppLaunches(journalEntries),
  }).clean();
}

/** What the session journal tells cleaning beyond the baseline. */
interface AndroidCleaningJournalFacts {
  sessionCreated: (key: string) => boolean;
  userFilesNamespaces: readonly string[];
  launches: AndroidAppLaunches;
}

interface AndroidAppLaunches {
  /** Apps a launch row or a `package:` URL names. */
  packages: ReadonlySet<string>;
  /** Other opened URLs, whose handling app was not journaled. */
  urls: ReadonlySet<string>;
}

/** The apps and URLs the session journaled starting; a malformed launch row throws. */
export function journaledAppLaunches(
  entries: readonly Pick<DeviceMutationEntry, "kind" | "key">[],
): AndroidAppLaunches {
  const packages = new Set<string>();
  const urls = new Set<string>();
  for (const entry of entries) {
    const appId = launchedAppId(entry);
    if (appId === null) {
      throw new ActionableError("Android cleaning cannot read a journaled app launch");
    }
    const url = entry.kind === "opened-url" ? entry.key.trim() : "";
    if (appId !== undefined) {
      packages.add(appId);
    } else if (url.startsWith("package:")) {
      packages.add(url.slice("package:".length));
    } else if (url) {
      urls.add(url);
    }
  }
  return { packages, urls };
}

class AndroidBaselineCleaner {
  private readonly prior: ReadonlyMap<string, MutationValue>;

  constructor(
    private readonly baseline: DeviceBaseline,
    private readonly context: DeviceMutationResetContext,
    private readonly command: AndroidBaselineCommand,
    private readonly revert: (mutation: DeviceMutationInput) => Promise<void>,
    private readonly journal: AndroidCleaningJournalFacts,
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
    const started = await this.sessionStartedPreinstalledApps(users);
    await this.cleanPackages(users);
    for (const [user, packageName] of started) {
      // Force-stops the app, then `pm clear --user`, confirmed by its `Success` reply.
      await this.restore("preference", `app-data:${user}:${packageName}`, { state: "absent" });
    }
    await this.cleanDisplay();
    for (const namespace of ["global", "system", "secure"]) {
      for (const user of namespace === "global" ? [0] : users) {
        await this.cleanSettings(namespace, user);
      }
    }
    await this.cleanFiles();
    for (const directory of this.journal.userFilesNamespaces) {
      await this.removeNamespaceDirectory(directory);
    }
    await this.cleanTimezone();
    await this.verifyLocale();
    await this.verifyAccounts(users);
  }

  private baselineString(kind: string, key: string): string | undefined {
    const value = this.prior.get(`${kind}:${key}`);
    return value?.state === "present" && typeof value.value === "string" ? value.value : undefined;
  }

  /**
   * Puts back the baseline `persist.sys.timezone` with the `clock:timezone` revert (`cmd alarm
   * set-timezone`, read back) when the zone changed outside the journal. A baseline without a
   * zone cannot be restored, so a changed zone then fails cleaning.
   */
  private async cleanTimezone(): Promise<void> {
    const prior = this.baselineString("clock", "timezone");
    if ((await this.command("shell getprop persist.sys.timezone")) === prior) {
      return;
    }
    if (!prior) {
      throw new ActionableError("Android cleaning cannot restore a time zone the baseline lacks");
    }
    await this.restore("clock", "timezone", { state: "present", value: prior });
  }

  /**
   * The device-wide locale has no in-place restore (a raw `system_locales` row does not apply
   * it), so a `persist.sys.locale` that differs from the baseline fails cleaning.
   */
  private async verifyLocale(): Promise<void> {
    const prior = this.baselineString("device-setting", "locale");
    if (prior === undefined || (await this.command("shell getprop persist.sys.locale")) !== prior) {
      throw new ActionableError("Android cleaning found a changed device locale");
    }
  }

  /**
   * AccountManager accounts can be neither removed nor added back from an unrooted shell, so a
   * user whose account set differs from the baseline fails cleaning. This runs after package
   * cleaning: uninstalling a session-installed authenticator drops that app's accounts. A user
   * the baseline did not list compares against an empty set; an unreadable list fails cleaning.
   */
  private async verifyAccounts(users: readonly number[]): Promise<void> {
    const baselineUsers = this.baseline.observations
      .filter((observation) => observation.kind === "account" && /^user:\d+$/.test(observation.key))
      .map((observation) => Number(observation.key.slice("user:".length)));
    if (baselineUsers.length === 0) {
      throw new ActionableError("Android baseline has no per-user account inventory");
    }
    const current = parseAndroidAccountDigests(await this.command("shell dumpsys account"), users);
    const empty = androidAccountDigest([]);
    const changed = [...new Set([...baselineUsers, ...users])]
      .sort((left, right) => left - right)
      .filter(
        (user) =>
          (this.baselineString("account", androidAccountKey(user)) ?? empty) !==
          (current.get(user) ?? empty),
      );
    if (changed.length > 0) {
      throw new ActionableError(
        `Android cleaning found changed accounts for user ${changed.join(", ")}; accounts cannot be restored in place`,
      );
    }
  }

  /**
   * Preinstalled apps (baseline-held, outside the `-3` inventory, so the package clean never
   * touches their data) the session started, as `[user, package]` pairs: apps a journaled launch
   * row names, the `package:` target of an opened URL, and every activity that can handle any
   * other opened URL (a browser holding cookies or a signed-in web session). The handler that
   * actually opened a URL is not journaled, so every candidate counts. Throws before cleaning
   * mutates anything when a candidate is unclearable.
   */
  private async sessionStartedPreinstalledApps(
    users: readonly number[],
  ): Promise<[number, string][]> {
    const started: [number, string][] = [];
    for (const user of users) {
      const candidates = new Set(this.journal.launches.packages);
      for (const url of this.journal.launches.urls) {
        const output = await this.command(
          `shell cmd package query-activities --components --user ${user} -a android.intent.action.VIEW -d ${shellQuote(url)}`,
        );
        for (const handler of parseQueryActivitiesComponents(output)) {
          candidates.add(handler);
        }
      }
      // Session-installed apps are uninstalled with their data; only preinstalled ones remain.
      const preinstalled = [...candidates]
        .filter(
          (name) => ANDROID_PACKAGE_NAME.test(name) && baselinePreinstalled(this.prior, user, name),
        )
        .sort();
      const unclearable = preinstalled.find(isAndroidUnclearablePackage);
      if (unclearable) {
        throw new ActionableError(
          `Android cleaning cannot clear data of core package ${unclearable} the session started`,
        );
      }
      started.push(...preinstalled.map((name): [number, string] => [user, name]));
    }
    return started;
  }

  /**
   * The file sweep leaves the directories of a covered `user_files` namespace behind; the namespace
   * path was absent from the baseline, so its now file-free tree is removed. `rmdir` refuses
   * anything the sweep did not delete (symlinks, special files), failing cleaning closed.
   */
  private async removeNamespaceDirectory(directory: string): Promise<void> {
    const path = shellQuote(directory);
    const resolved = shellQuote(directory.slice("/sdcard".length));
    const script = `root=$(readlink -f /sdcard) && [ -n "$root" ] && if [ -e ${path} ] || [ -L ${path} ]; then [ ! -L ${path} ] && [ -d ${path} ] && [ "$(readlink -f ${path})" = "$root"${resolved} ] && find ${path} -depth -type d -exec rmdir {} +; fi && [ ! -e ${path} ] && [ ! -L ${path} ]`;
    await this.command(`shell sh -c ${shellQuote(script)}`);
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
      if (!baselineValue && !this.journal.sessionCreated(key)) {
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
