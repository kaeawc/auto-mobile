import path from "node:path";
import { ActionableError } from "../../models/ActionableError";
import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { adbFailureOutput } from "../../utils/android-cmdline-tools/adbFailureOutput";
import {
  requireBundletool,
  type BundletoolCommand,
  type BundletoolLocator,
} from "../../utils/android-cmdline-tools/BundletoolLocator";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import type { AndroidArtifactHost } from "./AndroidArtifactHost";
import type {
  AndroidBundleKeystore,
  AndroidInstallAttempt,
  AndroidInstallRequest,
} from "./InstallAppTypes";
import { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "./installAppTimeout";

/** `build-apks` compiles every split of a bundle; allow far longer than an install. */
export const BUNDLETOOL_BUILD_APKS_TIMEOUT_MS = 600_000;

/** Stands in for a keystore password wherever bundletool output could echo one. */
export const REDACTED_SECRET = "<redacted>";

const VERSION_DOWNGRADE_CODE = /\bINSTALL_FAILED_VERSION_DOWNGRADE\b/;

/** bundletool prints whole stack traces; keep the end, where the cause is. */
const MAX_FAILURE_TEXT_CHARS = 2000;

export interface AndroidBundletoolDependencies {
  hostExecutor: HostCommandExecutor;
  locator: BundletoolLocator;
  artifactHost: AndroidArtifactHost;
  /** The adb binary bundletool must talk to, so it reaches the same server as AutoMobile. */
  adbPath: () => Promise<string>;
  deviceId: string;
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.message === OPERATION_CANCELLED_MESSAGE))
  );
}

/** execFile marks a child it killed for exceeding `timeout` with `killed`; walk the wrap chain. */
function hostCommandTimedOut(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ((current as Error & { killed?: unknown }).killed === true) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Replace every known secret in bundletool text before it is logged or surfaced. */
export function scrubBundletoolText(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((scrubbed, secret) => scrubbed.split(secret).join(REDACTED_SECRET), text);
}

function assertSingleLinePassword(value: string, field: string): void {
  // bundletool reads only the first line of a `file:` password.
  if (/[\r\n]/.test(value)) {
    throw new ActionableError(`bundle.keystore.${field} must not contain a line break`);
  }
}

/** Runs bundletool `build-apks` and `install-apks` against one device. */
export class AndroidBundletool {
  private tool?: BundletoolCommand;

  constructor(private readonly deps: AndroidBundletoolDependencies) {}

  /** Locate bundletool once, or throw the typed not-found error before any other work. */
  async resolve(artifactKind: string): Promise<BundletoolCommand> {
    return (this.tool ??= await requireBundletool(this.deps.locator, artifactKind));
  }

  /**
   * Build a device-specific APK set from an app bundle into `scratchDir`. Keystore passwords go
   * to bundletool as `file:` references to 0600 files in that private directory, never as
   * `pass:` argv, so they stay out of process listings, command-failure messages and logs.
   */
  async buildApks(
    bundlePath: string,
    request: AndroidInstallRequest,
    scratchDir: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const tool = await this.resolve(".aab");
    const output = path.join(scratchDir, "bundle.apks");
    const keystore = request.bundle?.keystore;
    const args = [
      "build-apks",
      `--bundle=${bundlePath}`,
      `--output=${output}`,
      "--overwrite",
      "--connected-device",
      `--device-id=${this.deps.deviceId}`,
      ...(await this.adbArgs()),
      ...(request.bundle?.localTesting ? ["--local-testing"] : []),
      ...(keystore ? await this.signingArgs(keystore, scratchDir) : []),
    ];
    const secrets = keystore ? [keystore.storePassword, keystore.keyPassword ?? ""] : [];
    try {
      await this.run(tool, args, BUNDLETOOL_BUILD_APKS_TIMEOUT_MS, signal);
    } catch (error) {
      if (isCancellation(error, signal)) {
        throw error;
      }
      const detail = this.failureText(error, secrets);
      logger.warn(`[InstallApp] bundletool build-apks failed: ${detail}`);
      throw new ActionableError(`bundletool build-apks failed for ${bundlePath}: ${detail}`);
    }
    return output;
  }

  /** One `install-apks` attempt, shaped like an adb install attempt for the shared recovery. */
  async installApks(
    apkSetPath: string,
    request: AndroidInstallRequest,
    signal?: AbortSignal,
  ): Promise<AndroidInstallAttempt> {
    const tool = await this.resolve(".apks");
    const modules = request.bundle?.modules;
    const args = [
      "install-apks",
      `--apks=${apkSetPath}`,
      `--device-id=${this.deps.deviceId}`,
      ...(await this.adbArgs()),
      ...(modules && modules.length > 0 ? [`--modules=${modules.join(",")}`] : []),
      ...(request.allowDowngrade ? ["--allow-downgrade"] : []),
      ...(request.grantAllPermissions ? ["--grant-runtime-permissions"] : []),
    ];
    try {
      // The host kill is the only deadline (bundletool's own is longer), so a timeout always
      // reads as `timedOut` and the shared recovery asks the device whether it committed.
      const result = await this.run(tool, args, ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS, signal);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return { success: true, output, diagnostics: output, threw: false };
    } catch (error) {
      if (isCancellation(error, signal)) {
        throw error;
      }
      // Diagnostics drop the APK set path so a path that names an error code cannot match it.
      const diagnostics = this.failureText(error).split(apkSetPath).join("<apks>");
      logger.warn(`[InstallApp] bundletool install-apks failed: ${diagnostics}`);
      const timedOut = hostCommandTimedOut(error);
      const output = timedOut
        ? `bundletool install-apks timed out after ${ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS}ms`
        : `bundletool install-apks failed: ${diagnostics}`;
      return {
        success: false,
        output,
        diagnostics,
        threw: true,
        timedOut,
        versionDowngrade: VERSION_DOWNGRADE_CODE.test(diagnostics),
        error: new ActionableError(output, { cause: error }),
      };
    }
  }

  private async signingArgs(
    keystore: AndroidBundleKeystore,
    scratchDir: string,
  ): Promise<string[]> {
    assertSingleLinePassword(keystore.storePassword, "storePassword");
    // bundletool falls back to an interactive prompt without a key password; always pass one.
    const keyPassword = keystore.keyPassword ?? keystore.storePassword;
    assertSingleLinePassword(keyPassword, "keyPassword");
    const storePasswordFile = path.join(scratchDir, "ks-pass");
    const keyPasswordFile = path.join(scratchDir, "key-pass");
    await this.deps.artifactHost.writeSecretFile(storePasswordFile, keystore.storePassword);
    await this.deps.artifactHost.writeSecretFile(keyPasswordFile, keyPassword);
    return [
      `--ks=${path.isAbsolute(keystore.path) ? keystore.path : resolvePathFromDaemonLaunchWorkingDirectory(keystore.path)}`,
      `--ks-key-alias=${keystore.alias}`,
      `--ks-pass=file:${storePasswordFile}`,
      `--key-pass=file:${keyPasswordFile}`,
    ];
  }

  /**
   * Point bundletool at AutoMobile's adb. A bare `adb` is only AutoMobile's unresolved guess, and
   * bundletool rejects a relative path, so it then resolves adb itself (ANDROID_HOME or PATH).
   */
  private async adbArgs(): Promise<string[]> {
    const adb = await this.deps.adbPath();
    return path.isAbsolute(adb) ? [`--adb=${adb}`] : [];
  }

  private run(tool: BundletoolCommand, args: string[], timeoutMs: number, signal?: AbortSignal) {
    return this.deps.hostExecutor.executeCommand(tool.file, [...tool.args, ...args], {
      timeoutMs,
      signal,
    });
  }

  /** bundletool's own output; the wrapped error message repeats the full command line. */
  private failureText(error: unknown, secrets: readonly string[] = []): string {
    const { stdout, stderr } = adbFailureOutput(error);
    const text = [stderr, stdout]
      .filter((value) => value.trim().length > 0)
      .join("\n")
      .trim();
    // Scrub before truncating, so a cut can never leave part of a secret behind.
    const failure = scrubBundletoolText(text.length > 0 ? text : errorMessage(error), secrets);
    return failure.length > MAX_FAILURE_TEXT_CHARS
      ? `...${failure.slice(-MAX_FAILURE_TEXT_CHARS)}`
      : failure;
  }
}
