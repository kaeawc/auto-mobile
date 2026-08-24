import type { DeviceMatchCriteria } from "../../src/models/DeviceMatchCriteria";
import type {
  AndroidAvdCreator,
  DeviceProvisioner,
  IosSimulatorCreator,
  ProvisionedDevice,
} from "../../src/utils/deviceProvisioning";
import type { AppleDeviceType } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type {
  CreateAvdParams,
  SystemImage,
} from "../../src/utils/android-cmdline-tools/avdmanager";

/** Records provisioning requests and returns a canned device. */
export class FakeDeviceProvisioner implements DeviceProvisioner {
  public readonly requests: DeviceMatchCriteria[] = [];
  private result: ProvisionedDevice;
  private failure: Error | null = null;

  constructor(result?: Partial<ProvisionedDevice>) {
    this.result = {
      platform: "ios",
      name: "AutoMobile-iPhone-17-abcd1234",
      deviceId: "CREATED-UDID",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      ...result,
    };
  }

  setResult(result: ProvisionedDevice): void {
    this.result = result;
  }

  setFailure(failure: Error | null): void {
    this.failure = failure;
  }

  async provision(criteria: DeviceMatchCriteria): Promise<ProvisionedDevice> {
    this.requests.push(criteria);
    if (this.failure) {
      throw this.failure;
    }
    return this.result;
  }
}

/** Simctl creation surface with scripted device types/runtime. */
export class FakeIosSimulatorCreator implements IosSimulatorCreator {
  public readonly createCalls: { name: string; deviceType: string; runtime: string }[] = [];

  constructor(
    private readonly deviceTypes: AppleDeviceType[] = [],
    private readonly runtime: string = "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    private readonly udid: string = "CREATED-UDID",
  ) {}

  async getDeviceTypes(): Promise<AppleDeviceType[]> {
    return this.deviceTypes;
  }

  async resolveRuntimeIdentifier(): Promise<string> {
    return this.runtime;
  }

  async createSimulator(name: string, deviceType: string, runtime: string): Promise<string> {
    this.createCalls.push({ name, deviceType, runtime });
    return this.udid;
  }
}

/** avdmanager creation surface with scripted installed images. */
export class FakeAndroidAvdCreator implements AndroidAvdCreator {
  public readonly createCalls: CreateAvdParams[] = [];
  public result: { success: boolean; message: string; avdName?: string } = {
    success: true,
    message: "created",
  };

  constructor(private readonly images: SystemImage[] = []) {}

  async listInstalledSystemImages(): Promise<SystemImage[]> {
    return this.images;
  }

  async createAvd(
    params: CreateAvdParams,
  ): Promise<{ success: boolean; message: string; avdName?: string }> {
    this.createCalls.push(params);
    return { ...this.result, avdName: this.result.avdName ?? params.name };
  }
}
