import { XcodeSigningManager } from "../../src/utils/ios-cmdline-tools/XcodeSigning";

type SigningResolution = Awaited<ReturnType<XcodeSigningManager["resolveSigningForDevice"]>>;

const EMPTY_SIGNING: SigningResolution = {
  style: "automatic",
  buildSettings: [],
  allowProvisioningUpdates: false,
  warnings: [],
};

/** XcodeSigningManager that resolves a fixed signing result without reading profiles or the keychain. */
export class FakeXcodeSigningManager extends XcodeSigningManager {
  constructor(private readonly resolution: SigningResolution = EMPTY_SIGNING) {
    super();
  }

  override async resolveSigningForDevice(): Promise<SigningResolution> {
    return this.resolution;
  }
}
