import {
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { z } from "zod";
import { DAEMON_VERSION } from "./constants";
import { writePrivateJsonFileAtomicSync } from "./atomicJsonFile";
import { PsDaemonProcessFinder, type DaemonProcessLivenessChecker } from "./processTable";
import {
  currentDaemonProcessGenerationToken,
  compareProcessGenerationTokens,
} from "./processGeneration";
import {
  processGenerationRecordFields,
  recordedProcessGenerationToken,
} from "./processGenerationFields";
import { AuxiliarySocketHeldError } from "./AuxiliarySocketHeldError";
import { logger } from "../utils/logger";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { removeOwnedFileSync } from "./ownedFileRemoval";

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  version: z
    .string()
    .min(1)
    .max(64)
    .refine((version) => !/[^0-9A-Za-z.+_-]/.test(version)),
  socketName: z.string(),
  socketPath: z.string(),
  dev: z.number(),
  ino: z.number(),
  processGenerationToken: z.string().optional(),
  processGenerationTokenUtc: z.string().optional(),
});
type OwnerRecord = z.infer<typeof ownerSchema>;
export interface AuxiliarySocketOwnerFiles {
  read(path: string): string;
  lstat(path: string): { isFile(): boolean; size: number };
  write(path: string, record: OwnerRecord): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  copyExclusive(from: string, to: string): void;
  stat(path: string): { dev: number; ino: number };
}
const defaultFiles: AuxiliarySocketOwnerFiles = {
  read: (path) => readFileSync(path, "utf8"),
  lstat: lstatSync,
  write: writePrivateJsonFileAtomicSync,
  remove: unlinkSync,
  rename: renameSync,
  link: linkSync,
  copyExclusive: (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL),
  stat: statSync,
};

/** Path-scoped metadata; no namespace PID file and no process-signaling capability. */
export class AuxiliarySocketOwner {
  private published: OwnerRecord | undefined;
  constructor(
    private readonly files: AuxiliarySocketOwnerFiles = defaultFiles,
    private readonly processes: DaemonProcessLivenessChecker = new PsDaemonProcessFinder(),
    private readonly identity = () => ({
      pid: process.pid,
      version: DAEMON_VERSION,
      ...processGenerationRecordFields(currentDaemonProcessGenerationToken()),
    }),
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  publish(socketPath: string, socketName: string, identity: { dev: number; ino: number }): void {
    const record = ownerSchema.parse({ ...this.identity(), socketPath, socketName, ...identity });
    this.files.write(`${socketPath}.owner.json`, record);
    this.published = record;
  }

  /** Called synchronously while the bind's socket inode still belongs to us. */
  remove(socketPath: string): void {
    const record = this.read(socketPath);
    const published = this.published;
    if (!published || JSON.stringify(record) !== JSON.stringify(published)) {
      return;
    }
    try {
      const current = this.files.stat(socketPath);
      if (current.dev === published.dev && current.ino === published.ino) {
        removeOwnedFileSync(
          `${socketPath}.owner.json`,
          (claimedPath) =>
            JSON.stringify(this.read(socketPath, claimedPath)) === JSON.stringify(published),
          this.files,
          this.ids,
        );
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // The socket can disappear during close; absent paths need no further cleanup.
        logger.debug("Auxiliary socket owner cleanup path already absent", error);
        return;
      }
      logger.warn("Unable to remove auxiliary socket owner record", error);
    }
  }

  conflict(socketPath: string, socketName: string): AuxiliarySocketHeldError {
    try {
      return this.identifyConflict(socketPath, socketName);
    } catch (error) {
      logger.warn(`Unable to verify auxiliary socket holder at ${socketPath}: ${error}`, error);
      return new AuxiliarySocketHeldError(socketPath, socketName, { holderVerified: false });
    }
  }

  private identifyConflict(socketPath: string, socketName: string): AuxiliarySocketHeldError {
    const record = this.read(socketPath);
    if (
      !record ||
      record.socketName !== socketName ||
      !this.processes.isProcessRunning(record.pid)
    ) {
      return new AuxiliarySocketHeldError(socketPath, socketName, { holderVerified: false });
    }
    const inode = this.files.stat(socketPath);
    if (inode.dev !== record.dev || inode.ino !== record.ino) {
      return new AuxiliarySocketHeldError(socketPath, socketName, { holderVerified: false });
    }
    const recorded = recordedProcessGenerationToken(record);
    const current = this.processes.readProcessGenerationToken?.(record.pid);
    if (
      recorded === undefined ||
      current === undefined ||
      compareProcessGenerationTokens(recorded, current) !== "same"
    ) {
      return new AuxiliarySocketHeldError(socketPath, socketName, { holderVerified: false });
    }
    return new AuxiliarySocketHeldError(socketPath, socketName, {
      holderPid: record.pid,
      holderVersion: record.version,
      holderVerified: true,
    });
  }

  private read(
    socketPath: string,
    ownerPath = `${socketPath}.owner.json`,
  ): OwnerRecord | undefined {
    try {
      const metadata = this.files.lstat(ownerPath);
      if (!metadata.isFile() || metadata.size > 4096) {
        return undefined;
      }
      const value: unknown = JSON.parse(this.files.read(ownerPath));
      const record = ownerSchema.safeParse(value);
      return record.success && record.data.socketPath === socketPath ? record.data : undefined;
    } catch (error) {
      // Missing/corrupt advisory metadata is expected for old daemons; reachability still refuses bind.
      logger.debug(`Unable to read auxiliary socket owner record: ${error}`, error);
      return undefined;
    }
  }
}
