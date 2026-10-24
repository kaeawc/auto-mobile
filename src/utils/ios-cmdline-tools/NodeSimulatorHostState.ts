import * as fs from "node:fs/promises";
import { defaultIdGenerator, type IdGenerator } from "../IdGenerator";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { PlistClient, type PlistReader, type PlistWriter } from "./PlistClient";

export interface SimulatorHostState {
  mkdirPrivate(path: string): Promise<void>;
  readExisting(path: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  writeBinaryPlist(
    path: string,
    value: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void>;
  rmDir(path: string): Promise<void>;
}

export interface SimulatorHostFiles {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; uid: number }>;
  access(path: string): Promise<void>;
  writeFile(path: string, contents: string, options: { mode: number; flag: "wx" }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force?: boolean; recursive?: boolean }): Promise<void>;
}

export class NodeSimulatorHostState implements SimulatorHostState {
  constructor(
    private readonly plist: Pick<PlistReader, "readJsonFile"> &
      Pick<PlistWriter, "writeBinaryFromJson"> = new PlistClient(),
    private readonly files: SimulatorHostFiles = fs,
    private readonly ids: IdGenerator = defaultIdGenerator,
    private readonly uid: () => number | undefined = () => process.getuid?.(),
  ) {}
  async mkdirPrivate(path: string): Promise<void> {
    await this.files.mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await this.files.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid()) {
      throw new Error("Simulator host state must be a directory owned by the current user");
    }
  }
  async readExisting(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      // Check existence before plutil wraps OS errors in an ActionableError.
      await this.files.access(path);
    } catch (error) {
      if (!isMissingSimulatorHostState(error)) {
        throw error;
      }
      // First-boot databases normally do not exist yet; there is nothing to merge.
      logger.debug(`No existing simulator disabled database at ${path}`);
      return {};
    }
    const value = await this.plist.readJsonFile(path, { signal });
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Simulator disabled database must be a plist dictionary");
    }
    return value as Record<string, unknown>;
  }
  async writeBinaryPlist(
    path: string,
    value: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const temporary = `${path}.${this.ids.next()}.tmp`;
    await this.files.writeFile(temporary, "", { mode: 0o600, flag: "wx" });
    try {
      await this.plist.writeBinaryFromJson(temporary, value, { signal });
      signal?.throwIfAborted();
      await this.files.rename(temporary, path);
    } finally {
      try {
        await this.files.rm(temporary, { force: true });
      } catch (error) {
        logger.warn(
          `Failed to remove temporary simulator disabled database: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }
  async rmDir(path: string): Promise<void> {
    await this.files.rm(path, { recursive: true });
  }
}

export function isMissingSimulatorHostState(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
