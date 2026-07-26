import { SystemDetection, DefaultSystemDetection } from "../system/SystemDetection";
import { logger } from "../logger";

/**
 * Detects whether the iOS prerequisites needed to consume a CtrlProxy runner
 * bundle are present. Used to gate startup-time work (e.g. the runner-bundle
 * prefetch) so hosts without a usable Xcode toolchain don't do unnecessary
 * network/disk work.
 */
export interface IosPrerequisiteDetector {
  /**
   * Resolve to true when iOS device work is possible in this environment.
   * The runner is installed via `xcrun simctl`/`devicectl` and run via
   * `xcodebuild test-without-building`, so either tool being runnable is taken
   * as the minimum signal that the Xcode toolchain is present.
   */
  hasIosPrerequisites(): Promise<boolean>;
}

/**
 * Default Xcode-toolchain detector. iOS device work only runs on macOS and
 * fundamentally needs `xcrun` (simctl/devicectl) and `xcodebuild`. Probing
 * either cheaply is enough to know the toolchain exists; a host with neither
 * cannot consume the runner regardless.
 */
export class DefaultIosPrerequisiteDetector implements IosPrerequisiteDetector {
  private readonly systemDetection: SystemDetection;

  constructor(systemDetection: SystemDetection = new DefaultSystemDetection()) {
    this.systemDetection = systemDetection;
  }

  async hasIosPrerequisites(): Promise<boolean> {
    // iOS device work only runs on macOS.
    if (this.systemDetection.getCurrentPlatform() !== "darwin") {
      return false;
    }

    // Either tool being runnable proves an Xcode toolchain is installed. Skip
    // only when neither works — the clear "no iOS tooling" case.
    if (await this.canRun("xcrun", ["--version"])) {
      return true;
    }
    return this.canRun("xcodebuild", ["-version"]);
  }

  private async canRun(file: string, args: string[]): Promise<boolean> {
    try {
      await this.systemDetection.executeCommand(file, args);
      return true;
    } catch (error) {
      // A non-zero exit / missing binary is a normal "not available", not a fault.
      logger.debug(`[IOS_PREREQ] probe failed for '${file} ${args.join(" ")}': ${error}`, error);
      return false;
    }
  }
}
