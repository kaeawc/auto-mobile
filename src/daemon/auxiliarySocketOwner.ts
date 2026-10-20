import { readFileSync, statSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { DAEMON_VERSION } from "./constants";
import { writeJsonFileAtomicSync } from "./daemonFiles";
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

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  version: z.string().min(1),
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
  write(path: string, record: OwnerRecord): void;
  remove(path: string): void;
  stat(path: string): { dev: number; ino: number };
}
const defaultFiles: AuxiliarySocketOwnerFiles = {
  read: (path) => readFileSync(path, "utf8"),
  write: writeJsonFileAtomicSync,
  remove: unlinkSync,
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
        this.files.remove(`${socketPath}.owner.json`);
      }
    } catch (error) {
      // Cleanup is best effort; a stale sidecar cannot authorize reclaiming a live socket.
      logger.debug(`Unable to remove auxiliary socket owner record: ${error}`, error);
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
    const recorded = recordedProcessGenerationToken(record);
    const current = this.processes.readProcessGenerationToken?.(record.pid);
    const inode = this.files.stat(socketPath);
    return new AuxiliarySocketHeldError(socketPath, socketName, {
      holderPid: record.pid,
      holderVersion: record.version,
      holderVerified:
        inode.dev === record.dev &&
        inode.ino === record.ino &&
        recorded !== undefined &&
        current !== undefined &&
        compareProcessGenerationTokens(recorded, current) === "same",
    });
  }

  private read(socketPath: string): OwnerRecord | undefined {
    try {
      const value: unknown = JSON.parse(this.files.read(`${socketPath}.owner.json`));
      const record = ownerSchema.safeParse(value);
      return record.success && record.data.socketPath === socketPath ? record.data : undefined;
    } catch (error) {
      // Missing/corrupt advisory metadata is expected for old daemons; reachability still refuses bind.
      logger.debug(`Unable to read auxiliary socket owner record: ${error}`, error);
      return undefined;
    }
  }
}
