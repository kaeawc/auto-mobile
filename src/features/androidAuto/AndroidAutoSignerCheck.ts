import { ActionableError } from "../../models/ActionableError";
import type {
  PackageSigning,
  PackageSigningInspection,
} from "../../models/PackageSigningInspection";
import {
  readApkSigningSchemes,
  type ApkByteSource,
} from "../../utils/android-cmdline-tools/apkSigningBlock";
import { selectSigners } from "../observe/InspectPackageSigning";
import { ANDROID_AUTO_PACKAGE } from "./androidAutoProjection";

/** Refuses user-supplied Android Auto APKs unless they carry the preinstalled stub's signers. */
export interface AndroidAutoSignerCheck {
  verify(apkPaths: readonly string[], signal?: AbortSignal): Promise<void>;
}

/** The read-only package signing inspection (`InspectPackageSigning`), narrowed to one call. */
export interface InstalledPackageSigningReader {
  execute(appId: string, options: { signal?: AbortSignal }): Promise<PackageSigningInspection>;
}

export type LocalApkOpener = (
  localPath: string,
) => Promise<{ source: ApkByteSource; dispose(): Promise<void> }>;

/**
 * Why `apk` cannot update `installed`, or null when the signer sets match. Android
 * enforces the same rule on install; checking first gives an actionable message and
 * keeps a mismatched set from being pushed at all.
 */
export function signerMismatchReason(
  installed: PackageSigning,
  apk: PackageSigning,
  apkPath: string,
): string | null {
  if (installed.status !== "available") {
    return `The installed Android Auto signers could not be read (${installed.reason}).`;
  }
  if (apk.status !== "available") {
    return `${apkPath} has no usable signer (${apk.reason}).`;
  }
  const expected = installed.signerSha256.join(",");
  const actual = apk.signerSha256.join(",");
  // A rotated signer may update a package whose signer is in its lineage.
  if (expected === actual || apk.history?.includes(expected)) {
    return null;
  }
  return `${apkPath} is signed by ${actual}, but the installed Android Auto is signed by ${expected}. Android rejects an update with a different signer; supply the APKs of an official Android Auto release.`;
}

export class InspectingAndroidAutoSignerCheck implements AndroidAutoSignerCheck {
  constructor(
    private readonly installed: InstalledPackageSigningReader,
    private readonly openApk: LocalApkOpener,
  ) {}

  async verify(apkPaths: readonly string[], signal?: AbortSignal): Promise<void> {
    const inspection = await this.installed.execute(ANDROID_AUTO_PACKAGE, { signal });
    if (inspection.presence !== "installed") {
      throw new ActionableError(
        `Android Auto (${ANDROID_AUTO_PACKAGE}) is not installed on this device. Use a Google Play system image (google_apis_playstore), which ships the Android Auto stub.`,
      );
    }
    for (const apkPath of apkPaths) {
      signal?.throwIfAborted();
      const reason = signerMismatchReason(
        inspection.signing,
        await this.readApkSigning(apkPath, inspection.observation.apiLevel),
        apkPath,
      );
      if (reason) {
        throw new ActionableError(reason);
      }
    }
  }

  private async readApkSigning(apkPath: string, apiLevel: number | null): Promise<PackageSigning> {
    const apk = await this.openApk(apkPath);
    try {
      const schemes = await readApkSigningSchemes(apk.source);
      return schemes
        ? selectSigners(schemes, apiLevel)
        : { status: "unavailable", reason: "no APK Signing Block (v1-only signing is not read)" };
    } finally {
      await apk.dispose();
    }
  }
}
