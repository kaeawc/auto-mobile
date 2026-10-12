import { defaultLockOwnerGenerationProbe } from "../../daemon/lockOwnerGeneration";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  readExclusiveLockContent,
  releaseExclusiveLock,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
  type LockOwnerGenerationProbe,
} from "../../utils/fileLock";
import { sortedReaddirSync } from "../../utils/io";
import { logger } from "../../utils/logger";
import { isProcessRunning } from "../../utils/processLiveness";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { ensureSecureDirectorySync } from "../../utils/tempDir";
import {
  HostBootAdmissionRegistryError,
  type HostBootAdmissionRecord,
  type HostBootAdmissionRegistry,
  type PublishedBootAdmission,
} from "./HostBootAdmissionRegistry";

const recordSchema = z.object({
  id: z.string().min(1),
  ownerPid: z.number().int().positive(),
  deviceId: z.string().optional(),
  processId: z.number().int().positive().optional(),
  admittedUntilMs: z.number().finite().optional(),
  handedOffUntilMs: z.number().finite().optional(),
});

/** Final record names are atomic renames, so corrupt files cannot be writes in progress. */
export const INVALID_ADMISSION_RECORD_MAX_AGE_MS = 10 * 60 * 1000;
/** Live-owner takeover bound: a legitimate lock covers one sample, bounded to 15 seconds.
 * Ownerless locks heal earlier through the shared primitive's 10-second bound. */
export const ADMISSION_LOCK_MAX_AGE_MS = 60 * 1000;

export interface FileHostBootAdmissionRegistryOptions {
  directory: () => string;
  timer?: Timer;
  pid?: number;
  isProcessRunning?: (pid: number) => boolean;
  ownerGeneration?: LockOwnerGenerationProbe;
  idGenerator?: IdGenerator;
  lockMaxAgeMs?: number;
}

/** Atomic records and the canonical exclusive lock, scoped by the caller to one host service. */
export class FileHostBootAdmissionRegistry implements HostBootAdmissionRegistry {
  private readonly timer: Timer;
  private readonly pid: number;
  private readonly running: (pid: number) => boolean;
  private readonly ids: IdGenerator;

  constructor(private readonly options: FileHostBootAdmissionRegistryOptions) {
    this.timer = options.timer ?? defaultTimer;
    this.pid = options.pid ?? process.pid;
    this.running = options.isProcessRunning ?? isProcessRunning;
    this.ids = options.idGenerator ?? defaultIdGenerator;
  }

  async withAdmissionLock<T>(
    options: { timeoutMs: number; signal?: AbortSignal },
    fn: () => Promise<T>,
  ): Promise<T> {
    options.signal?.throwIfAborted();
    const path = this.perform((dir) => join(ensureSecureDirectorySync(dir), "admission.lock"));
    const token = this.ids.next();
    await this.acquire(path, token, options);
    try {
      options.signal?.throwIfAborted();
      return await fn();
    } finally {
      releaseExclusiveLock(path, this.pid, token);
    }
  }

  private async acquire(
    path: string,
    token: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<void> {
    const deadline = this.timer.now() + options.timeoutMs;
    for (;;) {
      options.signal?.throwIfAborted();
      if (this.tryAcquire(path, token)) {
        return;
      }
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        throw this.timeout(path);
      }
      // Only the sleep is raced: an aborted waiter cannot later acquire a lock in the background.
      await raceWithDeadline(() => this.timer.sleep(Math.min(25, remaining)), {
        timer: this.timer,
        timeoutMs: remaining,
        signal: options.signal,
        label: path,
        timeoutError: () => this.timeout(path),
      });
      if (this.timer.now() >= deadline) {
        throw this.timeout(path);
      }
    }
  }

  private timeout(path: string): HostBootAdmissionRegistryError {
    logger.warn(`[BootAdmission] Timed out waiting for ${path}`);
    return new HostBootAdmissionRegistryError(
      "timeout",
      `Timed out waiting for host admission lock at ${path}`,
    );
  }

  private tryAcquire(path: string, token: string): boolean {
    try {
      const acquired = tryAcquireExclusiveLock(path, {
        pid: this.pid,
        now: () => this.timer.now(),
        ownerToken: token,
        isProcessRunning: this.running,
        ownerGeneration: this.options.ownerGeneration ?? defaultLockOwnerGenerationProbe,
      });
      if (!acquired) {
        this.checkReadableLock(path);
        return this.takeOverStaleLock(path, token);
      }
      return acquired;
    } catch (error) {
      throw this.failed(path, error);
    }
  }

  private takeOverStaleLock(path: string, token: string): boolean {
    const observedOwner = readExclusiveLockContent(path);
    if (
      !observedOwner ||
      !this.olderThan(path, this.options.lockMaxAgeMs ?? ADMISSION_LOCK_MAX_AGE_MS)
    ) {
      return false;
    }
    const acquired = takeOverExclusiveLock(path, observedOwner, {
      ownerGeneration: this.options.ownerGeneration ?? defaultLockOwnerGenerationProbe,
      pid: this.pid,
      ownerToken: token,
    });
    if (acquired) {
      logger.warn(
        `[BootAdmission] Took over stale host admission lock at ${path} from PID ${observedOwner.pid}`,
      );
    }
    return acquired;
  }

  private olderThan(path: string, ageMs: number): boolean {
    try {
      return this.timer.now() - statSync(path).mtimeMs > ageMs;
    } catch (error) {
      if (!this.missing(error, path)) {
        throw this.failed(path, error);
      }
      return false;
    }
  }

  private checkReadableLock(path: string): void {
    try {
      readFileSync(path);
    } catch (error) {
      if (!this.missing(error, path)) {
        throw this.failed(path, error);
      }
    }
  }

  readPeerAdmissions(): HostBootAdmissionRecord[] {
    return this.perform((dir) =>
      this.listFiles(dir).flatMap((name) => {
        const record = this.readRecord(dir, name);
        return record && record.ownerPid !== this.pid ? [record] : [];
      }),
    );
  }

  private listFiles(dir: string): string[] {
    try {
      return sortedReaddirSync(dir).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (!this.missing(error, dir)) {
        throw error;
      }
      return [];
    }
  }

  private readRecord(dir: string, name: string): HostBootAdmissionRecord | undefined {
    const path = join(dir, name);
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch (error) {
      if (!this.missing(error, path)) {
        throw error;
      }
      return undefined;
    }
    const record = this.parseRecord(path, name, body);
    if (record && this.isStale(record)) {
      this.cleanup(path);
      return undefined;
    }
    return record;
  }

  private parseRecord(
    path: string,
    name: string,
    body: string,
  ): HostBootAdmissionRecord | undefined {
    const ownerPid = Number(name.split(".", 1)[0]);
    try {
      const record = recordSchema.parse(JSON.parse(body));
      if (name !== `${record.ownerPid}.${record.id}.json`) {
        throw new Error("Mismatched admission record identity");
      }
      return record;
    } catch (error) {
      if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
        throw this.failed(path, error);
      }
      if (this.running(ownerPid)) {
        if (!this.olderThan(path, INVALID_ADMISSION_RECORD_MAX_AGE_MS)) {
          throw this.failed(path, error);
        }
        logger.warn(
          `[BootAdmission] Dropping old invalid record at ${path} from PID ${ownerPid}: ${errorMessage(error)}`,
          error,
        );
        this.cleanup(path);
        return undefined;
      }
      // A dead owner cannot be filling this corrupt record; no valid boot can be recovered from it.
      logger.debug(
        `[BootAdmission] Dropping dead owner's invalid record at ${path}: ${errorMessage(error)}`,
      );
      this.cleanup(path);
      return undefined;
    }
  }

  private isStale(record: HostBootAdmissionRecord): boolean {
    if (record.handedOffUntilMs !== undefined) {
      return this.timer.now() >= record.handedOffUntilMs;
    }
    return (
      !this.running(record.ownerPid) ||
      (record.admittedUntilMs !== undefined && this.timer.now() >= record.admittedUntilMs)
    );
  }

  publish(
    fields: Pick<HostBootAdmissionRecord, "deviceId" | "admittedUntilMs"> = {},
  ): PublishedBootAdmission {
    let record: HostBootAdmissionRecord = { id: this.ids.next(), ownerPid: this.pid, ...fields };
    this.write(record);
    let removed = false;
    return {
      update: (update) => {
        if (removed) {
          return;
        }
        const next = {
          ...record,
          ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
        };
        this.write(next);
        record = next;
      },
      remove: () => {
        if (removed) {
          return;
        }
        this.perform((dir) => this.unlink(join(dir, `${record.ownerPid}.${record.id}.json`)));
        removed = true;
      },
    };
  }

  private write(record: HostBootAdmissionRecord): void {
    this.perform((dir) => {
      ensureSecureDirectorySync(dir);
      const path = join(dir, `${record.ownerPid}.${record.id}.json`);
      const temp = `${path}.${this.ids.next()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
        renameSync(temp, path);
      } finally {
        this.cleanup(temp);
      }
    });
  }

  private unlink(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if (!this.missing(error, path)) {
        throw error;
      }
    }
  }

  private cleanup(path: string): void {
    try {
      this.unlink(path);
    } catch (error) {
      // Stale files are already excluded from the view; failed cleanup must not revive them.
      logger.warn(
        `[BootAdmission] Registry cleanup failed at ${path}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private missing(error: unknown, path: string): boolean {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return false;
    }
    // Missing directories mean no admissions; a missing file was removed by its owner or a peer.
    logger.debug(`[BootAdmission] Registry path already absent: ${path}`);
    return true;
  }

  private perform<T>(fn: (dir: string) => T): T {
    let path = "boot-admissions/android (unresolved registry directory)";
    try {
      path = this.options.directory();
      return fn(path);
    } catch (error) {
      throw this.failed(path, error);
    }
  }

  private failed(path: string, error: unknown): HostBootAdmissionRegistryError {
    if (error instanceof HostBootAdmissionRegistryError) {
      return error;
    }
    logger.warn(`[BootAdmission] Host registry failed at ${path}: ${errorMessage(error)}`, error);
    return new HostBootAdmissionRegistryError(
      "failed",
      `Host boot registry failed at ${path}: ${errorMessage(error)}`,
    );
  }
}
