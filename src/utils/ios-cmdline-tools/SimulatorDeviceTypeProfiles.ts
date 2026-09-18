import { logger } from "../logger";
import { PlistClient, type PlistReader } from "./PlistClient";
import { SimCtlClient, type AppleDeviceType } from "./SimCtlClient";

export interface SimulatorDeviceTypeProfile {
  deviceTypeId: string;
  productFamily: string | null;
  modelIdentifier: string | null;
  // mainScreenWidth/mainScreenHeight from profile.plist are the panel's PIXEL dimensions
  // (iPhone 17: 1206x2622 at mainScreenScale 3 = 402x874 UIKit points) — the same unit
  // Android reports. `dpi` is the panel density (mainScreenWidthDPI); `scale` is UIScreen.scale.
  pixelWidth: number | null;
  pixelHeight: number | null;
  scale: number | null;
  dpi: number | null;
}

export interface SimulatorDeviceTypeProfileSource {
  profileFor(
    deviceTypeId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SimulatorDeviceTypeProfile | null>;
}

export interface SimulatorDeviceTypeLister {
  getDeviceTypes(signal?: AbortSignal): Promise<AppleDeviceType[]>;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Best-effort reader for simulator device type display metadata. */
export class SimCtlSimulatorDeviceTypeProfiles implements SimulatorDeviceTypeProfileSource {
  private readonly profiles = new Map<string, SimulatorDeviceTypeProfile | null>();
  private deviceTypes: Promise<AppleDeviceType[]> | undefined;

  constructor(
    private readonly deviceTypeLister: SimulatorDeviceTypeLister = new SimCtlClient(),
    private readonly plist: PlistReader = new PlistClient(),
  ) {}

  async profileFor(
    deviceTypeId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SimulatorDeviceTypeProfile | null> {
    if (this.profiles.has(deviceTypeId)) {
      return this.profiles.get(deviceTypeId) ?? null;
    }

    let deviceTypes: AppleDeviceType[];
    try {
      deviceTypes = await this.getDeviceTypes(options.signal);
    } catch (error) {
      // Device type listing is optional best-effort enrichment, so a transient failure is safe to swallow and retry.
      logger.debug(`Failed to list iOS simulator device types: ${String(error)}`);
      return null;
    }

    try {
      const deviceType = deviceTypes.find((candidate) => candidate.identifier === deviceTypeId);
      if (!deviceType?.bundlePath) {
        this.profiles.set(deviceTypeId, null);
        return null;
      }
      const plist = await this.plist.readJsonFile(
        `${deviceType.bundlePath}/Contents/Resources/profile.plist`,
        options,
      );
      const values = plist !== null && typeof plist === "object" ? plist : {};
      const profile = {
        deviceTypeId,
        productFamily: optionalString(deviceType.productFamily),
        modelIdentifier: optionalString(deviceType.modelIdentifier),
        pixelWidth: optionalNumber((values as Record<string, unknown>).mainScreenWidth),
        pixelHeight: optionalNumber((values as Record<string, unknown>).mainScreenHeight),
        scale: optionalNumber((values as Record<string, unknown>).mainScreenScale),
        dpi:
          optionalNumber((values as Record<string, unknown>).mainScreenWidthDPI) ??
          optionalNumber((values as Record<string, unknown>).mainScreenHeightDPI),
      } satisfies SimulatorDeviceTypeProfile;
      this.profiles.set(deviceTypeId, profile);
      return profile;
    } catch (error) {
      // Display dimensions are optional best-effort enrichment, so a failed lookup is safe to swallow.
      logger.debug(
        `Failed to read iOS simulator device type profile for ${deviceTypeId}: ${String(error)}`,
      );
      // A cancelled/timed-out read says nothing about the profile; only a completed
      // failure is worth remembering.
      if (!isAbortOrTimeout(error)) {
        this.profiles.set(deviceTypeId, null);
      }
      return null;
    }
  }

  private getDeviceTypes(signal?: AbortSignal): Promise<AppleDeviceType[]> {
    if (!this.deviceTypes) {
      this.deviceTypes = this.deviceTypeLister.getDeviceTypes(signal).catch((error) => {
        this.deviceTypes = undefined;
        throw error;
      });
    }
    return this.deviceTypes;
  }
}

function isAbortOrTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || /timed out|timeout/i.test(error.message);
}
