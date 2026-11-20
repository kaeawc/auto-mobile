import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod/v3";
import type { RotationRestoreState } from "../features/action/RotationSupport";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import { sortedReaddir } from "../utils/io";
import { resolveAutoMobileBaseDir } from "../utils/tempDir";
import { sameRotationOriginals, type RotationOriginalsLedger } from "./rotationOriginalsLedger";

const recordSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1),
  state: z.object({
    accelerometerRotation: z.union([z.literal(0), z.literal(1), z.null()]),
    userRotation: z.number().int().nullable(),
    deviceStateRotationLock: z.string().optional(),
    deviceStateRotationLockState: z.number().int().optional(),
  }),
});

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/** One JSON file per device under `<data dir>/rotation-originals/`. */
export class FileRotationOriginalsLedger implements RotationOriginalsLedger {
  constructor(
    private readonly directory: () => string = () =>
      path.join(resolveAutoMobileBaseDir(), "rotation-originals"),
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  async loadAll(): Promise<ReadonlyMap<string, RotationRestoreState>> {
    const records = new Map<string, RotationRestoreState>();
    let names: string[];
    try {
      names = await sortedReaddir(this.directory());
    } catch (error) {
      if (isMissing(error)) {
        return records;
      }
      throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const file = path.join(this.directory(), name);
      const record = await this.read(file);
      if (record) {
        records.set(record.deviceId, record.state);
      }
    }
    return records;
  }

  async save(deviceId: string, state: RotationRestoreState): Promise<boolean> {
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = this.fileFor(deviceId);
    const temporary = `${destination}.${this.ids.next()}.tmp`;
    const contents = JSON.stringify({ version: 1, deviceId, state });
    try {
      await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      // link() is atomic and fails when the destination exists, so the oldest record wins.
      await fs.link(temporary, destination);
      return true;
    } catch (error) {
      if (isExisting(error)) {
        return false;
      }
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async clear(deviceId: string, state: RotationRestoreState): Promise<void> {
    const file = this.fileFor(deviceId);
    const record = await this.read(file);
    if (record && sameRotationOriginals(record.state, state)) {
      await fs.rm(file, { force: true });
    }
  }

  async remove(deviceId: string): Promise<void> {
    await fs.rm(this.fileFor(deviceId), { force: true });
  }

  private fileFor(deviceId: string): string {
    return path.join(this.directory(), `${encodeURIComponent(deviceId)}.json`);
  }

  private async read(file: string): Promise<z.infer<typeof recordSchema> | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
    try {
      return recordSchema.parse(JSON.parse(raw));
    } catch (error) {
      // An unreadable record cannot be restored; drop it so it does not block later saves.
      logger.warn(
        `Dropping unreadable rotation originals record ${file}: ${errorMessage(error)}`,
        error,
      );
      await fs.rm(file, { force: true });
      return undefined;
    }
  }
}
