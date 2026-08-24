import {
  acceptLicenses,
  listInstalledSystemImages,
  listSystemImages,
  installSystemImage,
  listDeviceImages,
  createAvd,
  deleteAvd,
  listDevices,
  SystemImageFilter,
  SystemImage,
  CreateAvdParams,
  AvdInfo,
  DeviceProfile,
  AvdManagerDependencies,
} from "./avdmanager";
import type { AvdManager } from "./interfaces/AvdManager";

/**
 * Service wrapper for AVD Manager operations
 * Implements AvdManager interface and delegates to functional API
 */
export class AvdManagerService implements AvdManager {
  private dependencies?: AvdManagerDependencies;

  constructor(dependencies?: AvdManagerDependencies) {
    this.dependencies = dependencies;
  }

  async acceptLicenses(): Promise<{
    success: boolean;
    message: string;
  }> {
    if (this.dependencies) {
      return acceptLicenses(this.dependencies);
    }
    return acceptLicenses();
  }

  async listSystemImages(filter?: SystemImageFilter): Promise<SystemImage[]> {
    if (this.dependencies) {
      return listSystemImages(filter, this.dependencies);
    }
    return listSystemImages(filter);
  }

  async listInstalledSystemImages(filter?: SystemImageFilter): Promise<SystemImage[]> {
    if (this.dependencies) {
      return listInstalledSystemImages(filter, this.dependencies);
    }
    return listInstalledSystemImages(filter);
  }

  async installSystemImage(
    packageName: string,
    acceptLicense = true,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    if (this.dependencies) {
      return installSystemImage(packageName, acceptLicense, this.dependencies);
    }
    return installSystemImage(packageName, acceptLicense);
  }

  async listDeviceImages(): Promise<AvdInfo[]> {
    if (this.dependencies) {
      return listDeviceImages(this.dependencies);
    }
    return listDeviceImages();
  }

  async createAvd(params: CreateAvdParams): Promise<{
    success: boolean;
    message: string;
    avdName?: string;
  }> {
    if (this.dependencies) {
      return createAvd(params, this.dependencies);
    }
    return createAvd(params);
  }

  async deleteAvd(name: string): Promise<{
    success: boolean;
    message: string;
  }> {
    if (this.dependencies) {
      return deleteAvd(name, this.dependencies);
    }
    return deleteAvd(name);
  }

  async listDevices(): Promise<DeviceProfile[]> {
    if (this.dependencies) {
      return listDevices(this.dependencies);
    }
    return listDevices();
  }
}
