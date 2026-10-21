import type { ApkSignatureScheme, ApkSignerCertificate } from "./ApkSignerCertificate";

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

/** The `embedded.mobileprovision` summary of an installed iOS bundle (#14099). */
export interface IosProvisioningProfileSummary {
  name: string;
  uuid: string;
  teamIds: string[];
  teamName?: string;
  /** ISO 8601, or null when the profile's ExpirationDate is unreadable. */
  expirationDate: string | null;
  /** Compared against host time at the read. */
  expired: boolean | null;
  /** UDIDs the profile lists; null for profiles that provision all devices or list none. */
  provisionedDeviceCount: number | null;
  provisionsAllDevices: boolean;
}

/** iOS has no APK signer set: the identity is the CodeDirectory hash plus team and chain. */
export type IosPackageSigning =
  | {
      status: "available";
      /** Lowercase hex CDHash of the main executable's CodeDirectory. */
      cdHash: string | null;
      /** Signed bundle identifier. */
      identifier: string | null;
      /** Null for ad-hoc signatures (Simulator builds). */
      teamId: string | null;
      /** Leaf certificate common name; null for ad-hoc signatures. */
      signingIdentity: string | null;
      adHoc: boolean;
      /** Certificate chain, leaf first. */
      authorities: string[];
      /** Signed entitlements as JSON; null when the signature carries none. */
      entitlements: Record<string, unknown> | null;
      /** Null when the bundle embeds no provisioning profile (Simulator and App Store builds). */
      provisioningProfile: IosProvisioningProfileSummary | null;
      /** Per-part read failures that left a field null instead of failing the whole read. */
      warnings?: string[];
    }
  | { status: "unsigned"; reason: string }
  | { status: "unavailable"; reason: string };

export interface IosPackageSigningObservation {
  /** Simulator bundles are read in place; physical bundles are copied off the device first. */
  source: "simctl-app-container+codesign" | "devicectl-copy+codesign";
  fresh: true;
  observedAt: string;
  scope: { deviceId: string; appId: string };
}

/** iOS variant of the `inspectPackageSigning` result; the Android shape above is unchanged. */
export interface IosPackageSigningInspection {
  appId: string;
  platform: "ios";
  deviceId: string;
  deviceKind: "simulator" | "physical";
  presence: PackagePresence;
  unknownReason?: string;
  signing: IosPackageSigning;
  observation: IosPackageSigningObservation;
}
