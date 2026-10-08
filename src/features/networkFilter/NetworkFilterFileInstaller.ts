import path from "node:path";
import { ActionableError } from "../../models/ActionableError";
import {
  DefaultNetworkFilterCommandRunner,
  NodeNetworkFilterFileSystem,
  type NetworkFilterCommandRunner,
  type NetworkFilterFileSystem,
} from "./networkFilterHost";

/**
 * Seam for the one host-mutating copy (#10588): placing the verified app in
 * `/Applications`. Unit tests always inject a fake.
 */
export interface FileInstaller {
  exists(destination: string): Promise<boolean>;
  /** Copy `source` to `destination`, replacing an existing copy only when `replace` is true. */
  install(source: string, destination: string, options: { replace: boolean }): Promise<void>;
}

const DITTO_TIMEOUT_MS = 120_000;

/**
 * Copies with `ditto` into a sibling staging path first, so a failed copy never
 * leaves a half-written app at the destination.
 */
export class DittoFileInstaller implements FileInstaller {
  constructor(
    private readonly runner: NetworkFilterCommandRunner = new DefaultNetworkFilterCommandRunner(),
    private readonly fileSystem: NetworkFilterFileSystem = new NodeNetworkFilterFileSystem(),
  ) {}

  async exists(destination: string): Promise<boolean> {
    return this.fileSystem.isDirectory(destination);
  }

  async install(source: string, destination: string, options: { replace: boolean }): Promise<void> {
    if (!options.replace && (await this.exists(destination))) {
      throw new ActionableError(`Refusing to overwrite the existing ${destination}.`);
    }
    const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.partial`);
    await this.fileSystem.remove(staging);
    const copy = await this.runner.run("ditto", [source, staging], { timeoutMs: DITTO_TIMEOUT_MS });
    if (copy.exitCode !== 0) {
      await this.fileSystem.remove(staging);
      throw new ActionableError(
        `Unable to copy the Network Extension app to ${path.dirname(destination)} ` +
          `(ditto exit ${copy.exitCode}): ${copy.stderr.trim() || "no output"}. ` +
          "Installing into /Applications needs an administrator account.",
      );
    }
    await this.fileSystem.remove(destination);
    await this.fileSystem.rename(staging, destination);
  }
}
