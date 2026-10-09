import type {
  ApkSignatureScheme,
  ApkSignerCertificate,
} from "../utils/android-cmdline-tools/apkSigningBlock";

/**
 * Whether the package is installed for the inspected Android user.
 * `unknown` means the read failed or was incomplete; it never implies `absent`.
 */
export type PackagePresence = "installed" | "absent" | "unknown";

/** Where the inspected user came from (explicit argument or the shared user-target resolver). */
export type PackageSigningUserSource =
  | "explicit"
  | "installedUser"
  | "foregroundPackage"
  | "managedProfile"
  | "primary"
  | "currentUser";

export type PackageSigning =
  | {
      status: "available";
      /** The signature scheme whose signers were selected for this device. */
      scheme: ApkSignatureScheme;
      /**
       * Complete signer set: lowercase hex SHA-256 of each signing certificate, sorted and
       * de-duplicated. A package signed by several signers lists all of them; every one is part
       * of the identity.
       */
      signerSha256: string[];
      signers: ApkSignerCertificate[];
      /**
       * Certificate history from the signing-certificate lineage (oldest first, current signer
       * last) when the selected signer carries one. Absent when the package has no rotation.
       * Taken from the installed APK as-is; the lineage signatures are not re-verified here.
       */
      history?: string[];
    }
  | { status: "unavailable"; reason: string };

export interface PackageSigningObservation {
  /** How the answer was obtained. */
  source: "dumpsys-package+apk-signing-block";
  /** Always a live read made for this call; no cache is consulted. */
  fresh: true;
  /** Host time when the read finished (ISO 8601). */
  observedAt: string;
  scope: { deviceId: string; userId: number; appId: string; apkPath?: string };
  /** Device `ro.build.version.sdk`, or null when it could not be read. */
  apiLevel: number | null;
}

export interface PackageSigningInspection {
  appId: string;
  platform: "android";
  deviceId: string;
  /** The Android user/profile that was inspected. Never substituted silently. */
  userId: number;
  userSource: PackageSigningUserSource;
  presence: PackagePresence;
  /** Why presence is `unknown`. */
  unknownReason?: string;
  /** Present when the package is installed but hidden or suspended for the user. */
  state?: { hidden?: boolean; suspended?: boolean };
  signing: PackageSigning;
  observation: PackageSigningObservation;
}
