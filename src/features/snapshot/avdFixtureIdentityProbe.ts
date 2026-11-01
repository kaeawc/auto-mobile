import { createHash } from "node:crypto";
import { join } from "node:path";
import { ActionableError } from "../../models/ActionableError";
import type {
  AvdConfigReader,
  AvdDirectoryResolver,
} from "../../utils/android-cmdline-tools/AvdConfigReader";
import type { FixtureIdentity, FixtureIdentityProbe } from "./fixtureIdentity";

/** The userdata image the emulator re-creates on `-wipe-data`. */
export const USERDATA_IMAGE = "userdata-qemu.img";

/** The host reads an AVD fixture identity needs; each is injectable so tests use fakes. */
export interface AvdFixtureIdentityDeps {
  config: Pick<AvdConfigReader, "readConfig">;
  avdDirectory: Pick<AvdDirectoryResolver, "resolveAvdDirectory">;
  /** The installed system image's `source.properties`, by its SDK-relative path. */
  imageMetadata(imagePath: string): Promise<string>;
  /** Output of `emulator -version`. */
  emulatorVersion(): Promise<string>;
  /** The userdata image the AVD's emulator runs; defaults to the AVD's own. */
  userdataImage?(avdDirectory: string): string;
  /** Inode and birth time of a host file, or null when it does not exist. */
  fileIdentity(path: string): Promise<{ ino: number; birthtimeMs: number } | null>;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Reads what a captured fixture snapshot depends on (#14065), the same inputs the broker's
 * baseline identity uses: the system image package and its installed metadata, the AVD's
 * hardware config, and the emulator version. It adds the userdata image's identity, so a
 * `-wipe-data` between capture and reload is reported instead of reloading a discarded state.
 */
export class AvdFixtureIdentityProbe implements FixtureIdentityProbe {
  constructor(private readonly deps: AvdFixtureIdentityDeps) {}

  async currentIdentity(avdName: string): Promise<FixtureIdentity> {
    const directory = await this.deps.avdDirectory.resolveAvdDirectory(avdName);
    if (!directory) {
      throw new ActionableError(`AVD '${avdName}' is not on this host`);
    }
    const config = await this.deps.config.readConfig(avdName);
    if (!config?.systemImagePackage || !config.systemImagePath) {
      throw new ActionableError(`AVD '${avdName}' lacks system-image metadata in config.ini`);
    }
    const metadata = await this.deps.imageMetadata(config.systemImagePath);
    const version = (await this.deps.emulatorVersion()).split("\n")[0]?.trim() ?? "";
    if (!version) {
      throw new ActionableError("Could not read the emulator version for the fixture identity");
    }
    const userdataImage = this.deps.userdataImage?.(directory) ?? join(directory, USERDATA_IMAGE);
    const userdata = await this.deps.fileIdentity(userdataImage);
    return {
      avdName,
      systemImageId: `${config.systemImagePackage}:${sha256(metadata)}`,
      avdConfigHash: sha256(JSON.stringify(config.hardware ?? {})),
      emulatorVersion: version,
      userdataGeneration: userdata ? `${userdata.ino}:${userdata.birthtimeMs}` : "none",
    };
  }
}
