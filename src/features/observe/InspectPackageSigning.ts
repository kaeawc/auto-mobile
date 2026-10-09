import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootedDevice } from "../../models";
import { ActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import type {
  PackagePresence,
  PackageSigning,
  PackageSigningInspection,
} from "../../models/PackageSigningInspection";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import {
  ApkSigningParseError,
  readApkSigningSchemes,
  type ApkByteSource,
  type ApkSignatureScheme,
  type ApkSignerCertificate,
  type ApkSigningSchemes,
} from "../../utils/android-cmdline-tools/apkSigningBlock";
import { parseDumpsysPackagePresence } from "../../utils/android-cmdline-tools/parseDumpsysPackagePresence";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { parsePmPathOutput } from "../../utils/ContentHashProvider";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";

const INSPECT_COMMAND_TIMEOUT_MS = 15_000;
const APK_PULL_TIMEOUT_MS = 120_000;
const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

/** Gives access to the bytes of one on-device APK. */
export interface ApkFetcher {
  open(
    adb: AdbExecutor,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<{ source: ApkByteSource; dispose(): Promise<void> }>;
}

/** Pulls the APK to a temp file with `adb pull` and reads it with random access. */
export class AdbPullApkFetcher implements ApkFetcher {
  async open(adb: AdbExecutor, remotePath: string, signal?: AbortSignal) {
    const workDir = await fs.mkdtemp(join(tmpdir(), "automobile-signing-"));
    const localPath = join(workDir, "base.apk");
    const dispose = async () => {
      await fs.rm(workDir, { recursive: true, force: true });
    };
    try {
      await adb.executeCommand(
        `pull ${shellQuote(remotePath)} ${shellQuote(localPath)}`,
        APK_PULL_TIMEOUT_MS,
        undefined,
        true,
        signal,
      );
      const handle = await fs.open(localPath, "r");
      const size = (await handle.stat()).size;
      return {
        source: {
          size,
          read: async (offset: number, length: number) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
          },
        },
        dispose: async () => {
          await handle.close();
          await dispose();
        },
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}

export interface InspectPackageSigningOptions {
  userId?: number;
  signal?: AbortSignal;
}

export interface InspectPackageSigningDeps {
  apkFetcher?: ApkFetcher;
  timer?: Timer;
}

/**
 * Read-only inspection of an installed Android package: whether it is installed for one user and
 * which signing certificates its installed APK carries. Every call reads the device; nothing is
 * cached, so the result is suitable immediately before or after an app mutation.
 */
export class InspectPackageSigning {
  private readonly adb: AdbExecutor;
  private readonly apkFetcher: ApkFetcher;
  private readonly timer: Timer;

  constructor(
    private readonly device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    deps: InspectPackageSigningDeps = {},
  ) {
    this.adb = adbFactory.create(device);
    this.apkFetcher = deps.apkFetcher ?? new AdbPullApkFetcher();
    this.timer = deps.timer ?? defaultTimer;
  }

  async execute(
    appId: string,
    options: InspectPackageSigningOptions = {},
  ): Promise<PackageSigningInspection> {
    if (this.device.platform !== "android") {
      throw unsupportedPlatformError(this.device.platform, "inspecting package signing");
    }
    if (!PACKAGE_NAME_PATTERN.test(appId)) {
      throw new ActionableError(`Invalid Android package name: ${JSON.stringify(appId)}`);
    }
    const { signal } = options;
    throwIfAborted(signal);

    const target = await new AndroidUserTargetResolver(this.adb).resolve({
      packageName: appId,
      explicitUserId: options.userId,
      installedOnly: true,
      signal,
    });
    const userId = target.userId;
    const scope = { deviceId: this.device.deviceId, userId, appId };

    const base = {
      appId,
      platform: "android" as const,
      deviceId: this.device.deviceId,
      userId,
      userSource: target.source,
    };
    const finish = (
      presence: PackagePresence,
      signing: PackageSigning,
      extra: {
        unknownReason?: string;
        state?: { hidden?: boolean; suspended?: boolean };
        apkPath?: string;
        apiLevel?: number | null;
      } = {},
    ): PackageSigningInspection => ({
      ...base,
      presence,
      ...(extra.unknownReason ? { unknownReason: extra.unknownReason } : {}),
      ...(extra.state ? { state: extra.state } : {}),
      signing,
      observation: {
        source: "dumpsys-package+apk-signing-block",
        fresh: true,
        observedAt: new Date(this.timer.now()).toISOString(),
        scope: { ...scope, ...(extra.apkPath ? { apkPath: extra.apkPath } : {}) },
        apiLevel: extra.apiLevel ?? null,
      },
    });

    const presence = await this.readPresence(appId, userId, signal);
    if (presence.presence === "unknown") {
      return finish(
        "unknown",
        { status: "unavailable", reason: presence.reason },
        {
          unknownReason: presence.reason,
        },
      );
    }
    if (presence.presence === "absent") {
      return finish("absent", { status: "unavailable", reason: "Package is not installed" });
    }

    const state = { hidden: presence.hidden, suspended: presence.suspended };
    const signing = await this.readSigning(appId, userId, signal);
    return finish("installed", signing.signing, {
      state,
      apkPath: signing.apkPath,
      apiLevel: signing.apiLevel,
    });
  }

  private async readPresence(appId: string, userId: number, signal?: AbortSignal) {
    try {
      const result = await this.adb.executeCommand(
        `shell dumpsys package ${shellQuote(appId)}`,
        INSPECT_COMMAND_TIMEOUT_MS,
        DUMPSYS_MAX_BUFFER,
        true,
        signal,
      );
      return parseDumpsysPackagePresence(result.stdout, appId, userId);
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[InspectPackageSigning] dumpsys package failed: ${errorMessage(error)}`, error);
      return {
        presence: "unknown" as const,
        reason: `dumpsys package failed: ${errorMessage(error)}`,
      };
    }
  }

  private async readSigning(
    appId: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ signing: PackageSigning; apkPath?: string; apiLevel: number | null }> {
    let apiLevel: number | null = null;
    let apkPath: string | undefined;
    try {
      const paths = await this.adb.executeCommand(
        `shell pm path --user ${userId} ${shellQuote(appId)}`,
        INSPECT_COMMAND_TIMEOUT_MS,
        undefined,
        true,
        signal,
      );
      const apks = parsePmPathOutput(paths.stdout);
      apkPath = apks.find((path) => path.endsWith("/base.apk")) ?? apks[0];
      if (!apkPath) {
        return unavailable("pm path returned no APK for the package", apkPath, apiLevel);
      }
      apiLevel = await readAndroidDeviceApiLevel(
        this.adb,
        INSPECT_COMMAND_TIMEOUT_MS,
        this.timer,
        signal,
      );
      const apk = await this.apkFetcher.open(this.adb, apkPath, signal);
      try {
        const schemes = await readApkSigningSchemes(apk.source);
        if (!schemes) {
          return unavailable(
            "APK has no APK Signing Block (v1/JAR-only signing is not read)",
            apkPath,
            apiLevel,
          );
        }
        return { signing: selectSigners(schemes, apiLevel), apkPath, apiLevel };
      } finally {
        await apk.dispose();
      }
    } catch (error) {
      throwIfAborted(signal);
      const detail = error instanceof ApkSigningParseError ? error.message : errorMessage(error);
      logger.warn(`[InspectPackageSigning] signing read failed: ${detail}`, error);
      return unavailable(`Could not read signing certificates: ${detail}`, apkPath, apiLevel);
    }
  }
}

function unavailable(reason: string, apkPath: string | undefined, apiLevel: number | null) {
  return { signing: { status: "unavailable", reason } as const, apkPath, apiLevel };
}

const SCHEME_PRECEDENCE: ApkSignatureScheme[] = ["v3.1", "v3", "v2"];

function appliesTo(signer: ApkSignerCertificate, apiLevel: number): boolean {
  return (
    (signer.minSdkVersion === undefined || signer.minSdkVersion <= apiLevel) &&
    (signer.maxSdkVersion === undefined || apiLevel <= signer.maxSdkVersion)
  );
}

/**
 * Picks the signers PackageManager would use on this device: the newest scheme with a signer
 * whose SDK range contains the device API level (v3.1, then v3, then v2). With the API level
 * unknown, v3.1 rotation-targeted signers cannot be selected, so the answer is unavailable
 * rather than a guess.
 */
export function selectSigners(schemes: ApkSigningSchemes, apiLevel: number | null): PackageSigning {
  if (apiLevel === null && schemes["v3.1"]) {
    return {
      status: "unavailable",
      reason: "Device API level unknown; v3.1 rotation-targeted signers cannot be selected",
    };
  }
  for (const scheme of SCHEME_PRECEDENCE) {
    const signers = schemes[scheme]?.filter(
      (signer) => apiLevel === null || appliesTo(signer, apiLevel),
    );
    if (!signers?.length) {
      continue;
    }
    const history = signers.find((signer) => signer.lineage)?.lineage;
    return {
      status: "available",
      scheme,
      signerSha256: [...new Set(signers.map((signer) => signer.sha256))].sort(),
      signers,
      ...(history ? { history } : {}),
    };
  }
  return { status: "unavailable", reason: "No signer in the APK applies to this device" };
}
