import { join } from "node:path";
import { access } from "node:fs/promises";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type {
  IosPackageSigning,
  IosPackageSigningInspection,
  IosProvisioningProfileSummary,
  PackagePresence,
} from "../../models/PackageSigningInspection";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  AppBundleMetadataClient,
  type AppBundleMetadata,
  type CodeSignatureReader,
} from "../../utils/ios-cmdline-tools/AppBundleMetadataClient";
import type { CodeSignature } from "../../utils/ios-cmdline-tools/codesignDisplay";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import {
  parseProvisioningProfileXml,
  type ProvisioningProfileFields,
} from "../../utils/ios-cmdline-tools/provisioningProfileFields";
import {
  SecurityClient,
  type SecurityClientApi,
} from "../../utils/ios-cmdline-tools/SecurityClient";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const EMBEDDED_PROFILE = "embedded.mobileprovision";

/**
 * Access to the installed `.app` bundle on the host filesystem. Resolves null when the app is not
 * installed and throws when the lookup itself fails, so "absent" is never a guess.
 */
export interface IosSigningBundleAccess {
  readonly source: IosPackageSigningInspection["observation"]["source"];
  withBundle<T>(
    appId: string,
    read: (bundlePath: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | null>;
}

/** Simulator bundles live on the host: `simctl get_app_container <udid> <bundle> app`. */
export function simulatorBundleAccess(
  udid: string,
  simctl: Pick<SimCtlClient, "executeCommandArgs">,
): IosSigningBundleAccess {
  return {
    source: "simctl-app-container+codesign",
    async withBundle(appId, read, signal) {
      let bundlePath: string;
      try {
        const container = await simctl.executeCommandArgs([
          "get_app_container",
          udid,
          appId,
          "app",
        ]);
        bundlePath = container.stdout.trim();
      } catch (error) {
        throwIfAborted(signal);
        // simctl reports an uninstalled app as a missing container path.
        if (errorMessage(error).includes("No such file or directory")) {
          logger.debug(`[IosPackageSigning] ${appId} is not installed on ${udid}`);
          return null;
        }
        throw error;
      }
      throwIfAborted(signal);
      return bundlePath ? read(bundlePath) : null;
    },
  };
}

/** Physical bundles are copied off the device with devicectl (#14094) and read from the copy. */
export function physicalBundleAccess(
  udid: string,
  deviceApps: Pick<DeviceAppManager, "withInstalledAppBundle">,
): IosSigningBundleAccess {
  return {
    source: "devicectl-copy+codesign",
    withBundle: (appId, read) =>
      deviceApps.withInstalledAppBundle(udid, appId, read, { surfaceLookupErrors: true }),
  };
}

export interface IosPackageSigningInspectorDeps {
  bundles?: IosSigningBundleAccess;
  codesign?: CodeSignatureReader & AppBundleMetadata;
  profiles?: Pick<SecurityClientApi, "decodeCms">;
  fileExists?: (path: string) => Promise<boolean>;
  timer?: Timer;
}

const defaultFileExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    // A missing embedded.mobileprovision is the normal Simulator/App Store case.
    () => false,
  );

/** Summarize a decoded profile; `now` decides `expired`. */
export function summarizeProvisioningProfile(
  fields: ProvisioningProfileFields,
  now: number,
): IosProvisioningProfileSummary {
  const expiry = fields.expirationDate.getTime();
  const valid = !Number.isNaN(expiry);
  return {
    name: fields.name,
    uuid: fields.uuid,
    teamIds: fields.teamIds,
    ...(fields.teamName ? { teamName: fields.teamName } : {}),
    expirationDate: valid ? fields.expirationDate.toISOString() : null,
    expired: valid ? expiry <= now : null,
    provisionedDeviceCount: fields.provisionedDevices ? fields.provisionedDevices.length : null,
    provisionsAllDevices: fields.provisionsAllDevices,
  };
}

/**
 * Read-only signing inspection of an installed iOS app (#14099): presence, then the code
 * signature (team, identity, CDHash), signed entitlements and the embedded provisioning profile.
 * Every call reads the device; nothing is cached.
 */
export class IosPackageSigningInspector {
  private readonly kind: "simulator" | "physical";
  private readonly bundles: IosSigningBundleAccess;
  private readonly codesign: CodeSignatureReader & AppBundleMetadata;
  private readonly profiles: Pick<SecurityClientApi, "decodeCms">;
  private readonly fileExists: (path: string) => Promise<boolean>;
  private readonly timer: Timer;

  constructor(
    private readonly device: BootedDevice,
    deps: IosPackageSigningInspectorDeps = {},
  ) {
    this.kind = resolveIosDeviceKind(device) === "simulator" ? "simulator" : "physical";
    this.bundles =
      deps.bundles ??
      (this.kind === "simulator"
        ? simulatorBundleAccess(device.deviceId, new SimCtlClient(device))
        : physicalBundleAccess(device.deviceId, new DeviceAppManager()));
    this.codesign = deps.codesign ?? new AppBundleMetadataClient();
    this.profiles = deps.profiles ?? new SecurityClient();
    this.fileExists = deps.fileExists ?? defaultFileExists;
    this.timer = deps.timer ?? defaultTimer;
  }

  async execute(
    appId: string,
    options: { userId?: number; signal?: AbortSignal } = {},
  ): Promise<IosPackageSigningInspection> {
    if (!BUNDLE_ID_PATTERN.test(appId)) {
      throw new ActionableError(`Invalid iOS bundle identifier: ${JSON.stringify(appId)}`);
    }
    if (options.userId !== undefined) {
      throw new ActionableError("userId is Android-only; iOS apps are not installed per user.");
    }
    const { signal } = options;
    throwIfAborted(signal);
    try {
      const signing = await this.bundles.withBundle(
        appId,
        (bundlePath) => this.readSigning(appId, bundlePath, signal),
        signal,
      );
      throwIfAborted(signal);
      return signing
        ? this.finish(appId, "installed", signing)
        : this.finish(appId, "absent", {
            status: "unavailable",
            reason: "App is not installed",
          });
    } catch (error) {
      throwIfAborted(signal);
      const reason = `Installed bundle lookup failed: ${errorMessage(error)}`;
      logger.warn(`[IosPackageSigning] ${reason}`, error);
      return this.finish(appId, "unknown", { status: "unavailable", reason }, reason);
    }
  }

  private finish(
    appId: string,
    presence: PackagePresence,
    signing: IosPackageSigning,
    unknownReason?: string,
  ): IosPackageSigningInspection {
    return {
      appId,
      platform: "ios",
      deviceId: this.device.deviceId,
      deviceKind: this.kind,
      presence,
      ...(unknownReason ? { unknownReason } : {}),
      signing,
      observation: {
        source: this.bundles.source,
        fresh: true,
        observedAt: new Date(this.timer.now()).toISOString(),
        scope: { deviceId: this.device.deviceId, appId },
      },
    };
  }

  private async readSigning(
    appId: string,
    bundlePath: string,
    signal?: AbortSignal,
  ): Promise<IosPackageSigning> {
    const request = { appBundlePath: bundlePath, deviceId: this.device.deviceId, bundleId: appId };
    let signature: CodeSignature | null;
    try {
      signature = await this.codesign.readCodeSignature({ ...request, signal });
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[IosPackageSigning] codesign failed for ${appId}: ${errorMessage(error)}`,
        error,
      );
      return { status: "unavailable", reason: `codesign failed: ${errorMessage(error)}` };
    }
    if (!signature) {
      return { status: "unsigned", reason: "codesign reports the bundle is not signed" };
    }
    const warnings: string[] = [];
    const entitlements = await this.readPart(
      "entitlements",
      () => this.codesign.readEntitlements({ ...request, signal }),
      warnings,
      signal,
    );
    const provisioningProfile = await this.readPart(
      "provisioning profile",
      () => this.readProfile(bundlePath),
      warnings,
      signal,
    );
    return {
      status: "available",
      cdHash: signature.cdHash,
      identifier: signature.identifier,
      teamId: signature.teamId,
      signingIdentity: signature.signingIdentity,
      adHoc: signature.adHoc,
      authorities: signature.authorities,
      entitlements: entitlements ? { ...entitlements } : null,
      provisioningProfile: provisioningProfile ?? null,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** A failed optional part leaves its field null and records why; the signature still reports. */
  private async readPart<T>(
    label: string,
    read: () => Promise<T | null>,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[IosPackageSigning] ${label} read failed: ${errorMessage(error)}`, error);
      warnings.push(`${label} unavailable: ${errorMessage(error)}`);
      return null;
    }
  }

  private async readProfile(bundlePath: string): Promise<IosProvisioningProfileSummary | null> {
    const profilePath = join(bundlePath, EMBEDDED_PROFILE);
    if (!(await this.fileExists(profilePath))) {
      return null;
    }
    const fields = await parseProvisioningProfileXml(await this.profiles.decodeCms(profilePath));
    if (!fields) {
      throw new Error(`${EMBEDDED_PROFILE} did not decode to a plist dictionary`);
    }
    return summarizeProvisioningProfile(fields, this.timer.now());
  }
}
