import { EventEmitter } from "node:events";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  IOSScreenCaptureHelper,
  type CaptureTarget,
  type IosScreenCaptureHelperEvents,
  type IosScreenCaptureHelperOptions,
  type IosScreenCaptureReadiness,
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
  on(event: "frame", listener: (frame: DecodedFrame) => void): this;
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
      void this.enqueue(() => this.stopIdleEntry(entry));
    }, this.idleTtlMs);
  }

  private wireHelper(entry: HelperEntry): void {
    entry.helper.on("frame", frame => {
      entry.latestFrame = frame;
      this.broadcast(entry, "frame", frame);
    });
    entry.helper.on("audio", audio => this.broadcast(entry, "audio", audio));
    entry.helper.on("malformed", error => this.broadcast(entry, "malformed", error));
    entry.helper.on("stderr", line => this.broadcast(entry, "stderr", line));
    entry.helper.on("readiness", readiness => this.broadcast(entry, "readiness", readiness));
    entry.helper.on("error", error => {
      this.broadcast(entry, "error", error);
      if (this.entries.get(entry.key) === entry) {
        void this.enqueue(() => this.stopFailedEntry(entry));
      }
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
    await this.stopEntry(entry);
  }

  private async stopEntry(entry: HelperEntry): Promise<void> {
    if (this.entries.get(entry.key) !== entry) {
      return;
    }
    this.clearEntryIdleTimer(entry);
    this.entries.delete(entry.key);
    await entry.helper.stop();
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.transition.then(action, action);
    this.transition = next.catch(() => undefined);
    return next;
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
    this.attachment = attachment;
    try {
      await attachment;
    } catch (error) {
      this.started = false;
      throw error;
    } finally {
      if (this.attachment === attachment) {
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

export const iosSimulatorCaptureHelperPool = new IOSSimulatorCaptureHelperPool();
