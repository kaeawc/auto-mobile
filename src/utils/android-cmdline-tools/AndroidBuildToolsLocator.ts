import { join, dirname } from "path";
import { FileSystem, DefaultFileSystem } from "../filesystem/DefaultFileSystem";
import { SystemDetection, DefaultSystemDetection } from "../system/SystemDetection";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import {
  getAndroidSdkFromEnvironment,
  getTypicalAndroidSdkPaths,
  isToolInPath,
  getToolPathFromPath,
} from "./detection";

type AaptToolName = "aapt2" | "aapt";

export interface AaptToolLocation {
  tool: AaptToolName;
  path: string;
}

export interface AndroidBuildToolsLocator {
  findAaptTool(): Promise<AaptToolLocation | null>;
}

export class DefaultAndroidBuildToolsLocator implements AndroidBuildToolsLocator {
  private fileSystem: FileSystem;
  private systemDetection: SystemDetection;

  constructor(
    fileSystem: FileSystem = new DefaultFileSystem(),
    systemDetection: SystemDetection = new DefaultSystemDetection(),
  ) {
    this.fileSystem = fileSystem;
    this.systemDetection = systemDetection;
  }

  async findAaptTool(): Promise<AaptToolLocation | null> {
    const aapt2FromPath = await this.findToolInPath("aapt2");
    if (aapt2FromPath) {
      return aapt2FromPath;
    }

    const aapt2FromSdk = await this.findToolInBuildTools("aapt2");
    if (aapt2FromSdk) {
      return aapt2FromSdk;
    }

    const aaptFromPath = await this.findToolInPath("aapt");
    if (aaptFromPath) {
      return aaptFromPath;
    }

    return this.findToolInBuildTools("aapt");
  }

  async findStampTools(): Promise<AndroidStampTools | null> {
    const tools = await this.findCompleteStampBuildTools();
    if (!tools) {
      return null;
    }
    const androidJar = await this.findAndroidJar();
    return androidJar ? { ...tools, androidJar } : null;
  }

  /** The newest build-tools directory holding aapt2, zipalign and apksigner together. */
  private async findCompleteStampBuildTools(): Promise<StampBuildTools | null> {
    for (const { path } of await this.listVersionDirectories("build-tools")) {
      const tools = this.completeStampBuildTools(path);
      if (tools) {
        return tools;
      }
    }
    const fromPath = await this.findToolInPath("aapt2");
    return fromPath ? this.completeStampBuildTools(dirname(fromPath.path)) : null;
  }

  private completeStampBuildTools(directory: string): StampBuildTools | null {
    const windows = this.systemDetection.getCurrentPlatform() === "win32";
    const tools = {
      aapt2: join(directory, this.getToolFileName("aapt2")),
      zipalign: join(directory, windows ? "zipalign.exe" : "zipalign"),
      apksigner: join(directory, windows ? "apksigner.bat" : "apksigner"),
    };
    return Object.values(tools).every((path) => this.fileSystem.existsSync(path)) ? tools : null;
  }

  private async findAndroidJar(): Promise<string | null> {
    for (const { path } of await this.listVersionDirectories("platforms")) {
      const androidJar = join(path, "android.jar");
      if (this.fileSystem.existsSync(androidJar)) {
        return androidJar;
      }
    }
    return null;
  }

  private async findToolInPath(tool: AaptToolName): Promise<AaptToolLocation | null> {
    if (!(await isToolInPath(tool, this.systemDetection))) {
      return null;
    }

    const toolPath = await getToolPathFromPath(tool, this.systemDetection);
    if (!toolPath) {
      return null;
    }

    return { tool, path: toolPath };
  }

  private async findToolInBuildTools(tool: AaptToolName): Promise<AaptToolLocation | null> {
    for (const { path } of await this.listVersionDirectories("build-tools")) {
      const toolPath = join(path, this.getToolFileName(tool));
      if (this.fileSystem.existsSync(toolPath)) {
        return { tool, path: toolPath };
      }
    }
    return null;
  }

  /** Versioned subdirectories of `<sdk>/<kind>` across every SDK root, newest first per root. */
  private async listVersionDirectories(
    kind: "build-tools" | "platforms",
  ): Promise<Array<{ path: string }>> {
    const directories: Array<{ path: string }> = [];
    for (const sdkRoot of this.getSdkRoots()) {
      const parent = join(sdkRoot, kind);
      if (!this.fileSystem.existsSync(parent)) {
        continue;
      }
      const versions = await this.readVersions(parent, kind);
      directories.push(...versions.map((version) => ({ path: join(parent, version) })));
    }
    return directories;
  }

  private async readVersions(parent: string, kind: string): Promise<string[]> {
    try {
      return this.sortVersionsDescending(await this.fileSystem.readdir(parent));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        // An optional SDK directory may disappear between the existence check and enumeration.
        logger.debug(
          `[AndroidBuildToolsLocator] ${kind} directory disappeared: ${errorMessage(error)}`,
        );
      } else {
        logger.warn(
          `[AndroidBuildToolsLocator] Failed to read ${kind} directory: ${errorMessage(error)}`,
        );
      }
      return [];
    }
  }

  private getSdkRoots(): string[] {
    const roots: string[] = [];
    const envSdk = getAndroidSdkFromEnvironment(this.systemDetection);
    if (envSdk) {
      roots.push(envSdk);
    }

    for (const candidate of getTypicalAndroidSdkPaths(this.systemDetection)) {
      if (!roots.includes(candidate)) {
        roots.push(candidate);
      }
    }

    return roots;
  }

  private getToolFileName(tool: AaptToolName): string {
    return this.systemDetection.getCurrentPlatform() === "win32" ? `${tool}.exe` : tool;
  }

  private sortVersionsDescending(versions: string[]): string[] {
    return [...versions].sort((left, right) => {
      const leftParts = this.parseVersion(left);
      const rightParts = this.parseVersion(right);
      const maxLength = Math.max(leftParts.length, rightParts.length);

      for (let index = 0; index < maxLength; index += 1) {
        const leftValue = leftParts[index] ?? 0;
        const rightValue = rightParts[index] ?? 0;

        if (leftValue !== rightValue) {
          return rightValue - leftValue;
        }
      }

      return right.localeCompare(left);
    });
  }

  /**
   * Sort key for a build-tools or platform directory name. An SDK-extension
   * platform (`android-33-ext5`) sorts by its API level first and its extension
   * level last, so it never outranks a newer API level such as `android-37.0`.
   */
  private parseVersion(version: string): number[] {
    const [release, extension] = version.split(/-ext/i, 2);
    const releaseParts = release
      .split(".")
      .map((part) => Number.parseInt(part.replace(/\D/g, ""), 10))
      .map((value) => (Number.isNaN(value) ? 0 : value));
    if (extension === undefined) {
      return releaseParts;
    }
    const extensionLevel = Number.parseInt(extension.replace(/\D/g, ""), 10);
    // Pad the release to a fixed width so the extension level is compared only on a tie.
    const paddedRelease = [...releaseParts, 0, 0, 0].slice(0, Math.max(releaseParts.length, 3));
    return [...paddedRelease, Number.isNaN(extensionLevel) ? 0 : extensionLevel];
  }
}

export interface AndroidStampTools {
  aapt2: string;
  zipalign: string;
  apksigner: string;
  androidJar: string;
}
type StampBuildTools = Omit<AndroidStampTools, "androidJar">;
export interface AndroidStampToolsLocator {
  findStampTools(): Promise<AndroidStampTools | null>;
}
