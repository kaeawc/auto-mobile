import {
  defaultScreenshotFileWriter,
  type ScreenshotFileWriter,
} from "./screenshot/ScreenshotFileWriter";
import nodePath from "node:path";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { DefaultFileSystem, type FileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { logger } from "../../utils/logger";
import { getObserveCacheStore } from "./cache/ObserveCacheRegistry";
import { getScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import {
  SCREENSHOT_CACHE_MAX_SIZE_BYTES,
  screenshotPathKey,
  selectScreenshotsToEvict,
  type ScreenshotCacheFile,
  type ScreenshotPathModule,
} from "./screenshotCacheEviction";

export const SCREENSHOT_PATH_MIN_LIFETIME_MS = 10 * 60 * 1000;
export const MAX_SCREENSHOT_PATH_PROTECTIONS = 4096;
const SWEEP_INTERVAL_MS = 60_000;
/**
 * At capacity, the oldest unreferenced screenshots are evicted before their guarantee expires
 * rather than failing the new capture (#8758). A file touched (written or returned) this
 * recently is never evicted: it may be a frame another process has not published yet.
 */
export const SCREENSHOT_PRESSURE_EVICTION_MIN_AGE_MS = 5_000;
/** Reconcile once per admission when its projected bytes or count reach 90% of a cap. */
export const SCREENSHOT_INVENTORY_RECONCILE_RATIO = 0.9;
const screenshotName =
  /^(?:screenshot_.+\.(?:png|jpe?g|webp)(?:\.temp)?|snapshot-of-.+\.png|crop-[A-Za-z0-9_-]+\.png)$/;

export class ScreenshotRetentionCapacityError extends ActionableError {
  readonly code = "SCREENSHOT_RETENTION_CAPACITY";
  override readonly name = "ScreenshotRetentionCapacityError";
  constructor(
    readonly liveBytes: number,
    readonly liveCount: number,
    readonly earliestExpiresAt: number,
    readonly cap = SCREENSHOT_CACHE_MAX_SIZE_BYTES,
    readonly countCap = MAX_SCREENSHOT_PATH_PROTECTIONS,
  ) {
    super(
      `Screenshot retention capacity reached (${cap} bytes / ${countCap} files; ${liveBytes} bytes / ${liveCount} files retained). Retry after ${new Date(earliestExpiresAt).toISOString()} when the earliest guarantee expires; cleanup failures or cache references may delay space becoming available.`,
    );
  }
}

export interface ScreenshotRetentionWrite {
  size: number;
  write(): Promise<void>;
  remove(): Promise<void>;
  fileSystem?: FileSystem;
}
export interface ScreenshotRetentionStart {
  fileSystem?: FileSystem;
  /** Tests explicitly opt in; production schedules one unref'd timer per directory. */
  scheduled?: boolean;
}
export interface ScreenshotPathProtection {
  protect(path: string): Promise<number>;
  removeIfUnprotected(path: string, remove: () => Promise<boolean>): Promise<boolean>;
  isProtected(path: string): boolean;
  start(directory: string, options?: ScreenshotRetentionStart): void;
  /** Best-effort; failures are logged at warn and never reject. */
  sweep(directory: string, fileSystem?: FileSystem): Promise<void>;
  /** Best-effort; failures are logged at warn and never reject. */
  sweepOnce(directory: string, fileSystem?: FileSystem): Promise<void>;
  write(path: string, operation: ScreenshotRetentionWrite): Promise<void>;
}
interface DirectoryRetention {
  fileSystem: FileSystem;
  recovered?: Set<string>;
  pending: Promise<void>;
  interval?: NodeJS.Timeout;
  files?: Map<string, ScreenshotCacheFile>;
  bytes: number;
  reconcileNeeded?: boolean;
  inventoryFailed?: boolean;
}

/**
 * One shared admission/cleanup authority across devices and sessions in a process.
 * A file's guarantee is max(return lease, process-start grace, mtime + 10min).
 * On first inventory, pre-existing files without a lease receive start + 10min:
 * the previous process could have returned an old cached file just before dying.
 * No persisted index is needed. Other processes only see the mtime floor; their
 * cleaners cannot observe this process's return leases. Inventories reconcile on
 * sweeps and near capacity; admission is serialized only within this process.
 */
export class BoundedScreenshotPathProtection implements ScreenshotPathProtection {
  private readonly deadlines = new Map<string, number>();
  private readonly removals = new Map<string, Promise<boolean>>();
  private readonly directories = new Map<string, DirectoryRetention>();
  private readonly sweptDirectories = new Set<string>();
  private readonly startedAt: number;
  private lastPrunedAt?: number;
  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly pathModule: ScreenshotPathModule = nodePath,
    /** Live-file cap; tests lower it so capacity needs a handful of files, not 4096. */
    private readonly countCap: number = MAX_SCREENSHOT_PATH_PROTECTIONS,
  ) {
    this.startedAt = timer.now();
  }

  async protect(path: string): Promise<number> {
    const key = this.key(path);
    const removal = this.removals.get(key);
    if (removal) {
      await removal;
    }
    this.prune();
    const expiresAt = Math.max(
      this.deadlines.get(key) ?? 0,
      this.timer.now() + SCREENSHOT_PATH_MIN_LIFETIME_MS,
    );
    this.deadlines.set(key, expiresAt);
    return expiresAt;
  }

  async removeIfUnprotected(path: string, remove: () => Promise<boolean>): Promise<boolean> {
    const key = this.key(path);
    if (this.isProtected(path) || this.removals.has(key)) {
      return false;
    }
    // Register before asynchronous filesystem work: publication waits, then stats.
    const removal = Promise.resolve().then(remove);
    this.removals.set(key, removal);
    try {
      const removed = await removal;
      const state = this.directories.get(this.key(nodePath.dirname(path)));
      if (removed && state) {
        this.dropFile(state, path);
      }
      return removed;
    } finally {
      this.removals.delete(key);
    }
  }

  isProtected(path: string): boolean {
    this.prune();
    return this.deadlines.has(this.key(path));
  }

  start(directory: string, options: ScreenshotRetentionStart = {}): void {
    const state = this.directory(directory, options.fileSystem);
    if (state.interval || !(options.scheduled ?? process.env.NODE_ENV !== "test")) {
      return;
    }
    state.interval = this.timer.setInterval(() => {
      void this.sweep(directory);
    }, SWEEP_INTERVAL_MS);
    state.interval.unref?.();
  }

  async sweep(directory: string, fileSystem?: FileSystem): Promise<void> {
    const state = this.directory(directory, fileSystem);
    try {
      await this.serialize(state, async () => {
        await this.cleanup(directory, state);
      });
    } catch (error) {
      logger.warn("Failed to cleanup screenshot cache:", error);
    }
  }

  sweepOnce(directory: string, fileSystem?: FileSystem): Promise<void> {
    const key = this.key(directory);
    if (this.sweptDirectories.has(key)) {
      return Promise.resolve();
    }
    this.sweptDirectories.add(key);
    return this.sweep(directory, fileSystem);
  }

  async write(path: string, operation: ScreenshotRetentionWrite): Promise<void> {
    const directory = nodePath.dirname(path);
    const state = this.directory(directory, operation.fileSystem);
    this.start(directory);
    const transition = this.serialize(state, async () => {
      await this.prepareAdmission(directory, state, operation.size);
      await this.evictUnderPressure(state, operation.size);
      await this.performWrite(path, operation, state);
      this.addFile(state, { path, size: operation.size, mtimeMs: this.timer.now() });
    }).then(() => false);
    const key = this.key(path);
    this.removals.set(key, transition);
    try {
      // Readers cannot publish a frame until its post-write admission commits.
      await transition;
    } finally {
      this.removals.delete(key);
    }
  }

  private key(path: string): string {
    return screenshotPathKey(path, this.pathModule);
  }
  private directory(directory: string, fileSystem?: FileSystem): DirectoryRetention {
    const key = this.key(directory);
    let state = this.directories.get(key);
    if (!state) {
      state = {
        fileSystem: fileSystem ?? new DefaultFileSystem(),
        pending: Promise.resolve(),
        bytes: 0,
      };
      this.directories.set(key, state);
    }
    return state;
  }
  private async serialize(state: DirectoryRetention, action: () => Promise<void>): Promise<void> {
    const previous = state.pending;
    let release!: () => void;
    state.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await action();
    } finally {
      release();
    }
  }
  private async prepareAdmission(
    directory: string,
    state: DirectoryRetention,
    incoming: number,
  ): Promise<void> {
    const nearCap =
      state.bytes + incoming >=
        SCREENSHOT_CACHE_MAX_SIZE_BYTES * SCREENSHOT_INVENTORY_RECONCILE_RATIO ||
      (state.files?.size ?? 0) + 1 >= this.countCap * SCREENSHOT_INVENTORY_RECONCILE_RATIO;
    if (!state.files || state.inventoryFailed || state.reconcileNeeded || nearCap) {
      await this.cleanup(directory, state);
    }
    if (state.inventoryFailed) {
      throw new ActionableError(
        "Cannot verify screenshot retention capacity. Fix directory permissions and retry capture.",
      );
    }
  }
  private async performWrite(
    path: string,
    operation: ScreenshotRetentionWrite,
    state: DirectoryRetention,
  ): Promise<void> {
    try {
      await operation.write();
    } catch (error) {
      if (this.directoryChanged(error)) {
        await this.inventory(nodePath.dirname(path), state);
      }
      throw toActionableError(error, "Failed to write retained screenshot");
    }
  }
  private directoryChanged(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EEXIST")
    );
  }
  private addFile(state: DirectoryRetention, file: ScreenshotCacheFile): void {
    const key = this.key(file.path);
    state.bytes += file.size - (state.files?.get(key)?.size ?? 0);
    state.files?.set(key, file);
  }
  private dropFile(state: DirectoryRetention, path: string): void {
    const key = this.key(path);
    state.bytes -= state.files?.get(key)?.size ?? 0;
    state.files?.delete(key);
    state.recovered?.delete(key);
  }
  private prune(): void {
    const now = this.timer.now();
    if (this.lastPrunedAt === now) {
      return;
    }
    this.lastPrunedAt = now;
    for (const [path, deadline] of this.deadlines) {
      if (deadline <= now) {
        this.deadlines.delete(path);
      }
    }
  }
  private expiry(file: ScreenshotCacheFile, state: DirectoryRetention): number {
    const key = this.key(file.path);
    return Math.max(
      this.deadlines.get(key) ?? 0,
      state.recovered?.has(key) ? this.startedAt + SCREENSHOT_PATH_MIN_LIFETIME_MS : 0,
      file.mtimeMs + SCREENSHOT_PATH_MIN_LIFETIME_MS,
    );
  }
  private async inventory(
    directory: string,
    state: DirectoryRetention,
  ): Promise<ScreenshotCacheFile[]> {
    state.inventoryFailed = true;
    let names: string[];
    try {
      names = await state.fileSystem.readdir(directory);
    } catch (error) {
      logger.warn("Failed to inventory screenshot retention directory", error);
      throw toActionableError(error, "Cannot inventory screenshot retention directory");
    }
    state.inventoryFailed = false;
    state.reconcileNeeded = false;
    const files = new Map<string, ScreenshotCacheFile>();
    const recovered = new Set<string>();
    for (const name of names.filter((name) => screenshotName.test(name))) {
      const file = await this.readFile(nodePath.join(directory, name), state);
      if (file) {
        const key = this.key(file.path);
        files.set(key, file);
        if (!this.isProtected(key)) {
          recovered.add(key);
        }
      }
    }
    state.files = files;
    state.bytes = [...files.values()].reduce((total, file) => total + file.size, 0);
    state.recovered = recovered;
    return [...files.values()];
  }
  private async readFile(
    path: string,
    state: DirectoryRetention,
  ): Promise<ScreenshotCacheFile | undefined> {
    try {
      const stat = await (state.fileSystem.lstat?.(path) ?? state.fileSystem.stat(path));
      return stat.isFile?.() === true
        ? { path, size: stat.size, mtimeMs: stat.mtimeMs }
        : undefined;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // A file that vanished after readdir consumes no retention capacity.
        logger.debug(`Screenshot vanished before cleanup stat: ${path}`, error);
        return undefined;
      }
      state.inventoryFailed = true;
      logger.warn(`Failed to stat screenshot during cleanup: ${path}`, error);
      return undefined;
    }
  }
  private async references(): Promise<Set<string>> {
    return new Set(
      [
        ...getScreenshotStateStore().getReferencedScreenshotPaths(),
        ...(await getObserveCacheStore().getReferencedScreenshotPaths()),
      ].map((path) => this.key(path)),
    );
  }
  private async cleanup(
    directory: string,
    state: DirectoryRetention,
  ): Promise<ScreenshotCacheFile[]> {
    const files = await this.inventory(directory, state);
    const references = await this.references();
    const isReferenced = (path: string) => references.has(this.key(path));
    const indexed = new Map(files.map((file) => [this.key(file.path), file]));
    const isProtected = (path: string) => {
      const file = indexed.get(this.key(path));
      return !!file && this.expiry(file, state) > this.timer.now();
    };
    const plan = selectScreenshotsToEvict(
      files,
      SCREENSHOT_CACHE_MAX_SIZE_BYTES,
      SCREENSHOT_PATH_MIN_LIFETIME_MS,
      this.timer.now(),
      isReferenced,
      isProtected,
    );
    // Both size pressure and the idle age sweep obey exactly the same guarantee.
    const candidates = new Set([
      ...plan.toEvict,
      ...files.filter((file) => !isProtected(file.path)).map((file) => file.path),
    ]);
    for (const file of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      const removed =
        candidates.has(file.path) &&
        (await this.removeIfUnprotected(file.path, async () => {
          const currentReferences = await this.references();
          if (
            this.expiry(file, state) > this.timer.now() ||
            currentReferences.has(this.key(file.path))
          ) {
            return false;
          }
          return this.unlink(file.path, state);
        }));
      if (removed) {
        this.dropFile(state, file.path);
      }
    }
    if (state.reconcileNeeded) {
      await this.inventory(directory, state);
    }
    const remaining = [...(state.files?.values() ?? [])];
    if (state.bytes > SCREENSHOT_CACHE_MAX_SIZE_BYTES) {
      logger.warn(
        `Screenshot cache remains over budget; ${remaining.filter((file) => this.isProtected(file.path)).length} protected screenshots`,
      );
    }
    return remaining;
  }
  /** Last write or return of a file; a returned path's lease began this long ago. */
  private lastTouched(file: ScreenshotCacheFile, state: DirectoryRetention): number {
    const key = this.key(file.path);
    const lease = this.deadlines.get(key);
    return Math.max(
      file.mtimeMs,
      lease === undefined ? 0 : lease - SCREENSHOT_PATH_MIN_LIFETIME_MS,
      state.recovered?.has(key) ? this.startedAt : 0,
    );
  }
  /**
   * Make room for an incoming frame by evicting least-recently-touched files, even inside their
   * guarantee. Refusing the capture instead fails observe outright, which is worse than an
   * early eviction (#8758). Files no live cache references and not touched in the last 5 s go
   * first; if they are not enough, eviction continues into referenced and recent files, still
   * least recently touched first. Only writes in flight are never deleted. A frame that cannot
   * fit even then (bigger than the cap, or an unlink failed) is admitted anyway with a warning.
   */
  private async evictUnderPressure(state: DirectoryRetention, incoming: number): Promise<void> {
    const fits = () =>
      state.bytes + incoming <= SCREENSHOT_CACHE_MAX_SIZE_BYTES &&
      (state.files?.size ?? 0) + 1 <= this.countCap;
    if (fits()) {
      return;
    }
    const references = await this.references();
    const newest = this.timer.now() - SCREENSHOT_PRESSURE_EVICTION_MIN_AGE_MS;
    const candidates = [...(state.files?.values() ?? [])]
      .filter((file) => !this.removals.has(this.key(file.path)))
      .map((file) => {
        const touched = this.lastTouched(file, state);
        const spared = touched > newest || references.has(this.key(file.path));
        return { file, touched, spared };
      })
      .sort((a, b) => Number(a.spared) - Number(b.spared) || a.touched - b.touched);
    let evicted = 0;
    let sparedEvicted = 0;
    for (const { file, spared } of candidates) {
      if (fits()) {
        break;
      }
      if (await this.evict(file.path, state)) {
        evicted += 1;
        sparedEvicted += spared ? 1 : 0;
      }
    }
    if (evicted > 0) {
      logger.warn(
        `Screenshot retention at capacity; evicted ${evicted} least-recently-used screenshots before their guarantee expired (${sparedEvicted} were referenced or recently used)`,
      );
    }
    if (!fits()) {
      logger.warn(
        `Screenshot retention cannot fit a ${incoming}-byte capture within ${SCREENSHOT_CACHE_MAX_SIZE_BYTES} bytes / ${this.countCap} files; admitting it anyway`,
      );
    }
  }
  private async evict(path: string, state: DirectoryRetention): Promise<boolean> {
    const key = this.key(path);
    // Register the removal so a concurrent protect() waits for it instead of leasing a ghost.
    const removal = this.unlink(path, state);
    this.removals.set(key, removal);
    try {
      const removed = await removal;
      if (removed) {
        this.dropFile(state, path);
        this.deadlines.delete(key);
      }
      return removed;
    } finally {
      this.removals.delete(key);
    }
  }
  private async unlink(path: string, state: DirectoryRetention): Promise<boolean> {
    try {
      await state.fileSystem.unlink(path);
      return true;
    } catch (error) {
      logger.warn(`Failed to remove cached screenshot: ${path}`, error);
      if (this.directoryChanged(error)) {
        state.reconcileNeeded = true;
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          this.dropFile(state, path);
          return true;
        }
      }
      return false;
    }
  }
}
export const screenshotPathProtection: ScreenshotPathProtection =
  new BoundedScreenshotPathProtection();

/** Recompute publication metadata, including cached panels and crops, from the lease call. */
export async function publishScreenshotPaths(
  result: {
    screenshotPath?: string;
    screenshotExpiresAt?: number;
    displays?: { screenshotPath?: string; screenshotExpiresAt?: number }[];
    crop?: { cropPath: string; expiresAt?: number };
  },
  protection: ScreenshotPathProtection = screenshotPathProtection,
  report = true,
): Promise<void> {
  for (const panel of [result, ...(result.displays ?? [])]) {
    const expiry = panel.screenshotPath
      ? await protection.protect(panel.screenshotPath)
      : undefined;
    if (report) {
      panel.screenshotExpiresAt = expiry;
    }
  }
  if (result.crop) {
    const expiry = await protection.protect(result.crop.cropPath);
    if (report) {
      result.crop.expiresAt = expiry;
    }
  }
}

/** All buffer writers use the same admission and rollback primitive. */
export async function writeRetainedScreenshot(
  path: string,
  bytes: Buffer,
  options: {
    writer?: ScreenshotFileWriter;
    pathProtection?: ScreenshotPathProtection;
    fileSystem?: FileSystem;
  } = {},
): Promise<void> {
  const writer = options.writer ?? defaultScreenshotFileWriter;
  await (options.pathProtection ?? screenshotPathProtection).write(path, {
    size: bytes.length,
    fileSystem: options.fileSystem,
    write: () => writer.write(path, bytes),
    remove: () => writer.remove(path),
  });
}

/** Preserve typed capture failures when a caller explicitly requires a screenshot. */
export function requireScreenshotSuccess(
  result: { actionableError?: ActionableError },
  required: boolean,
): void {
  if (required && result.actionableError) {
    throw result.actionableError;
  }
}
