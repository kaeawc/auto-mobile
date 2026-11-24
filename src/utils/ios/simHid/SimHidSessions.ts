import { errorMessage } from "../../describeUnknownError";
import type { IdGenerator } from "../../IdGenerator";
import { logger } from "../../logger";
import type { Timer } from "../../SystemTimer";
import { raceWithDeadline } from "../../raceWithDeadline";
import { TransportSimHidClient, type SimHidClient } from "./SimHidClient";
import { SimHidCompileError } from "./SimHidCompileError";
import type { SimHidHelperProvider } from "./SimHidHelperProvider";
import type { SimHidProcessHandle, SimHidProcessLauncher } from "./SimHidProcessLauncher";

export interface SimHidSessionsOptions {
  enabled(): boolean;
  provider: SimHidHelperProvider;
  launcher: SimHidProcessLauncher;
  idGenerator: IdGenerator;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  /** After a failed spawn, wait this long before spawning again for that device. */
  retryAfterFailureMs?: number;
  /** After swiftc rejected the sources (a compile error), wait this long for every device. */
  retryAfterBuildFailureMs?: number;
}

export const SIM_HID_RETRY_AFTER_FAILURE_MS = 30_000;
/** A compile error does not fix itself; retrying it on every input would rerun swiftc each time. */
export const SIM_HID_RETRY_AFTER_BUILD_FAILURE_MS = 30 * 60_000;

interface Entry {
  client?: SimHidClient;
  handle?: SimHidProcessHandle;
  starting: Promise<SimHidClient | undefined>;
}

/**
 * One persistent helper per simulator: spawned on first use, reused, replaced after it exits,
 * and killed when the device's session ends or the daemon stops. Entry identity fences a
 * release that lands during an async start.
 */
export class SimHidSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly failedAt = new Map<string, number>();
  private buildFailedAt: number | undefined;
  private stopped = false;

  constructor(private readonly options: SimHidSessionsOptions) {}

  /** The running helper, or undefined; starts one in the background when none is running. */
  ready(deviceId: string): SimHidClient | undefined {
    const entry = this.ensureEntry(deviceId);
    return entry?.client && !entry.client.closed ? entry.client : undefined;
  }

  /** Starts the helper if needed and waits up to `waitMs` for it to be ready. */
  async acquire(deviceId: string, waitMs: number): Promise<SimHidClient | undefined> {
    const entry = this.ensureEntry(deviceId);
    if (!entry) {
      return undefined;
    }
    if (entry.client && !entry.client.closed) {
      return entry.client;
    }
    try {
      return await raceWithDeadline(entry.starting, {
        timer: this.options.timer,
        timeoutMs: waitMs,
        label: "sim-hid-helper start",
      });
    } catch (error) {
      // The start keeps running in the background; this caller uses another input path now.
      logger.debug(`sim-hid-helper not ready within ${waitMs} ms: ${errorMessage(error)}`);
      return undefined;
    }
  }

  release(deviceId: string): void {
    const entry = this.entries.get(deviceId);
    this.entries.delete(deviceId);
    this.failedAt.delete(deviceId);
    // A session that ends or restarts retries a failed build (the user may have installed Xcode).
    this.buildFailedAt = undefined;
    try {
      entry?.client?.close();
    } finally {
      entry?.handle?.stop();
    }
  }

  shutdown(): void {
    this.stopped = true;
    for (const deviceId of [...this.entries.keys()]) {
      try {
        this.release(deviceId);
      } catch (error) {
        logger.warn(`Could not stop sim-hid-helper for ${deviceId}`, error);
      }
    }
  }

  private ensureEntry(deviceId: string): Entry | undefined {
    if (this.stopped || !this.options.enabled()) {
      return undefined;
    }
    const existing = this.entries.get(deviceId);
    if (existing && !existing.client?.closed) {
      return existing;
    }
    if (existing) {
      // The helper exited (device shutdown, crash); start a fresh one.
      this.release(deviceId);
    }
    if (this.inBuildCooldown() || this.inSpawnCooldown(deviceId)) {
      return undefined;
    }
    const entry: Entry = { starting: Promise.resolve(undefined) };
    this.entries.set(deviceId, entry);
    entry.starting = this.start(deviceId, entry);
    return entry;
  }

  private get spawnRetryMs(): number {
    return this.options.retryAfterFailureMs ?? SIM_HID_RETRY_AFTER_FAILURE_MS;
  }

  private get buildRetryMs(): number {
    return this.options.retryAfterBuildFailureMs ?? SIM_HID_RETRY_AFTER_BUILD_FAILURE_MS;
  }

  private inBuildCooldown(): boolean {
    return (
      this.buildFailedAt !== undefined &&
      this.options.timer.now() - this.buildFailedAt < this.buildRetryMs
    );
  }

  private inSpawnCooldown(deviceId: string): boolean {
    const failedAt = this.failedAt.get(deviceId);
    return failedAt !== undefined && this.options.timer.now() - failedAt < this.spawnRetryMs;
  }

  private async start(deviceId: string, entry: Entry): Promise<SimHidClient | undefined> {
    let build: Awaited<ReturnType<SimHidHelperProvider["ensure"]>>;
    try {
      build = await this.options.provider.ensure();
    } catch (error) {
      // Only a compile error is stable; missing sources during an upgrade or xcrun/codesign failures are
      // transient and retry on the short per-device cooldown. Logged once per cooldown.
      const permanent = error instanceof SimHidCompileError;
      const retryMs = permanent ? this.buildRetryMs : this.spawnRetryMs;
      logger.warn(
        `sim-hid-helper could not be built; iOS Simulator raw input uses CtrlProxy for the next ` +
          `${Math.round(retryMs / 1000)} s: ${errorMessage(error)}`,
        error,
      );
      if (this.entries.get(deviceId) === entry) {
        this.entries.delete(deviceId);
      }
      if (permanent) {
        this.buildFailedAt = this.options.timer.now();
      } else {
        this.failedAt.set(deviceId, this.options.timer.now());
      }
      return undefined;
    }
    try {
      if (this.entries.get(deviceId) !== entry) {
        return undefined;
      }
      const handle = await this.options.launcher.launch({
        helperPath: build.path,
        deviceId,
        env: build.env,
      });
      if (this.entries.get(deviceId) !== entry || this.stopped) {
        handle.transport.close();
        handle.stop();
        return undefined;
      }
      entry.handle = handle;
      entry.client = new TransportSimHidClient(
        handle.transport,
        this.options.idGenerator,
        this.options.timer,
      );
      // A retired (timed-out) or exited helper is killed now, not at the next acquisition.
      handle.transport.onClose(() => {
        if (this.entries.get(deviceId) === entry) {
          this.release(deviceId);
        }
      });
      this.failedAt.delete(deviceId);
      this.buildFailedAt = undefined;
      return entry.client;
    } catch (error) {
      logger.warn(
        `sim-hid-helper unavailable for simulator ${deviceId}; raw input uses CtrlProxy: ${errorMessage(error)}`,
        error,
      );
      if (this.entries.get(deviceId) === entry) {
        this.entries.delete(deviceId);
        this.failedAt.set(deviceId, this.options.timer.now());
      }
      return undefined;
    }
  }
}
