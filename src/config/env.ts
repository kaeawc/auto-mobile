/**
 * Typed registry of environment variables (#11848).
 *
 * Every variable AutoMobile reads should be declared once (product variables in
 * `envDaemon.ts`, `envMedia.ts` and `envDevices.ts`, ambient ones below), with its legacy
 * spelling, kind, default and a one-line description, and read through
 * {@link readEnvTrimmed}. Readers take an injected `env` so tests never mutate
 * `process.env`. `test/lint/envRegistry.test.ts` fails on any unregistered read.
 */

import { DAEMON_ENV } from "./envDaemon";
import { DEVICES_ENV } from "./envDevices";
import { MEDIA_ENV } from "./envMedia";
import type { EnvVarSpec } from "./envSpec";

export type { EnvVarSpec } from "./envSpec";

/** Every AutoMobile-owned variable; the entries live in the domain modules next to this file. */
export const ENV = {
  ...DAEMON_ENV,
  ...MEDIA_ENV,
  ...DEVICES_ENV,
} as const satisfies Record<string, EnvVarSpec>;

/**
 * Ambient variables owned by the OS or the Android toolchain, not by AutoMobile. They are
 * declared and read through the same readers, but kept apart from {@link ENV} because the
 * product-variable conformance checks (AUTOMOBILE_ prefix, path classification) do not apply.
 */
export const AMBIENT_ENV = {
  DEVELOPER_DIR: {
    name: "DEVELOPER_DIR",
    kind: "path",
    default: "unset",
    doc: "Active Xcode developer directory; overrides xcode-select for simulator profile caching.",
  },
  ANDROID_HOME: {
    name: "ANDROID_HOME",
    kind: "path",
    default: "unset",
    doc: "Android SDK root; ambient Android toolchain variable, read for emulator resolution.",
  },
  ANDROID_SDK_ROOT: {
    name: "ANDROID_SDK_ROOT",
    kind: "path",
    default: "unset",
    doc: "Android SDK root (deprecated by Google); ambient, read for emulator resolution.",
  },
  ANDROID_SDK_HOME: {
    name: "ANDROID_SDK_HOME",
    kind: "path",
    default: "unset",
    doc: "Android user-data home; ambient, reported in emulator-not-found diagnostics.",
  },
  HOME: {
    name: "HOME",
    kind: "path",
    default: "unset",
    doc: "POSIX home directory; ambient, used to probe the default Android SDK locations.",
  },
  USERPROFILE: {
    name: "USERPROFILE",
    kind: "path",
    default: "unset",
    doc: "Windows home directory; ambient, fallback when HOME is unset or empty.",
  },
  PATH: {
    name: "PATH",
    kind: "string",
    default: "unset",
    doc: "Executable search path; ambient, reported in emulator-not-found diagnostics.",
  },
  JAVA_HOME: {
    name: "JAVA_HOME",
    kind: "path",
    default: "unset",
    doc: "Java installation root; ambient, checked by doctor and used to run a bundletool jar.",
  },
  ANTHROPIC_API_KEY: {
    name: "ANTHROPIC_API_KEY",
    kind: "string",
    default: "unset",
    doc: "Anthropic API key for vision features; ambient, used when no key is configured explicitly.",
  },
  DISPLAY: {
    name: "DISPLAY",
    kind: "string",
    default: "unset",
    doc: "X11 display; ambient, a usable value keeps Linux emulator launches windowed.",
  },
  WAYLAND_DISPLAY: {
    name: "WAYLAND_DISPLAY",
    kind: "string",
    default: "unset",
    doc: "Wayland display; ambient, a usable value keeps Linux emulator launches windowed.",
  },
  USER: {
    name: "USER",
    kind: "string",
    default: "unset",
    doc: "POSIX account name; ambient, locates the emulator advertisement directory.",
  },
  LOGNAME: {
    name: "LOGNAME",
    kind: "string",
    default: "unset",
    doc: "POSIX login name; ambient, fallback when USER is unset.",
  },
  XDG_RUNTIME_DIR: {
    name: "XDG_RUNTIME_DIR",
    kind: "path",
    default: "unset",
    doc: "Linux per-user runtime directory; ambient, locates emulator advertisements.",
  },
  ANDROID_AVD_HOME: {
    name: "ANDROID_AVD_HOME",
    kind: "path",
    default: "unset",
    doc: "Android AVD home override; ambient, used to locate AVD definitions.",
  },
  ANDROID_EMULATOR_HOME: {
    name: "ANDROID_EMULATOR_HOME",
    kind: "path",
    default: "unset",
    doc: "Android emulator home override; ambient, used to locate AVD definitions.",
  },
  ANDROID_USER_HOME: {
    name: "ANDROID_USER_HOME",
    kind: "path",
    default: "unset",
    doc: "Android user home override; ambient, used to locate AVD definitions.",
  },
  CI: {
    name: "CI",
    kind: "string",
    default: "unset",
    doc: "Set to true on CI hosts; ambient.",
  },
  GITHUB_ACTIONS: {
    name: "GITHUB_ACTIONS",
    kind: "string",
    default: "unset",
    doc: "Set to true inside GitHub Actions; ambient.",
  },
  GITHUB_WORKSPACE: {
    name: "GITHUB_WORKSPACE",
    kind: "path",
    default: "unset",
    doc: "GitHub Actions checkout directory; ambient.",
  },
  COMSPEC: {
    name: "ComSpec",
    legacyName: "COMSPEC",
    kind: "path",
    default: "cmd.exe",
    doc: "Windows command interpreter; ambient.",
  },
  DEBUG_ADB_EXEC: {
    name: "DEBUG_ADB_EXEC",
    kind: "string",
    default: "unset",
    doc: "Any value logs real adb execution with stack traces; ambient debug aid.",
  },
  EMULATOR_POLLING_INTERVAL_MS: {
    name: "EMULATOR_POLLING_INTERVAL_MS",
    kind: "string",
    default: "500",
    doc: "Emulator readiness polling interval in ms (minimum 100).",
  },
  LOCALAPPDATA: {
    name: "LOCALAPPDATA",
    kind: "path",
    default: "unset",
    doc: "Windows local app data directory; ambient.",
  },
  MCP_SERVER_VERSION: {
    name: "MCP_SERVER_VERSION",
    kind: "string",
    default: "unset",
    doc: "Exact override of the reported MCP server version (CI/test pin).",
  },
  NPM_PACKAGE_VERSION: {
    name: "npm_package_version",
    kind: "string",
    default: "unset",
    doc: "Package version exported by npm; ambient fallback for the MCP server version.",
  },
  NODE_ENV: {
    name: "NODE_ENV",
    kind: "string",
    default: "unset",
    doc: "Runtime mode; ambient, exact test arms the test-only guards and defaults.",
  },
  WINDOWS_PATH: {
    name: "Path",
    kind: "string",
    default: "unset",
    doc: "Windows spelling of PATH; ambient, consulted when PATH is unset.",
  },
  USERNAME: {
    name: "USERNAME",
    kind: "string",
    default: "unset",
    doc: "Windows account name; ambient, daemon state file suffix fallback.",
  },
  PATHEXT: {
    name: "PATHEXT",
    kind: "string",
    default: "unset",
    doc: "Windows executable extensions; ambient, used to locate bunx.",
  },
  ADB_SERVER_SOCKET: {
    name: "ADB_SERVER_SOCKET",
    kind: "string",
    default: "unset",
    doc: "adb server socket spec; ambient, identifies the ADB server scope.",
  },
  ANDROID_ADB_SERVER_ADDRESS: {
    name: "ANDROID_ADB_SERVER_ADDRESS",
    kind: "string",
    default: "localhost",
    doc: "adb server host; ambient, identifies the ADB server scope.",
  },
  ANDROID_ADB_SERVER_PORT: {
    name: "ANDROID_ADB_SERVER_PORT",
    kind: "string",
    default: "5037",
    doc: "adb server port; ambient, identifies the ADB server scope.",
  },
  GIT_DIR: {
    name: "GIT_DIR",
    kind: "path",
    default: "unset",
    doc: "Git repository directory; ambient, honoured when stamping a source build's commit.",
  },
  GIT_WORK_TREE: {
    name: "GIT_WORK_TREE",
    kind: "path",
    default: "unset",
    doc: "Git work tree; ambient, locates the source checkout when stamping its commit.",
  },
  GIT_COMMON_DIR: {
    name: "GIT_COMMON_DIR",
    kind: "path",
    default: "unset",
    doc: "Git common directory; ambient, resolves shared refs when stamping a commit.",
  },
  CTRL_PROXY_IOS_BUNDLE_ID: {
    name: "CTRL_PROXY_IOS_BUNDLE_ID",
    kind: "string",
    default: "unset",
    doc: "Target app bundle id passed to the iOS CtrlProxy runner.",
  },
  CTRL_PROXY_IOS_TIMEOUT: {
    name: "CTRL_PROXY_IOS_TIMEOUT",
    kind: "string",
    default: "86400",
    doc: "Runner lifetime in seconds passed to the iOS CtrlProxy runner.",
  },
} as const satisfies Record<string, EnvVarSpec>;

export const ENV_REGISTRY: readonly EnvVarSpec[] = Object.values(ENV);
export const AMBIENT_ENV_REGISTRY: readonly EnvVarSpec[] = Object.values(AMBIENT_ENV);

/**
 * Raw value of a variable: the canonical name wins whenever it is set (even to
 * an empty string), otherwise the legacy spelling is consulted.
 */
export function readEnvRaw(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[spec.name] ?? (spec.legacyName === undefined ? undefined : env[spec.legacyName]);
}

/** Trimmed value, or undefined when unset or blank. */
export function readEnvTrimmed(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = readEnvRaw(spec, env)?.trim();
  return value ? value : undefined;
}

const TRUTHY_ENV_TEXT: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/**
 * The one truthiness rule for boolean environment flags: `1`, `true`, `yes` or `on`, trimmed
 * and case-insensitive. Anything else, including unset, is false.
 */
export function isTruthyEnvText(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_ENV_TEXT.has(value.trim().toLowerCase());
}

/** A `kind: "bool"` variable, read with {@link isTruthyEnvText}. */
export function readEnvBool(spec: EnvVarSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvText(readEnvRaw(spec, env));
}

/**
 * Lenient finite number (fractions allowed), bounded by `spec.min`. Undefined when the
 * variable is unset/blank (not reported) or unusable (`onInvalid` receives the raw text).
 */
export function readEnvNumber(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
  onInvalid?: (raw: string) => void,
): number | undefined {
  const raw = readEnvTrimmed(spec, env);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  const min = spec.min ?? Number.NEGATIVE_INFINITY;
  if (Number.isFinite(parsed) && (spec.minExclusive ? parsed > min : parsed >= min)) {
    return parsed;
  }
  onInvalid?.(raw);
  return undefined;
}

/** Trimmed, lowercased value when it is one of `spec.values`, else undefined. */
export function readEnvEnum(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = readEnvTrimmed(spec, env)?.toLowerCase();
  return value !== undefined && spec.values?.includes(value) ? value : undefined;
}

/** Comma-separated list with entries trimmed and blanks dropped. */
export function readEnvList(spec: EnvVarSpec, env: NodeJS.ProcessEnv = process.env): string[] {
  return (readEnvTrimmed(spec, env) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `AUTOMOBILE_TOOLSET_*` variables were retired in favor of exact enable/disable lists; startup rejects them. */
export function isRetiredToolsetVariable(name: string): boolean {
  return name.startsWith("AUTOMOBILE_TOOLSET_");
}
