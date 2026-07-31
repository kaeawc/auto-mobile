import { EventEmitter } from "node:events";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  IOSScreenCaptureHelper,
  type CaptureTarget,
  type FrameQueueMetrics,
  type IosScreenCaptureHelperEvents,
  type IosScreenCaptureHelperOptions,
  type IosScreenCaptureReadiness,
  type NativeFrameMetrics,
} from "./IOSScreenCaptureHelper";
import type {
  DecodedAudio,
  DecodedFrame,
  MalformedFrameError,
} from "./frameProtocol";

export const IOS_SIMULATOR_HELPER_IDLE_TTL_MS = 45_000;

export interface IosSimulatorCaptureHelperLease {
  start(): void | Promise<void>;
  stop(): Promise<unknown>;
  invalidate(): Promise<void>;
  on(event: "frame", listener: (frame: DecodedFrame) => void): this;
  on(event: "frameMetrics", listener: (metrics: FrameQueueMetrics) => void): this;
  on(event: "captureMetrics", listener: (metrics: NativeFrameMetrics) => void): this;
  on(event: "audio", listener: (audio: DecodedAudio) => void): this;
  on(event: "malformed", listener: (error: MalformedFrameError) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  on(event: "readiness", listener: (status: IosScreenCaptureReadiness) => void): this;
  on(event: "exit", listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

type SimulatorHelper = Pick<IOSScreenCaptureHelper, "start" | "stop" | "isRunning"> & {
  on<E extends keyof IosScreenCaptureHelperEvents>(
    event: E,
    listener: IosScreenCaptureHelperEvents[E]
  ): SimulatorHelper;
};

type SimulatorHelperFactory = (options: IosScreenCaptureHelperOptions) => SimulatorHelper;

export interface SimulatorCaptureHelperPoolOptions {
  idleTtlMs?: number;
  timer?: Timer;
  createHelper?: SimulatorHelperFactory;
}

interface HelperEntry {
  key: string;
  helper: SimulatorHelper;
  leases: Set<PooledSimulatorCaptureHelperLease>;
  latestFrame: DecodedFrame | null;
  idleTimer: NodeJS.Timeout | null;
  failed: boolean;
  failedStopFailed: boolean;
  failedStopError: unknown;
}

/**
 * Keeps ScreenCaptureKit sessions warm per macOS host and target. Each WebRTC
 * source gets a lease, so its ffmpeg encoder and callbacks stay stream-scoped
 * while capture survives short reconnect gaps. A new window identity never
 * retargets an active helper; it gets an independent, TTL-bounded entry.
 */
export class IOSSimulatorCaptureHelperPool {
  private readonly idleTtlMs: number;
  private readonly timer: Timer;
  private readonly createHelper: SimulatorHelperFactory;
  private readonly entries = new Map<string, HelperEntry>();
  private transition: Promise<void> = Promise.resolve();

  constructor(options: SimulatorCaptureHelperPoolOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? IOS_SIMULATOR_HELPER_IDLE_TTL_MS;
    this.timer = options.timer ?? defaultTimer;
    this.createHelper = options.createHelper ?? (helperOptions => new IOSScreenCaptureHelper(helperOptions));
  }

  acquire(options: IosScreenCaptureHelperOptions): IosSimulatorCaptureHelperLease {
    if (options.target.kind !== "simulator") {
      throw new Error("IOSSimulatorCaptureHelperPool only accepts simulator targets.");
    }
    return new PooledSimulatorCaptureHelperLease(this, options);
  }

  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      const entries = [...this.entries.values()];
      this.entries.clear();
      for (const entry of entries) {
        this.clearEntryIdleTimer(entry);
        await entry.helper.stop().catch(error => {
          logger.debug(`[IOSSimulatorCaptureHelperPool] helper shutdown failed: ${error}`);
        });
      }
    });
  }

  async attach(lease: PooledSimulatorCaptureHelperLease): Promise<void> {
    await this.enqueue(async () => {
      if (!lease.isStarted) {
        return;
      }
      const targetKey = helperTargetKey(lease.options.target, lease.options.binaryPath);
      let entry = this.entries.get(targetKey);
      if (entry?.failedStopFailed) {
        // A previous helper.stop() threw and left this entry poisoned. The
        // failure was already surfaced once (to the awaiting invalidate/best-
        // effort cleanup). Drop the entry now so this attach can build a fresh
        // helper instead of re-throwing the same error forever — bounded retry,
        // not permanent poison of the window target.
        this.clearEntryIdleTimer(entry);
        this.entries.delete(targetKey);
        entry = undefined;
      }
      if (!entry) {
        // A new CGWindowID proves a reboot/window recreation. Evict any idle
        // session now rather than letting it occupy ScreenCaptureKit resources
        // through its TTL, but never disrupt a different active simulator stream.
        for (const candidate of this.entries.values()) {
          if (candidate.key !== targetKey && candidate.leases.size === 0) {
            await this.stopEntry(candidate);
          }
        }

        if (!lease.isStarted) {
          return;
        }
        const helper = this.createHelper(lease.options);
        entry = {
          key: targetKey,
          helper,
          leases: new Set(),
          latestFrame: null,
          idleTimer: null,
          failed: false,
          failedStopFailed: false,
          failedStopError: undefined,
        };
        this.entries.set(targetKey, entry);
        this.wireHelper(entry);
      }

      this.clearEntryIdleTimer(entry);
      entry.leases.add(lease);
      lease.entryKey = targetKey;
      if (entry.latestFrame) {
        lease.forward("frame", entry.latestFrame);
      }
      if (!entry.helper.isRunning) {
        try {
          entry.helper.start();
        } catch (error) {
          entry.leases.delete(lease);
          lease.entryKey = null;
          this.entries.delete(targetKey);
          throw error;
        }
      }
    });
  }

  async detach(lease: PooledSimulatorCaptureHelperLease): Promise<void> {
    const entryKey = lease.entryKey;
    lease.entryKey = null;
    if (!entryKey) {
      return;
    }
    const entry = this.entries.get(entryKey);
    if (!entry) {
      return;
    }
    entry.leases.delete(lease);
    if (entry.leases.size !== 0) {
      return;
    }
    this.clearEntryIdleTimer(entry);
    entry.idleTimer = this.timer.setTimeout(() => {
      entry.idleTimer = null;
      this.enqueueBestEffort(() => this.stopIdleEntry(entry), "idle helper stop failed");
    }, this.idleTtlMs);
  }

  async invalidate(lease: PooledSimulatorCaptureHelperLease): Promise<void> {
    const entryKey = lease.entryKey;
    lease.entryKey = null;
    if (!entryKey) {
      return;
    }
    await this.enqueue(async () => {
      const entry = this.entries.get(entryKey);
      if (!entry || !entry.leases.has(lease)) {
        return;
      }
      if (entry.failed) {
        await this.stopFailedEntry(entry);
        return;
      }
      await this.stopEntry(entry);
    });
  }

  private wireHelper(entry: HelperEntry): void {
    entry.helper.on("frame", frame => {
      entry.latestFrame = frame;
      this.broadcast(entry, "frame", frame);
    });
    entry.helper.on("frameMetrics", metrics => this.broadcast(entry, "frameMetrics", metrics));
    entry.helper.on("captureMetrics", metrics => this.broadcast(entry, "captureMetrics", metrics));
    entry.helper.on("audio", audio => this.broadcast(entry, "audio", audio));
    entry.helper.on("malformed", error => this.broadcast(entry, "malformed", error));
    entry.helper.on("stderr", line => {
      // The helper can report a terminal ScreenCaptureKit error without exiting.
      // Keeping that process warm would hand the next reconnect a frozen session.
      if (isFatalHelperStderr(line) && this.entries.get(entry.key) === entry) {
        entry.failed = true;
        this.enqueueBestEffort(() => this.stopFailedEntry(entry), "failed helper stop failed");
      }
      this.broadcast(entry, "stderr", line);
    });
    entry.helper.on("readiness", readiness => this.broadcast(entry, "readiness", readiness));
    entry.helper.on("error", error => {
      if (this.entries.get(entry.key) === entry) {
        entry.failed = true;
        this.enqueueBestEffort(() => this.stopFailedEntry(entry), "failed helper stop failed");
      }
      this.broadcast(entry, "error", error);
    });
    entry.helper.on("exit", info => {
      this.broadcast(entry, "exit", info);
      if (this.entries.get(entry.key) === entry) {
        this.clearEntryIdleTimer(entry);
        this.entries.delete(entry.key);
      }
    });
  }

  private broadcast<E extends keyof IosScreenCaptureHelperEvents>(
    entry: HelperEntry,
    event: E,
    value: Parameters<IosScreenCaptureHelperEvents[E]>[0]
  ): void {
    for (const lease of entry.leases) {
      lease.forward(event, value);
    }
  }

  private async stopIdleEntry(entry: HelperEntry): Promise<void> {
    if (entry.leases.size !== 0 || this.entries.get(entry.key) !== entry) {
      return;
    }
    await this.stopEntry(entry);
  }

  private async stopFailedEntry(entry: HelperEntry): Promise<void> {
    if (this.entries.get(entry.key) !== entry) {
      return;
    }
    if (entry.failedStopFailed) {
      throw entry.failedStopError;
    }
    this.clearEntryIdleTimer(entry);
    try {
      await entry.helper.stop();
    } catch (error) {
      // Surface the stop failure to this caller, but record it so it is only
      // re-thrown to concurrent cleanup of the SAME failed entry — never to a
      // future attach. attach() drops a failedStopFailed entry and builds a
      // fresh helper instead, so the failure cannot permanently poison the
      // window target.
      entry.failedStopFailed = true;
      entry.failedStopError = error;
      throw error;
    }
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
  }

  private async stopEntry(entry: HelperEntry): Promise<void> {
    if (this.entries.get(entry.key) !== entry) {
      return;
    }
    this.clearEntryIdleTimer(entry);
    this.entries.delete(entry.key);
    await entry.helper.stop();
  }

  // All pool mutations serialize through one global chain rather than a
  // per-target queue. attach() mutates cross-target state — it evicts idle
  // entries belonging to *other* window keys before creating a new helper — so
  // a per-key queue could stop an entry that a concurrent attach on that key is
  // adopting. A slow helper.stop() therefore does delay an attach on an
  // unrelated simulator; that is an accepted trade for the eviction invariant,
  // since concurrent multi-simulator streaming is rare and the stops are
  // TTL-bounded best-effort work. Revisit with per-key serialization only after
  // decoupling the cross-target eviction from attach.
  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.transition.then(action, action);
    this.transition = next.catch(() => undefined);
    return next;
  }

  private enqueueBestEffort(action: () => Promise<void>, failureMessage: string): void {
    void this.enqueue(action).catch(error => {
      logger.warn(`[IOSSimulatorCaptureHelperPool] ${failureMessage}: ${error}`);
    });
  }

  private clearEntryIdleTimer(entry: HelperEntry): void {
    if (entry.idleTimer) {
      this.timer.clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }
}

class PooledSimulatorCaptureHelperLease extends EventEmitter implements IosSimulatorCaptureHelperLease {
  private started = false;
  private attachment: Promise<void> | null = null;
  private attachmentGeneration = 0;
  entryKey: string | null = null;

  constructor(
    private readonly pool: IOSSimulatorCaptureHelperPool,
    readonly options: IosScreenCaptureHelperOptions
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("IOSSimulatorCaptureHelperLease already started");
    }
    this.started = true;
    const attachment = this.pool.attach(this);
    const attachmentGeneration = ++this.attachmentGeneration;
    this.attachment = attachment;
    try {
      await attachment;
    } catch (error) {
      this.started = false;
      throw error;
    } finally {
      if (this.attachmentGeneration === attachmentGeneration) {
        this.attachment = null;
      }
    }
  }

  async stop(): Promise<null> {
    if (!this.started) {
      return null;
    }
    this.started = false;
    this.removeAllListeners();
    await this.attachment?.catch(() => undefined);
    await this.pool.detach(this);
    return null;
  }

  async invalidate(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.removeAllListeners();
    await this.attachment?.catch(() => undefined);
    await this.pool.invalidate(this);
  }

  get isStarted(): boolean {
    return this.started;
  }

  forward<E extends keyof IosScreenCaptureHelperEvents>(
    event: E,
    value: Parameters<IosScreenCaptureHelperEvents[E]>[0]
  ): void {
    if (this.started) {
      this.emit(event, value);
    }
  }
}

function helperTargetKey(target: CaptureTarget, binaryPath: string): string {
  if (target.kind !== "simulator") {
    throw new Error("Simulator helper pool received a non-simulator target.");
  }
  return JSON.stringify({
    binaryPath,
    windowID: target.windowID,
    fps: target.fps,
    audio: target.audio === true,
  });
}

function isFatalHelperStderr(line: string): boolean {
  const normalized = line.trimStart().toLowerCase();
  return normalized.startsWith("error:") || normalized.includes("warn: no frames received");
}

export const iosSimulatorCaptureHelperPool = new IOSSimulatorCaptureHelperPool();
