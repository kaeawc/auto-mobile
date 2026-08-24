import { join } from "path";
import { SystemDetection, DefaultSystemDetection } from "../system/SystemDetection";
import {
  isToolInPath,
  getAndroidSdkFromEnvironment,
  detectAndroidSdkTools,
  detectHomebrewAndroidTools,
} from "./detection";

/**
 * Detects whether the Android prerequisites needed to consume a CtrlProxy APK
 * are present. Used to gate startup-time work (e.g. the APK prefetch) so
 * environments without Android tooling don't do unnecessary network/disk work.
 */
export interface AndroidPrerequisiteDetector {
  /**
   * Resolve to true when Android device work is possible in this environment.
   * The minimum requirement is ADB; SDK tooling is accepted as a positive signal.
   */
  hasAndroidPrerequisites(): Promise<boolean>;
}

/**
 * Default ADB-centric detector. Android device work fundamentally needs ADB to
 * install and talk to the APK, so ADB availability is the minimum gate. An SDK
 * install (env var or detected cmdline-tools) implies bundled platform-tools and
 * is treated as a positive signal too.
 */
export class DefaultAndroidPrerequisiteDetector implements AndroidPrerequisiteDetector {
  private readonly systemDetection: SystemDetection;

  constructor(systemDetection: SystemDetection = new DefaultSystemDetection()) {
    this.systemDetection = systemDetection;
  }

  async hasAndroidPrerequisites(): Promise<boolean> {
    // 1. ADB on PATH is the strongest signal the APK can be consumed.
    if (await isToolInPath("adb", this.systemDetection)) {
      return true;
    }

    // 2. An SDK env var pointing at a real platform-tools/adb binary.
    const sdkPath = getAndroidSdkFromEnvironment(this.systemDetection);
    if (sdkPath) {
      const adbBinary = this.systemDetection.getCurrentPlatform() === "win32" ? "adb.exe" : "adb";
      if (this.systemDetection.fileExistsSync(join(sdkPath, "platform-tools", adbBinary))) {
        return true;
      }
    }

    // 3. A detected cmdline-tools installation implies an SDK (and its bundled
    //    platform-tools/adb) is present. Use the uncached detectors directly so
    //    this gate never reads or writes the shared detection cache.
    const homebrew = await detectHomebrewAndroidTools(this.systemDetection);
    if (homebrew) {
      return true;
    }
    const sdkLocations = await detectAndroidSdkTools(this.systemDetection);
    return sdkLocations.length > 0;
  }
}
