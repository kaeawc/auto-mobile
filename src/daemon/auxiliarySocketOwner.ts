import {
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { z } from "zod";
import { DAEMON_VERSION } from "./wire/constants";
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
import { sameFileIdentity, statFileIdentity, type SocketFileIdentity } from "./socketFileIdentity";

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  version: z
    .string()
    .min(1)
    .max(64)
    .refine((version) => !/[^0-9A-Za-z.+_-]/.test(version)),
  socketName: z.string(),
  socketPath: z.string(),
  // Rounded above 2^53; kept so released versions can still read the record.
  dev: z.number(),
  ino: z.number(),
  // The exact identity as decimal strings; records written before these fields lack them.
  exactDev: z.string().regex(/^\d+$/).optional(),
  exactIno: z.string().regex(/^\d+$/).optional(),
  processGenerationToken: z.string().optional(),
  processGenerationTokenUtc: z.string().optional(),
});
type OwnerRecord = z.infer<typeof ownerSchema>;

function recordedFileIdentity(identity: SocketFileIdentity) {
  return {
    dev: Number(identity.dev),
    ino: Number(identity.ino),
    exactDev: identity.dev.toString(),
    exactIno: identity.ino.toString(),
  };
}

/** A record without the exact fields compares the way the version that wrote it did. */
function recordMatchesFile(record: OwnerRecord, current: SocketFileIdentity): boolean {
  if (record.exactDev === undefined || record.exactIno === undefined) {
    return Number(current.dev) === record.dev && Number(current.ino) === record.ino;
  }
  return sameFileIdentity(current, { dev: BigInt(record.exactDev), ino: BigInt(record.exactIno) });
}
export interface AuxiliarySocketOwnerFiles {
  read(path: string): string;
  lstat(path: string): { isFile(): boolean; size: number };
  write(path: string, record: OwnerRecord): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  copyExclusive(from: string, to: string): void;
  stat(path: string): SocketFileIdentity;
}
const defaultFiles: AuxiliarySocketOwnerFiles = {
  read: (path) => readFileSync(path, "utf8"),
  lstat: lstatSync,
  write: writePrivateJsonFileAtomicSync,
  remove: unlinkSync,
  rename: renameSync,
  link: linkSync,
  copyExclusive: (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL),
  stat: statFileIdentity,
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

  publish(socketPath: string, socketName: string, identity: SocketFileIdentity): void {
    const record = ownerSchema.parse({
      ...this.identity(),
      socketPath,
      socketName,
      ...recordedFileIdentity(identity),
    });
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
      if (recordMatchesFile(published, this.files.stat(socketPath))) {
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
    if (!recordMatchesFile(record, this.files.stat(socketPath))) {
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
