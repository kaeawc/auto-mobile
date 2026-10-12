import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { releaseExclusiveLock, tryAcquireExclusiveLock } from "../../utils/fileLock";
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
  handedOffUntilMs: z.number().finite().optional(),
});

export interface FileHostBootAdmissionRegistryOptions {
  directory: () => string;
  timer?: Timer;
  pid?: number;
  isProcessRunning?: (pid: number) => boolean;
  idGenerator?: IdGenerator;
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
        ownerToken: token,
        isProcessRunning: this.running,
      });
      if (!acquired) {
        this.checkReadableLock(path);
      }
      return acquired;
    } catch (error) {
      throw this.failed(path, error);
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
      return readdirSync(dir).filter((name) => name.endsWith(".json"));
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
        throw new HostBootAdmissionRegistryError(
          "failed",
          `Mismatched admission record at ${path}`,
        );
      }
      return record;
    } catch (error) {
      if (!Number.isInteger(ownerPid) || ownerPid <= 0 || this.running(ownerPid)) {
        throw this.failed(path, error);
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
    return record.handedOffUntilMs === undefined
      ? !this.running(record.ownerPid)
      : this.timer.now() >= record.handedOffUntilMs;
  }

  publish(fields: Pick<HostBootAdmissionRecord, "deviceId"> = {}): PublishedBootAdmission {
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
    logger.warn(`[BootAdmission] Host registry failed at ${path}: ${errorMessage(error)}`, error);
    return new HostBootAdmissionRegistryError(
      "failed",
      `Host boot registry failed at ${path}: ${errorMessage(error)}`,
    );
  }
}
