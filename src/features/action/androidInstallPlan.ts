import path from "node:path";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import type { AndroidArtifactHost } from "./AndroidArtifactHost";
import type { AndroidBundletool } from "./AndroidBundletool";
import type { AndroidInstallAttempt, AndroidInstallRequest } from "./InstallAppTypes";

/** How an Android artifact reaches the device. */
export type AndroidInstallRoute = "apk" | "split-apks" | "apk-set" | "bundle";

interface AndroidInstallPlanBase {
  route: AndroidInstallRoute;
  /**
   * The APK aapt reads the package name from: the APK itself, the base split, or the base split
   * extracted from the APK set. Undefined when an APK set holds no base split.
   */
  packageSourceApk?: string;
  warnings: string[];
  /** Remove the plan's scratch files (built APK set, extracted base, password files). */
  cleanup(): Promise<void>;
}

/** `adb install` / `adb install-multiple`, run through InstallApp's adb attempt. */
export interface AdbInstallPlan extends AndroidInstallPlanBase {
  kind: "adb";
  installArgs(userId: number): string;
}

/** bundletool `install-apks`; it installs for every user (bundletool takes no `--user`). */
export interface BundletoolInstallPlan extends AndroidInstallPlanBase {
  kind: "bundletool";
  install(signal?: AbortSignal): Promise<AndroidInstallAttempt>;
}

export type AndroidInstallPlan = AdbInstallPlan | BundletoolInstallPlan;

export interface AndroidInstallPlanDependencies {
  artifactHost: AndroidArtifactHost;
  bundletool: AndroidBundletool;
}

const SUPPORTED_ANDROID_ARTIFACTS =
  ".apk, .apks (APK set), .aab (app bundle), or a directory of split APKs";

/** `install`/`install-multiple` argv; with no flags it is the historical single-APK command. */
export function adbInstallArgs(
  apks: readonly string[],
  userId: number,
  request: AndroidInstallRequest = {},
): string {
  const verb = apks.length > 1 ? "install-multiple" : "install";
  const flags = [
    `--user ${userId}`,
    "-r",
    ...(request.grantAllPermissions ? ["-g"] : []),
    ...(request.allowDowngrade ? ["-d"] : []),
  ];
  return `${verb} ${flags.join(" ")} ${apks.map((apk) => `"${apk}"`).join(" ")}`;
}

function absolute(target: string): string {
  return path.isAbsolute(target) ? target : resolvePathFromDaemonLaunchWorkingDirectory(target);
}

const BASE_APK_NAMES = new Set(["base.apk", "base-master.apk"]);

/** The base APK of a split directory: `base.apk`/`base-master.apk`, else the first by name. */
export function orderSplitApks(apks: readonly string[]): string[] {
  const base = apks.find((apk) => BASE_APK_NAMES.has(path.basename(apk).toLowerCase())) ?? apks[0];
  return [base, ...apks.filter((apk) => apk !== base)];
}

function rejectOptions(request: AndroidInstallRequest, ext: string): void {
  const bundleOnly = request.bundle?.keystore !== undefined || request.bundle?.localTesting;
  if (request.splits !== undefined && ext !== ".apk") {
    throw new ActionableError("splits apply only when artifactPath is the base .apk");
  }
  if (request.bundle !== undefined && ext !== ".aab" && ext !== ".apks") {
    throw new ActionableError("bundle options apply only to .aab and .apks artifacts");
  }
  if (bundleOnly && ext !== ".aab") {
    throw new ActionableError(
      "bundle.keystore and bundle.localTesting apply only to .aab artifacts (an .apks set is already built and signed)",
    );
  }
}

function adbPlan(
  route: "apk" | "split-apks",
  apks: string[],
  request: AndroidInstallRequest,
): AdbInstallPlan {
  return {
    kind: "adb",
    route,
    packageSourceApk: apks[0],
    warnings: [],
    installArgs: (userId) => adbInstallArgs(apks, userId, request),
    cleanup: async () => undefined,
  };
}

async function splitDirectoryPlan(
  directory: string,
  request: AndroidInstallRequest,
  host: AndroidArtifactHost,
): Promise<AdbInstallPlan> {
  const apks = await host.listApks(directory);
  if (apks.length === 0) {
    throw new ActionableError(
      `No .apk files found in ${directory}. Pass a directory holding a base APK and its split APKs.`,
    );
  }
  return adbPlan(apks.length > 1 ? "split-apks" : "apk", orderSplitApks(apks), request);
}

async function removeScratch(host: AndroidArtifactHost, scratchDir: string): Promise<void> {
  try {
    await host.removeDir(scratchDir);
  } catch (error) {
    logger.warn(
      `[InstallApp] Could not remove install scratch directory ${scratchDir}: ${errorMessage(error)}`,
      error,
    );
  }
}

async function bundletoolPlan(
  artifactPath: string,
  route: "apk-set" | "bundle",
  request: AndroidInstallRequest,
  { deps, signal }: { deps: AndroidInstallPlanDependencies; signal?: AbortSignal },
): Promise<BundletoolInstallPlan> {
  const { artifactHost: host, bundletool } = deps;
  await bundletool.resolve(route === "bundle" ? ".aab" : ".apks");
  const scratchDir = await host.createScratchDir();
  const cleanup = () => removeScratch(host, scratchDir);
  try {
    const apkSet =
      route === "bundle"
        ? await bundletool.buildApks(artifactPath, request, scratchDir, signal)
        : artifactPath;
    const baseApk = path.join(scratchDir, "base.apk");
    const hasBase = await host.extractBaseApk(apkSet, baseApk);
    return {
      kind: "bundletool",
      route,
      packageSourceApk: hasBase ? baseApk : undefined,
      warnings: hasBase
        ? []
        : ["The APK set has no base split, so the package name was read from the device."],
      install: (installSignal) => bundletool.installApks(apkSet, request, installSignal),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Decide how an Android artifact is installed. An `.aab` is built into a device-specific APK
 * set here, before the per-device install lock, because building does not touch the device's
 * packages. The caller must `cleanup()` the plan.
 */
export async function resolveAndroidInstallPlan(
  artifactPath: string,
  request: AndroidInstallRequest,
  deps: AndroidInstallPlanDependencies,
  signal?: AbortSignal,
): Promise<AndroidInstallPlan> {
  const ext = path.extname(artifactPath).toLowerCase();
  rejectOptions(request, ext);
  if (ext === ".apk") {
    const splits = (request.splits ?? []).map(absolute);
    const nonApk = splits.find((split) => path.extname(split).toLowerCase() !== ".apk");
    if (nonApk !== undefined) {
      throw new ActionableError(`Every split must be an .apk file, but got "${nonApk}"`);
    }
    return adbPlan(splits.length > 0 ? "split-apks" : "apk", [artifactPath, ...splits], request);
  }
  if (ext === ".apks" || ext === ".aab") {
    return bundletoolPlan(artifactPath, ext === ".aab" ? "bundle" : "apk-set", request, {
      deps,
      signal,
    });
  }
  if (await deps.artifactHost.isDirectory(artifactPath)) {
    return splitDirectoryPlan(artifactPath, request, deps.artifactHost);
  }
  throw new ActionableError(
    `Android devices support ${SUPPORTED_ANDROID_ARTIFACTS}, but got "${ext}" file.`,
  );
}
