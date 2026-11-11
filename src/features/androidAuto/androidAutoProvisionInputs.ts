import path from "node:path";
import { ActionableError } from "../../models/ActionableError";
import {
  resolveAndroidSdkRoot,
  type AndroidSdkEnvironment,
} from "../../utils/android-cmdline-tools/androidSdkRoot";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import type { ProvisionAndroidAutoOptions } from "../deviceLifecycle/core/schemas";

export type { ProvisionAndroidAutoOptions };

/** The host files a projection run uses, resolved and checked to exist. */
export interface AndroidAutoProvisionInputs {
  /** `base.apk` first, then every `split_*.apk`, so `adb install-multiple` gets the base first. */
  androidAutoApks: string[];
  dhu: { binaryPath: string; configPath: string };
  acceptAndroidAutoTerms: boolean;
}

/** The read-only host filesystem view the resolver needs. */
export interface AndroidAutoHostFiles {
  isDirectory(target: string): Promise<boolean>;
  isFile(target: string): Promise<boolean>;
  /** File names (not paths) in `directory`. */
  list(directory: string): Promise<string[]>;
}

export interface AndroidAutoInputEnvironment {
  env: AndroidSdkEnvironment;
  platform: NodeJS.Platform;
  files: AndroidAutoHostFiles;
}

/** The SDK Manager package that installs the Desktop Head Unit. */
export const DHU_SDK_PACKAGE = "extras;google;auto";
export const DEFAULT_DHU_CONFIG = path.join("config", "default_720p.ini");
const BASE_APK = "base.apk";
const SPLIT_APK = /^split_.+\.apk$/;

function dhuBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "desktop-head-unit.exe" : "desktop-head-unit";
}

/**
 * A caller's relative path means the directory the daemon was launched from: the detached
 * daemon itself runs from the home directory.
 */
function userPath(target: string, env: AndroidSdkEnvironment): string {
  return path.resolve(resolvePathFromDaemonLaunchWorkingDirectory(target, env));
}

async function resolveApks(
  apkDirectory: string,
  { env, files }: AndroidAutoInputEnvironment,
  missing: string[],
): Promise<string[]> {
  const directory = userPath(apkDirectory, env);
  if (!(await files.isDirectory(directory))) {
    missing.push(
      `the Android Auto APK directory ${directory} does not exist; put the split APKs of an Android Auto release (base.apk plus its split_config.*.apk files) there`,
    );
    return [];
  }
  const names = await files.list(directory);
  if (!names.includes(BASE_APK)) {
    missing.push(
      `${directory} has no ${BASE_APK}; it must hold an Android Auto release's base.apk and its split_config.*.apk files`,
    );
    return [];
  }
  const splits = names.filter((name) => SPLIT_APK.test(name)).sort();
  return [BASE_APK, ...splits].map((name) => path.join(directory, name));
}

async function resolveDhu(
  options: ProvisionAndroidAutoOptions,
  { env, platform, files }: AndroidAutoInputEnvironment,
  missing: string[],
): Promise<{ binaryPath: string; configPath: string }> {
  let binaryPath: string;
  if (options.dhuPath) {
    binaryPath = userPath(options.dhuPath, env);
  } else {
    const sdkRoot = resolveAndroidSdkRoot(env);
    if (!sdkRoot) {
      missing.push(
        `the Desktop Head Unit: ANDROID_HOME is not set, so ${dhuBinaryName(platform)} cannot be found; set ANDROID_HOME or pass androidAuto.dhuPath`,
      );
      return { binaryPath: "", configPath: "" };
    }
    binaryPath = path.join(sdkRoot, "extras", "google", "auto", dhuBinaryName(platform));
  }
  const binaryFound = await files.isFile(binaryPath);
  if (!binaryFound) {
    missing.push(
      `the Desktop Head Unit at ${binaryPath}; install it with sdkmanager "${DHU_SDK_PACKAGE}" (Android Auto Desktop Head Unit Emulator) or pass androidAuto.dhuPath`,
    );
  }
  const configPath = options.dhuConfig
    ? userPath(options.dhuConfig, env)
    : path.join(path.dirname(binaryPath), DEFAULT_DHU_CONFIG);
  // A default config beside a missing binary is the same missing install; report it once.
  if ((binaryFound || options.dhuConfig) && !(await files.isFile(configPath))) {
    missing.push(`the head unit config ${configPath}; pass androidAuto.dhuConfig with a DHU .ini`);
  }
  return { binaryPath, configPath };
}

/**
 * Resolves and checks the host files an Android Auto projection run needs. Throws one
 * actionable error that names every missing piece, so the caller fixes them in one pass.
 */
export async function resolveAndroidAutoProvisionInputs(
  options: ProvisionAndroidAutoOptions,
  host: AndroidAutoInputEnvironment,
): Promise<AndroidAutoProvisionInputs> {
  const missing: string[] = [];
  const androidAutoApks = await resolveApks(options.apkDirectory, host, missing);
  const dhu = await resolveDhu(options, host, missing);
  if (missing.length > 0) {
    throw new ActionableError(`Android Auto projection is missing ${missing.join("; and ")}.`);
  }
  return {
    androidAutoApks,
    dhu,
    acceptAndroidAutoTerms: options.acceptAndroidAutoTerms === true,
  };
}
