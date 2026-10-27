import { z } from "zod";
import { logger } from "../../utils/logger";
import { toActionableError } from "../../models/ActionableError";
import { readFileSync, rmSync } from "node:fs";
import { sortedReaddirSync } from "../../utils/io";
import { join } from "node:path";
import { writeJsonFileAtomicSync } from "../../daemon/atomicJsonFile";
import { ensureSecureDirectorySync, getHostGlobalAutoMobileDir } from "../../utils/tempDir";
import {
  templateKeyHash,
  type SimulatorTemplateKey,
} from "../../utils/ios-cmdline-tools/SimulatorTemplateKey";
import {
  templateManifestSchema,
  type SimulatorTemplateManifest,
  type SimulatorTemplateManifestStore,
} from "./SimulatorTemplateManifestStore";
export interface TemplateManifestFiles {
  read(path: string): string | undefined;
  write(path: string, value: SimulatorTemplateManifest): void;
  remove(path: string): void;
  list(directory: string): string[];
}
const nodeFiles: TemplateManifestFiles = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // A missing manifest means this template has not been built yet.
        logger.debug(`Template manifest is absent: ${path}`, error);
        return undefined;
      }
      throw toActionableError(error, `Could not read template manifest ${path}`);
    }
  },
  write: (path, value) => writeJsonFileAtomicSync(path, value),
  remove: (path) => rmSync(path, { force: true }),
  list: (directory) =>
    sortedReaddirSync(directory).filter((name) => /^[a-f0-9]{8}\.json$/.test(name)),
};
export class FileSimulatorTemplateManifestStore implements SimulatorTemplateManifestStore {
  constructor(
    private readonly files: TemplateManifestFiles = nodeFiles,
    private readonly directory: () => string = () =>
      ensureSecureDirectorySync(getHostGlobalAutoMobileDir("ios-sim-templates")),
  ) {}
  private path(key: SimulatorTemplateKey): string {
    return join(this.directory(), `${templateKeyHash(key)}.json`);
  }
  async read(key: SimulatorTemplateKey): Promise<SimulatorTemplateManifest | undefined> {
    const value = this.files.read(this.path(key));
    if (value === undefined) {
      return undefined;
    }
    const manifest = this.parse(value, `${templateKeyHash(key)}.json`);
    if (
      manifest &&
      Object.entries(key).some(([field, expected]) => Reflect.get(manifest.key, field) !== expected)
    ) {
      logger.warn("Ignoring template manifest with mismatched key inputs");
      return undefined;
    }
    return manifest;
  }
  private parse(value: string, name: string): SimulatorTemplateManifest | undefined {
    try {
      const result = templateManifestSchema.safeParse(JSON.parse(value));
      if (!result.success || `${templateKeyHash(result.data.key)}.json` !== name) {
        logger.warn(`Ignoring invalid template manifest ${name}`);
        return undefined;
      }
      return result.data;
    } catch (error) {
      logger.warn(`Ignoring unreadable template manifest ${name}`, error);
      return undefined;
    }
  }
  async write(manifest: SimulatorTemplateManifest): Promise<void> {
    this.files.write(this.path(manifest.key), manifest);
  }
  async remove(key: SimulatorTemplateKey): Promise<void> {
    this.files.remove(this.path(key));
  }
  async removeInvalid(runtime?: string): Promise<void> {
    const directory = this.directory();
    for (const name of this.files.list(directory)) {
      const path = join(directory, name);
      const value = this.files.read(path);
      if (value === undefined || this.parse(value, name)) {
        continue;
      }
      if (runtime && !this.matchesRuntime(value, runtime)) {
        continue;
      }
      this.files.remove(path);
    }
  }
  private matchesRuntime(value: string, runtime: string): boolean {
    try {
      const found = z
        .object({ key: z.object({ runtime: z.string() }) })
        .safeParse(JSON.parse(value)).data?.key.runtime;
      return found === undefined || found === runtime;
    } catch (error) {
      logger.warn("Removing corrupt template manifest with unreadable runtime metadata", error);
      return true;
    }
  }
  async list(): Promise<SimulatorTemplateManifest[]> {
    const directory = this.directory();
    return this.files.list(directory).flatMap((name) => {
      const value = this.files.read(join(directory, name));
      const manifest = value === undefined ? undefined : this.parse(value, name);
      return manifest ? [manifest] : [];
    });
  }
}
