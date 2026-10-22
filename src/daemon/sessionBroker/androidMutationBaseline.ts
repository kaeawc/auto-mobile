import { ActionableError } from "../../models/ActionableError";
import { createHash } from "node:crypto";
import { shellQuote } from "../../utils/shellQuote";
import { parseAndroidRuntimePermissions } from "../../features/action/parseAndroidRuntimePermissions";
import { parsePmListUsers } from "../../utils/android-cmdline-tools/parseAndroidUsers";
import {
  DEVICE_MUTATION_KINDS,
  type DeviceBaseline,
  type DeviceStateObservation,
} from "./mutations/types";

export type AndroidBaselineCommand = (command: string, timeoutMs?: number) => Promise<string>;
type AndroidObservationSink = (kind: string, key: string, value: string | boolean | null) => void;

export const ANDROID_CERTIFIABLE_KINDS = ["device-setting", "account"] as const;

export const ANDROID_UNOBSERVABLE_REASONS: Readonly<Record<string, string>> = {
  "installed-app":
    "Package membership is observed for all users; package identities are captured only for third-party apps, not system app updates",
  permission:
    "Runtime grants and flags are observed for third-party packages and users; system grants, AppOps and other permission stores are not fully inventoried",
  "shared-file":
    "Public roots are hashed; other roots, directories, symlinks and secondary-user storage are not fully observed or restorable",
  clock: "Timezone is observed; wall clock and alarm state are not fully observable",
};

const ANDROID_SETTINGS_NAMESPACES = ["global", "secure", "system"] as const;

export const ANDROID_BASELINE_FILE_ROOTS = [
  "/sdcard/Download",
  "/sdcard/DCIM",
  "/sdcard/Pictures",
  "/sdcard/Movies",
  "/sdcard/Documents",
] as const;

export function isAndroidResetFile(path: string): boolean {
  return (
    path.startsWith("/sdcard/") &&
    !path
      .split("/")
      .slice(1)
      .some((part) => part === "." || part === ".." || part === "") &&
    !/[\x00-\x1f\x7f\\]/.test(path)
  );
}

export async function captureAndroidMutationBaseline(
  command: AndroidBaselineCommand,
): Promise<DeviceBaseline> {
  const observations: DeviceStateObservation[] = [];
  const observe = (kind: string, key: string, value: string | boolean | null) => {
    observations.push({
      kind,
      key,
      value: value === null ? { state: "absent" } : { state: "present", value },
    });
  };
  const users = await captureAndroidUsers(command);
  await captureAndroidPackages(command, observe, users);
  await captureSettings(command, observe, users);
  await captureDisplay(command, observe);
  observe("device-setting", "locale", await command("shell getprop persist.sys.locale"));
  observe("clock", "timezone", await command("shell getprop persist.sys.timezone"));
  const accounts = await command("shell dumpsys account");
  if (
    users.some(
      (user) =>
        !new RegExp(`^User UserInfo\\{${user}:[^\\n]+\\}:\\s*\\n\\s*Accounts: \\d+\\s*$`, "m").test(
          accounts,
        ),
    )
  ) {
    throw new ActionableError("Android baseline account inventory is unreadable");
  }
  observe("account", "inventory", createHash("sha256").update(accounts).digest("hex"));
  await captureFiles(command, observe);
  const unobservable = DEVICE_MUTATION_KINDS.filter(
    (kind) => !ANDROID_CERTIFIABLE_KINDS.some((complete) => complete === kind),
  );
  return {
    completeKinds: [...ANDROID_CERTIFIABLE_KINDS],
    observations,
    unobservable,
    unobservableReasons: Object.fromEntries(
      unobservable.map((kind) => [
        kind,
        ANDROID_UNOBSERVABLE_REASONS[kind] ??
          "No complete Android observation and restoration contract is available",
      ]),
    ),
  };
}

async function captureSettings(
  command: AndroidBaselineCommand,
  observe: AndroidObservationSink,
  users: readonly number[],
): Promise<void> {
  for (const namespace of ANDROID_SETTINGS_NAMESPACES) {
    for (const user of namespace === "global" ? [0] : users) {
      const output = await command(`shell settings --user ${user} list ${namespace}`);
      observeSettings(output, namespace, user, observe);
    }
  }
}

export function observeSettings(
  output: string,
  namespace: string,
  user: number,
  observe: AndroidObservationSink,
): void {
  const keys = new Set<string>();
  for (const line of output.split("\n").filter(Boolean)) {
    // The settings provider stores any key (stock images write `dropbox:data_app_anr`), so
    // split on the first `=` rather than whitelisting key characters.
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z0-9_]\S*$/.test(key) || keys.has(key)) {
      throw new ActionableError(`Android baseline ${namespace} settings inventory is malformed`);
    }
    keys.add(key);
    observe(
      "device-setting",
      user === 0 ? `${namespace}:${key}` : `${namespace}:user:${user}:${key}`,
      line.slice(separator + 1),
    );
  }
}

async function captureDisplay(
  command: AndroidBaselineCommand,
  observe: AndroidObservationSink,
): Promise<void> {
  observe(
    "device-setting",
    "display:density",
    parseDisplayOverride(await command("shell wm density"), "density"),
  );
  observe(
    "device-setting",
    "display:size",
    parseDisplayOverride(await command("shell wm size"), "size"),
  );
  const nightMode = await command("shell cmd uimode night");
  const night = /^Night mode: (yes|no|auto|custom)$/.exec(nightMode);
  if (!night?.[1]) {
    throw new ActionableError("Android baseline night mode is unreadable");
  }
  observe("device-setting", "display:night-mode", night[1]);
}

async function captureFiles(
  command: AndroidBaselineCommand,
  observe: AndroidObservationSink,
): Promise<void> {
  const roots = await command("shell find /sdcard/ -mindepth 1 -maxdepth 1 -print");
  const paths = roots.split("\n").filter(Boolean).sort();
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path) => !isAndroidResetFile(path) || path.slice("/sdcard/".length).includes("/"))
  ) {
    throw new ActionableError("Android baseline shared-storage root inventory is malformed");
  }
  observe("shared-file", "roots", createHash("sha256").update(JSON.stringify(paths)).digest("hex"));
  for (const root of ANDROID_BASELINE_FILE_ROOTS) {
    const script = `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -type f -exec sha256sum {} \\;; elif [ -e ${shellQuote(root)} ]; then exit 1; fi`;
    const output = await command(`shell sh -c ${shellQuote(script)}`, 30_000);
    for (const line of output.split("\n").filter(Boolean)) {
      const match = /^([a-fA-F0-9]{64})  (.+)$/.exec(line);
      const path = match?.[2];
      if (!match?.[1] || !path || !path.startsWith(`${root}/`) || !isAndroidResetFile(path)) {
        throw new ActionableError("Android baseline shared-file inventory is malformed");
      }
      observe("shared-file", path, match[1].toLowerCase());
    }
  }
}

export async function captureAndroidUsers(command: AndroidBaselineCommand): Promise<number[]> {
  const output = await command("shell pm list users");
  const users = parsePmListUsers(output).map((user) => user.userId);
  const lines = output.split("\n").filter((line) => line.trim());
  if (
    lines[0]?.trim() !== "Users:" ||
    lines.length !== users.length + 1 ||
    !users.includes(0) ||
    users.some((user) => !Number.isSafeInteger(user)) ||
    new Set(users).size !== users.length ||
    lines
      .slice(1)
      .some((line) => !/^\s*UserInfo\{\d+:[^:]+:[a-fA-F0-9]+\}(?: running)?\s*$/.test(line))
  ) {
    throw new ActionableError("Android baseline user inventory is malformed");
  }
  return users.sort((left, right) => left - right);
}

export function parseAndroidBaselinePackages(output: string): string[] {
  const result = output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^package:([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/.exec(line.trim());
      if (!match?.[1]) {
        throw new ActionableError("Android baseline package inventory is malformed");
      }
      return match[1];
    });
  if (new Set(result).size !== result.length) {
    throw new ActionableError("Android baseline package inventory has duplicates");
  }
  return result.sort();
}

async function captureAndroidPackages(
  command: AndroidBaselineCommand,
  observe: AndroidObservationSink,
  users: readonly number[],
): Promise<void> {
  const installed = new Map<number, string[]>();
  const systemPackages = new Set(
    parseAndroidBaselinePackages(await command("shell pm list packages -s -u")),
  );
  if (!systemPackages.has("android")) {
    throw new ActionableError("Android baseline system package inventory is incomplete");
  }
  const inventory = new Set<string>();
  for (const user of users) {
    observe("installed-app", `users:${user}`, true);
    const all = parseAndroidBaselinePackages(
      await command(`shell pm list packages --user ${user}`),
    );
    const thirdParty = parseAndroidBaselinePackages(
      await command(`shell pm list packages -3 --user ${user}`),
    );
    if (!all.includes("android") || thirdParty.some((name) => !all.includes(name))) {
      throw new ActionableError("Android baseline package inventory is incomplete");
    }
    installed.set(user, all);
    for (const name of all) {
      observe("installed-app", `user:${user}:${name}`, true);
    }
    for (const name of thirdParty) {
      inventory.add(name);
    }
  }
  for (const name of [...inventory].sort()) {
    await capturePackageState(
      command,
      observe,
      name,
      users.filter((id) => installed.get(id)?.includes(name)),
    );
  }
}

async function capturePackageState(
  command: AndroidBaselineCommand,
  observe: AndroidObservationSink,
  name: string,
  installedUsers: readonly number[],
): Promise<void> {
  const dump = await command(`shell dumpsys package ${shellQuote(name)}`);
  const header = new RegExp(
    `^\\s*Package \\[${name.replaceAll(".", "\\.")}\\] \\([^\\n]+\\):\\s*$`,
    "m",
  ).exec(dump);
  const body = header
    ? dump.slice(header.index + header[0].length).split(/^\s*Package \[/m)[0]!
    : "";
  const updated = /^\s*lastUpdateTime=(.+)$/m.exec(body)?.[1];
  const version = /^\s*versionCode=(\d+)\b/m.exec(body)?.[1];
  const codePath = /^\s*codePath=(.+)$/m.exec(body)?.[1];
  if (!updated || !version || !codePath) {
    throw new ActionableError(`Android baseline cannot read package identity for ${name}`);
  }
  observe("installed-app", `identity:${name}`, JSON.stringify([updated, version, codePath]));
  for (const user of installedUsers) {
    const parsed = parseAndroidRuntimePermissions(dump, name, user);
    if (!parsed || !new RegExp(`^\\s*User ${user}:.*\\binstalled=true\\b`, "m").test(body)) {
      throw new ActionableError(
        `Android baseline cannot read permissions for ${name} user ${user}`,
      );
    }
    for (const [permission, state] of parsed.runtimePermissions) {
      observe("permission", `runtime:${user}:${name}:${permission}`, state.state === "granted");
      observe(
        "permission",
        `runtime-flags:${user}:${name}:${permission}`,
        JSON.stringify(state.raw),
      );
    }
  }
}

function parseDisplayOverride(output: string, type: "density" | "size"): string | null {
  const lines = output.split("\n");
  const valuePattern = type === "density" ? "[0-9]+" : "[0-9]+x[0-9]+";
  const physical = new RegExp(`^Physical ${type}: ${valuePattern}$`);
  const override = new RegExp(`^Override ${type}: (${valuePattern})$`);
  if (!lines[0] || !physical.test(lines[0]) || lines.length > 2) {
    throw new ActionableError(`Android baseline display ${type} is unreadable`);
  }
  if (lines.length === 1) {
    return null;
  }
  const match = override.exec(lines[1]!);
  if (!match?.[1]) {
    throw new ActionableError(`Android baseline display ${type} is unreadable`);
  }
  return match[1];
}
