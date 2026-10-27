import { promises as nodeFs } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { ActionableError } from "../../models/ActionableError";
import { sortedReaddir } from "../../utils/io";
import { ensureSecureTempDirSync } from "../../utils/tempDir";
import type { VisualDeviceProfile } from "./VisualDeviceProfile";
import { visualProfileKey } from "./VisualDeviceProfile";

export interface VisualBaseline {
  name: string;
  profile: VisualDeviceProfile;
  png: Buffer;
  path: string;
  recordedAt: string;
}

/** Host-side baselines, one PNG per (name, device profile) pair (#14083). */
export interface VisualBaselineStore {
  read(name: string, profile: VisualDeviceProfile): Promise<VisualBaseline | null>;
  /** Profiles another device recorded this baseline under. */
  otherProfiles(name: string, profile: VisualDeviceProfile): Promise<VisualDeviceProfile[]>;
  write(
    name: string,
    profile: VisualDeviceProfile,
    png: Buffer,
    recordedAt: string,
  ): Promise<VisualBaseline>;
  /** Where a mismatch's diff image for this baseline goes. */
  diffPath(name: string, profile: VisualDeviceProfile): string;
}

/** Under the AutoMobile data directory; baselines persist across runs, unlike screenshots. */
export const VISUAL_BASELINES_SUBDIR = "visual-baselines";

const BASELINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertBaselineName(name: string): void {
  if (!BASELINE_NAME.test(name) || name.includes("..")) {
    throw new ActionableError(
      `Baseline name "${name}" must be 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit.`,
    );
  }
}

/** The filesystem surface the store needs; tests pass an in-memory one. */
export interface BaselineFs {
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, data: Buffer | string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
  readdir(dirPath: string): Promise<string[]>;
}

export const nodeBaselineFs: BaselineFs = {
  readFile: (filePath) => nodeFs.readFile(filePath),
  writeFile: (filePath, data) => nodeFs.writeFile(filePath, data, { mode: 0o600 }),
  mkdir: async (dirPath) => {
    await nodeFs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  },
  readdir: (dirPath) => sortedReaddir(dirPath),
};

const baselineMetadataSchema = z.object({
  profile: z.object({
    platform: z.enum(["android", "ios"]),
    width: z.number(),
    height: z.number(),
    density: z.number().nullable(),
    fontScale: z.number().nullable(),
    theme: z.string().nullable(),
  }),
  recordedAt: z.string(),
});

type BaselineMetadata = z.infer<typeof baselineMetadataSchema>;

function parseMetadata(text: string): BaselineMetadata {
  return baselineMetadataSchema.parse(JSON.parse(text));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * `<root>/<name>/<profileKey>.png` plus a `.json` sidecar holding the profile, so a baseline
 * recorded on one configuration is never silently compared on another.
 */
export class FileVisualBaselineStore implements VisualBaselineStore {
  constructor(
    private readonly root: () => string = () => ensureSecureTempDirSync(VISUAL_BASELINES_SUBDIR),
    private readonly fs: BaselineFs = nodeBaselineFs,
  ) {}

  private paths(name: string, profile: VisualDeviceProfile) {
    assertBaselineName(name);
    const dir = path.join(this.root(), name);
    const key = visualProfileKey(profile);
    return {
      dir,
      png: path.join(dir, `${key}.png`),
      meta: path.join(dir, `${key}.json`),
      diff: path.join(dir, `${key}.diff.png`),
    };
  }

  async read(name: string, profile: VisualDeviceProfile): Promise<VisualBaseline | null> {
    const paths = this.paths(name, profile);
    try {
      const [png, meta] = await Promise.all([
        this.fs.readFile(paths.png),
        this.fs.readFile(paths.meta),
      ]);
      const metadata = parseMetadata(meta.toString("utf8"));
      return { name, profile, png, path: paths.png, recordedAt: metadata.recordedAt };
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async otherProfiles(name: string, profile: VisualDeviceProfile): Promise<VisualDeviceProfile[]> {
    const { dir } = this.paths(name, profile);
    const key = visualProfileKey(profile);
    let entries: string[];
    try {
      entries = await this.fs.readdir(dir);
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
    const sidecars = entries.filter((entry) => entry.endsWith(".json") && entry !== `${key}.json`);
    const metadata = await Promise.all(
      sidecars.map(async (entry) =>
        parseMetadata((await this.fs.readFile(path.join(dir, entry))).toString("utf8")),
      ),
    );
    return metadata.map((entry) => entry.profile);
  }

  async write(
    name: string,
    profile: VisualDeviceProfile,
    png: Buffer,
    recordedAt: string,
  ): Promise<VisualBaseline> {
    const paths = this.paths(name, profile);
    await this.fs.mkdir(paths.dir);
    await this.fs.writeFile(paths.png, png);
    const metadata: BaselineMetadata = { profile, recordedAt };
    await this.fs.writeFile(paths.meta, `${JSON.stringify(metadata, null, 2)}\n`);
    return { name, profile, png, path: paths.png, recordedAt };
  }

  diffPath(name: string, profile: VisualDeviceProfile): string {
    return this.paths(name, profile).diff;
  }
}
