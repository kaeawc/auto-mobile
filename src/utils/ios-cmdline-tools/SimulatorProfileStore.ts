import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AMBIENT_ENV, readEnvTrimmed } from "../../config/env";
import { defaultIdGenerator, type IdGenerator } from "../IdGenerator";
import { resolveAutoMobileBaseDir } from "../tempDir";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

/** Raw storage seam: parsing and cache policy remain identical for disk and memory. */
export interface SimulatorProfileStore {
  currentKey(): Promise<string | null>;
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

const profileSchema = z.object({
  deviceTypeId: z.string(),
  productFamily: z.string().nullable(),
  modelIdentifier: z.string().nullable(),
  pixelWidth: z.number().finite().nullable(),
  pixelHeight: z.number().finite().nullable(),
  scale: z.number().finite().nullable(),
  dpi: z.number().finite().nullable(),
});

export const simulatorProfileCacheSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  deviceTypes: z.array(
    z.object({
      identifier: z.string(),
      bundlePath: z.string(),
      name: z.string(),
      productFamily: z.string(),
      modelIdentifier: z.string().optional(),
      minRuntimeVersion: z.number(),
      maxRuntimeVersion: z.number(),
      minRuntimeVersionString: z.string().optional(),
      maxRuntimeVersionString: z.string().optional(),
    }),
  ),
  profiles: z.array(profileSchema),
});

/** Optional cache only; all filesystem failures are handled by the enrichment owner. */
export class FileSimulatorProfileStore implements SimulatorProfileStore {
  constructor(
    private readonly directory: () => string = resolveAutoMobileBaseDir,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  async currentKey(): Promise<string | null> {
    // xcode-select maintains this symlink. DEVELOPER_DIR overrides it, including
    // the supported Xcode.app shorthand. Never spawn xcode-select or plutil.
    const selected = await fs.realpath(
      readEnvTrimmed(AMBIENT_ENV.DEVELOPER_DIR, this.env) || "/var/db/xcode_select_link",
    );
    const developer = selected.endsWith(".app")
      ? path.join(selected, "Contents/Developer")
      : selected;
    const versionPath = path.resolve(developer, "../version.plist");
    const [directory, version] = await Promise.all([fs.stat(developer), fs.stat(versionPath)]);
    return JSON.stringify([
      developer,
      directory.mtimeMs,
      version.mtimeMs,
      version.ctimeMs,
      version.size,
    ]);
  }

  async read(): Promise<string> {
    return fs.readFile(path.join(this.directory(), "simulator-device-type-profiles.json"), "utf8");
  }

  async write(contents: string): Promise<void> {
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, "simulator-device-type-profiles.json");
    const temporary = `${destination}.${this.ids.next()}.tmp`;
    try {
      await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, destination);
    } finally {
      try {
        await fs.rm(temporary, { force: true });
      } catch (error) {
        // A leftover optional cache temporary file cannot affect discovery.
        logger.debug(`Failed to remove simulator profile temporary file: ${errorMessage(error)}`);
      }
    }
  }
}
