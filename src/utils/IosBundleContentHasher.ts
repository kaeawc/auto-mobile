import type { BootedDevice } from "../models";
import { type AppMetadataReader } from "./IosAppMetadataReader";
import { hashAppBundle } from "./ios-cmdline-tools/AppBundleHasher";
import { toActionableError } from "../models/ActionableError";
import type { AppContentHasher } from "./ContentHashProvider";

/**
 * iOS: hash the installed app bundle bytes via the shared {@link hashAppBundle}
 * (which already excludes signature/provisioning files, so re-signing identical
 * content yields the same hash). Simulator bundles are host-filesystem dirs.
 */
export class IosBundleContentHasher implements AppContentHasher {
  constructor(private readonly metadata: AppMetadataReader) {}

  async computeHash(_device: BootedDevice, packageId: string): Promise<string> {
    const meta = await this.metadata.execute(packageId);
    const bundlePath = meta?.installPath;
    if (!bundlePath) {
      throw toActionableError(
        new Error(`No bundlePath for ${packageId}`),
        `Cannot resolve app bundle path for ${packageId}`,
      );
    }
    return hashAppBundle(bundlePath);
  }
}
