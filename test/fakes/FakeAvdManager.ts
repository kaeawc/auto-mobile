import { AvdManager } from "../../src/utils/android-cmdline-tools/interfaces/AvdManager";
import {
  SystemImageFilter,
  SystemImage,
  CreateAvdParams,
  AvdInfo,
  DeviceProfile,
} from "../../src/utils/android-cmdline-tools/avdmanager";
import type { Timer } from "../../src/utils/SystemTimer";

/**
 * Fake implementation of AvdManager for testing
 * Allows configuring responses and asserting method calls
 */
export class FakeAvdManager implements AvdManager {
  private acceptLicensesResponse: { success: boolean; message: string } = {
    success: true,
    message: "Android SDK licenses accepted",
  };
  private listSystemImagesResponse: SystemImage[] = [];
  private listInstalledSystemImagesResponse: SystemImage[] = [];
  private listInstalledSystemImagesHangs: boolean = false;
  private installSystemImageResponse: { success: boolean; message: string } = {
    success: true,
    message: "System image installed successfully",
  };
  private listDeviceImagesResponse: AvdInfo[] = [];
  private listDeviceImagesResponseQueue: AvdInfo[][] = [];
  private listDeviceImagesHangs: boolean = false;
  private listDeviceImagesDelay: { timer: Timer; ms: number } | undefined;
  private createAvdResponse: { success: boolean; message: string; avdName?: string } = {
    success: true,
    message: "AVD created successfully",
  };
  private deleteAvdResponse: { success: boolean; message: string } = {
    success: true,
    message: "AVD deleted successfully",
  };
  private listDevicesResponse: DeviceProfile[] = [];
  private listDevicesHangs: boolean = false;

  // Call tracking
  private acceptLicensesCalls: number = 0;
  private listSystemImagesCalls: Array<{ filter?: SystemImageFilter }> = [];
  private listInstalledSystemImagesCalls: Array<{
    filter?: SystemImageFilter;
    signal?: AbortSignal;
  }> = [];
  private installSystemImageCalls: Array<{ packageName: string; acceptLicense?: boolean }> = [];
  private listDeviceImagesCalls: Array<{ signal?: AbortSignal }> = [];
  private createAvdCalls: Array<{ params: CreateAvdParams }> = [];
  private deleteAvdCalls: Array<{ name: string }> = [];
  private listDevicesCalls: Array<{ signal?: AbortSignal }> = [];

  // Configuration setters for responses
  setAcceptLicensesResponse(response: { success: boolean; message: string }): void {
    this.acceptLicensesResponse = response;
  }

  setListSystemImagesResponse(response: SystemImage[]): void {
    this.listSystemImagesResponse = response;
  }

  setListInstalledSystemImagesResponse(response: SystemImage[]): void {
    this.listInstalledSystemImagesResponse = response;
  }

  /**
   * Make listInstalledSystemImages never resolve on its own, so a bounded
   * caller must fall back to its deadline. If the caller aborts via the passed
   * signal the promise rejects with the abort reason, letting a test assert the
   * cancellation propagated.
   */
  setListInstalledSystemImagesHangs(hangs: boolean): void {
    this.listInstalledSystemImagesHangs = hangs;
  }

  setInstallSystemImageResponse(response: { success: boolean; message: string }): void {
    this.installSystemImageResponse = response;
  }

  setListDeviceImagesResponse(response: AvdInfo[]): void {
    this.listDeviceImagesResponse = response;
    this.listDeviceImagesResponseQueue = [];
  }

  /** Return successive AVD inventories, then retain the final response. */
  setListDeviceImagesResponses(responses: AvdInfo[][]): void {
    this.listDeviceImagesResponseQueue = responses.map((response) => [...response]);
    this.listDeviceImagesResponse = responses.at(-1) ?? [];
  }

  /**
   * Make listDeviceImages never resolve on its own, so a bounded caller must
   * fall back to its deadline. If the caller aborts via the passed signal the
   * promise rejects with the abort reason, letting a test assert the
   * cancellation propagated.
   */
  setListDeviceImagesHangs(hangs: boolean): void {
    this.listDeviceImagesHangs = hangs;
  }

  /** Delay image enumeration through an injected clock for deterministic cache tests. */
  setListDeviceImagesDelay(timer: Timer, ms: number): void {
    this.listDeviceImagesDelay = { timer, ms };
  }

  setCreateAvdResponse(response: { success: boolean; message: string; avdName?: string }): void {
    this.createAvdResponse = response;
  }

  setDeleteAvdResponse(response: { success: boolean; message: string }): void {
    this.deleteAvdResponse = response;
  }

  setListDevicesResponse(response: DeviceProfile[]): void {
    this.listDevicesResponse = response;
  }

  /**
   * Make listDevices never resolve on its own, so a bounded caller must fall
   * back to its deadline. If the caller aborts via the passed signal the
   * promise rejects with the abort reason, letting a test assert the
   * cancellation propagated.
   */
  setListDevicesHangs(hangs: boolean): void {
    this.listDevicesHangs = hangs;
  }

  // Call tracking getters for assertions
  getAcceptLicensesCalls(): number {
    return this.acceptLicensesCalls;
  }

  getListSystemImagesCalls(): Array<{ filter?: SystemImageFilter }> {
    return [...this.listSystemImagesCalls];
  }

  getListInstalledSystemImagesCalls(): Array<{
    filter?: SystemImageFilter;
    signal?: AbortSignal;
  }> {
    return [...this.listInstalledSystemImagesCalls];
  }

  getInstallSystemImageCalls(): Array<{ packageName: string; acceptLicense?: boolean }> {
    return [...this.installSystemImageCalls];
  }

  getListDeviceImagesCalls(): Array<{ signal?: AbortSignal }> {
    return [...this.listDeviceImagesCalls];
  }

  getCreateAvdCalls(): Array<{ params: CreateAvdParams }> {
    return [...this.createAvdCalls];
  }

  getDeleteAvdCalls(): Array<{ name: string }> {
    return [...this.deleteAvdCalls];
  }

  getListDevicesCalls(): Array<{ signal?: AbortSignal }> {
    return [...this.listDevicesCalls];
  }

  /**
   * Clear all call tracking
   */
  clearCallHistory(): void {
    this.acceptLicensesCalls = 0;
    this.listSystemImagesCalls = [];
    this.listInstalledSystemImagesCalls = [];
    this.installSystemImageCalls = [];
    this.listDeviceImagesCalls = [];
    this.createAvdCalls = [];
    this.deleteAvdCalls = [];
    this.listDevicesCalls = [];
  }

  // Implementation of AvdManager interface

  async acceptLicenses(): Promise<{
    success: boolean;
    message: string;
  }> {
    this.acceptLicensesCalls++;
    return this.acceptLicensesResponse;
  }

  async listSystemImages(filter?: SystemImageFilter): Promise<SystemImage[]> {
    this.listSystemImagesCalls.push({ filter });
    return this.listSystemImagesResponse;
  }

  async listInstalledSystemImages(
    filter?: SystemImageFilter,
    signal?: AbortSignal,
  ): Promise<SystemImage[]> {
    this.listInstalledSystemImagesCalls.push({ filter, signal });
    if (this.listInstalledSystemImagesHangs) {
      return new Promise<SystemImage[]>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        }
      });
    }
    return this.listInstalledSystemImagesResponse;
  }

  async installSystemImage(
    packageName: string,
    acceptLicense = true,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    this.installSystemImageCalls.push({ packageName, acceptLicense });
    return this.installSystemImageResponse;
  }

  async listDeviceImages(signal?: AbortSignal): Promise<AvdInfo[]> {
    this.listDeviceImagesCalls.push({ signal });
    if (this.listDeviceImagesHangs) {
      return new Promise<AvdInfo[]>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        }
      });
    }
    if (this.listDeviceImagesDelay) {
      await this.listDeviceImagesDelay.timer.sleep(this.listDeviceImagesDelay.ms);
    }
    if (this.listDeviceImagesResponseQueue.length > 0) {
      const response = this.listDeviceImagesResponseQueue.shift();
      return response ?? this.listDeviceImagesResponse;
    }
    return this.listDeviceImagesResponse;
  }

  async createAvd(params: CreateAvdParams): Promise<{
    success: boolean;
    message: string;
    avdName?: string;
  }> {
    this.createAvdCalls.push({ params });
    return this.createAvdResponse;
  }

  async deleteAvd(name: string): Promise<{
    success: boolean;
    message: string;
  }> {
    this.deleteAvdCalls.push({ name });
    return this.deleteAvdResponse;
  }

  async listDevices(signal?: AbortSignal): Promise<DeviceProfile[]> {
    this.listDevicesCalls.push({ signal });
    if (this.listDevicesHangs) {
      return new Promise<DeviceProfile[]>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        }
      });
    }
    return this.listDevicesResponse;
  }
}
