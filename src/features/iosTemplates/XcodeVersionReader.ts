import { logger } from "../../utils/logger";
import { ActionableError } from "../../models/ActionableError";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
export interface XcodeVersionReader {
  readBuild(signal?: AbortSignal): Promise<string>;
}
export class CommandXcodeVersionReader implements XcodeVersionReader {
  private cached?: Promise<string>;
  constructor(
    private readonly client: Pick<Xcodebuild, "executeCommand"> = new XcodebuildClient(),
  ) {}
  readBuild(signal?: AbortSignal): Promise<string> {
    this.cached ??= this.probe(signal).catch((error) => {
      logger.warn("Xcode build is unknown; template cloning disabled for this process", error);
      return "unknown";
    });
    return this.cached;
  }
  private async probe(signal?: AbortSignal): Promise<string> {
    const { stdout } = await this.client.executeCommand(["-version"], { signal, timeoutMs: 5_000 });
    const line = stdout.split("\n").find((value) => value.startsWith("Build version "));
    const build = line?.slice("Build version ".length).trim();
    if (!build) {
      throw new ActionableError("Xcode did not report a build version. Check xcode-select.");
    }
    return build;
  }
}
