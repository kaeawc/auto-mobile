import { logger } from "../../utils/logger";
import { PooledSimulatorCaptureHelperLease } from "./PooledSimulatorCaptureHelperLease";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  IosScreenCaptureHelper,
  type CapturePermission,
  type CaptureTarget,
  type IosScreenCaptureHelperEvents,
  type IosScreenCaptureHelperOptions,
  type IosScreenCaptureReadiness,
  type NativeFrameMetrics,
} from "./IosScreenCaptureHelper";
import type { DecodedAudio, DecodedEncodedVideo, MalformedFrameError } from "./frameProtocol";

export const IOS_SIMULATOR_HELPER_IDLE_TTL_MS = 45_000;
/** Ceiling for a helper stop while holding a target's serialized transition. */
export const IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS = 5_000;

export interface IosSimulatorCaptureHelperLease {
  start(): void | Promise<void>;
  stop(): Promise<unknown>;
  invalidate(): Promise<void>;
  /** Ask the in-helper encoder to emit a fresh IDR. */
  requestKeyFrame(): boolean;
  on(event: "idle", listener: (info: { windowID: number }) => void): this;
  on(event: "encodedVideo", listener: (video: DecodedEncodedVideo) => void): this;
  on(event: "capability", listener: (token: string) => void): this;
  on(event: "permission", listener: (permission: CapturePermission) => void): this;
  on(event: "permissionTarget", listener: (target: string) => void): this;
  on(event: "captureMetrics", listener: (metrics: NativeFrameMetrics) => void): this;
  on(event: "audio", listener: (audio: DecodedAudio) => void): this;
  on(event: "malformed", listener: (error: MalformedFrameError) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  on(event: "readiness", listener: (status: IosScreenCaptureReadiness) => void): this;
  on(
    event: "exit",
    listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
}

type SimulatorHelper = Pick<
  IosScreenCaptureHelper,
  "start" | "stop" | "isRunning" | "requestKeyFrame"
> & {
  on<E extends keyof IosScreenCaptureHelperEvents>(
    event: E,
    listener: IosScreenCaptureHelperEvents[E],
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
  windowID: number;
  helper: SimulatorHelper;
  capabilities: Set<string>;
  leases: Set<PooledSimulatorCaptureHelperLease>;
  idleTimer: NodeJS.Timeout | null;
  failed: boolean;
  failedStopFailed: boolean;
  failedStopError: unknown;
}

/**
 * Keeps encoded Simulator helpers warm across reconnect gaps. Encoder settings
 * are part of the target identity; each attaching lease requests a fresh IDR.
 */
export class IosSimulatorCaptureHelperPool {
  private readonly idleTtlMs: number;
  private readonly timer: Timer;
  private readonly createHelper: SimulatorHelperFactory;
  private readonly entries = new Map<string, HelperEntry>();
  private readonly transitions = new Map<number, Promise<void>>();
  private shutdownTransition: Promise<void> = Promise.resolve();

  constructor(options: SimulatorCaptureHelperPoolOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? IOS_SIMULATOR_HELPER_IDLE_TTL_MS;
    this.timer = options.timer ?? defaultTimer;
    this.createHelper =
      options.createHelper ?? ((helperOptions) => new IosScreenCaptureHelper(helperOptions));
  }

  acquire(options: IosScreenCaptureHelperOptions): IosSimulatorCaptureHelperLease {
    if (options.target.kind !== "simulator") {
      throw new Error("IOSSimulatorCaptureHelperPool only accepts simulator targets.");
    }
    if (!options.target.encode) {
      throw new Error("IOSSimulatorCaptureHelperPool requires H.264 encode settings.");
    }
    return new PooledSimulatorCaptureHelperLease(this, options);
  }

  async shutdown(): Promise<void> {
    const pending = [...this.transitions.values()];
    const shutdown = this.shutdownTransition.then(async () => {
      await Promise.all(pending);
      const entries = [...this.entries.values()];
      this.entries.clear();
      for (const entry of entries) {
        this.clearEntryIdleTimer(entry);
        await this.stopHelperWithinDeadline(entry).catch((error) => {
          logger.debug(`[IOSSimulatorCaptureHelperPool] helper shutdown failed: ${error}`);
        });
      }
    });
    this.shutdownTransition = shutdown.catch(() => undefined);
    await shutdown;
  }

  async attach(lease: PooledSimulatorCaptureHelperLease): Promise<void> {
    await this.enqueue(simulatorWindowID(lease.options.target), async () => {
      if (!lease.isStarted) {
        return;
      }
      const targetKey = helperTargetKey(lease.options.target, lease.options.binaryPath);
      const entry = await this.resolveOrCreateEntry(targetKey, lease);
      if (entry !== null) {
        this.finalizeAttach(entry, lease, targetKey);
      }
    });
  }

  /**
   * Return the live entry for `targetKey`, creating (and wiring) a fresh helper
   * when none is usable. Returns null when the lease was stopped mid-eviction.
   */
  private async resolveOrCreateEntry(
    targetKey: string,
    lease: PooledSimulatorCaptureHelperLease,
  ): Promise<HelperEntry | null> {
    let entry = this.entries.get(targetKey);
    if (entry?.failedStopFailed) {
      // A previous helper.stop() threw and left this entry poisoned. The failure
      // was already surfaced once (to the awaiting invalidate/best-effort
      // cleanup). Drop the entry now so this attach can build a fresh helper
      // instead of re-throwing the same error forever — bounded retry, not
      // permanent poison of the window target.
      this.clearEntryIdleTimer(entry);
      this.entries.delete(targetKey);
      entry = undefined;
    }
    if (entry) {
      return entry;
    }
    // A new CGWindowID proves a reboot/window recreation. Evict any idle session
    // now rather than letting it occupy ScreenCaptureKit resources through its
    // TTL, but never disrupt a different active simulator stream.
    const attachingWindowID = simulatorWindowID(lease.options.target);
    for (const candidate of this.entries.values()) {
      if (candidate.key !== targetKey && candidate.leases.size === 0) {
        if (candidate.windowID === attachingWindowID) {
          await this.stopIdleEntry(candidate);
        } else {
          this.enqueueBestEffort(
            candidate.windowID,
            () => this.stopIdleEntry(candidate),
            "idle helper eviction failed",
          );
        }
      }
    }
    if (!lease.isStarted) {
      return null;
    }
    const created: HelperEntry = {
      key: targetKey,
      windowID: simulatorWindowID(lease.options.target),
      helper: this.createHelper(lease.options),
      capabilities: new Set(),
      leases: new Set(),
      idleTimer: null,
      failed: false,
      failedStopFailed: false,
      failedStopError: undefined,
    };
    this.entries.set(targetKey, created);
    this.wireHelper(created);
    return created;
  }

  /** Register the lease on the entry, start the helper if idle, and warm-start it. */
  private finalizeAttach(
    entry: HelperEntry,
    lease: PooledSimulatorCaptureHelperLease,
    targetKey: string,
  ): void {
    this.clearEntryIdleTimer(entry);
    entry.leases.add(lease);
    lease.entryKey = targetKey;
    // A warm helper sent its startup handshake before this lease attached.
    for (const token of entry.capabilities) {
      lease.forward("capability", token);
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
    // A warm helper may be mid-GOP; every attaching lease needs a fresh IDR.
    entry.helper.requestKeyFrame();
  }

  /**
   * Relay a lease's keyframe request to its warm helper's STDIN control channel
   * (issue #4789). Synchronous best-effort: it reads the current entry directly
   * rather than serializing through a transition chain, because a PLI-driven IDR
   * must not queue behind a slow helper stop. Returns false
   * when the lease is detached or its helper is not running.
   */
  requestKeyFrame(lease: PooledSimulatorCaptureHelperLease): boolean {
    const entryKey = lease.entryKey;
    if (!entryKey) {
      return false;
    }
    const entry = this.entries.get(entryKey);
    if (!entry || !entry.leases.has(lease)) {
      return false;
    }
    return entry.helper.requestKeyFrame();
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
      this.enqueueBestEffort(
        entry.windowID,
        () => this.stopIdleEntry(entry),
        "idle helper stop failed",
      );
    }, this.idleTtlMs);
  }

  async invalidate(lease: PooledSimulatorCaptureHelperLease): Promise<void> {
    const entryKey = lease.entryKey;
    lease.entryKey = null;
    if (!entryKey) {
      return;
    }
    await this.enqueue(simulatorWindowID(lease.options.target), async () => {
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
    entry.helper.on("idle", (info) => this.broadcast(entry, "idle", info));
    entry.helper.on("encodedVideo", (video) => this.broadcast(entry, "encodedVideo", video));
    entry.helper.on("capability", (token) => {
      entry.capabilities.add(token);
      this.broadcast(entry, "capability", token);
    });
    entry.helper.on("permission", (permission) => this.broadcast(entry, "permission", permission));
    entry.helper.on("permissionTarget", (target) =>
      this.broadcast(entry, "permissionTarget", target),
    );
    entry.helper.on("captureMetrics", (metrics) =>
      this.broadcast(entry, "captureMetrics", metrics),
    );
    entry.helper.on("audio", (audio) => this.broadcast(entry, "audio", audio));
    entry.helper.on("malformed", (error) => this.broadcast(entry, "malformed", error));
    entry.helper.on("stderr", (line) => {
      // The helper can report a terminal ScreenCaptureKit error without exiting.
      // Keeping that process warm would hand the next reconnect a frozen session.
      if (isFatalHelperStderr(line) && this.entries.get(entry.key) === entry) {
        entry.failed = true;
        this.enqueueBestEffort(
          entry.windowID,
          () => this.stopFailedEntry(entry),
          "failed helper stop failed",
        );
      }
      this.broadcast(entry, "stderr", line);
    });
    entry.helper.on("readiness", (readiness) => this.broadcast(entry, "readiness", readiness));
    entry.helper.on("error", (error) => {
      if (this.entries.get(entry.key) === entry) {
        entry.failed = true;
        this.enqueueBestEffort(
          entry.windowID,
          () => this.stopFailedEntry(entry),
          "failed helper stop failed",
        );
      }
      this.broadcast(entry, "error", error);
    });
    entry.helper.on("exit", (info) => {
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
    value: Parameters<IosScreenCaptureHelperEvents[E]>[0],
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
      await this.stopHelperWithinDeadline(entry);
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
    await this.stopHelperWithinDeadline(entry);
  }

  private async stopHelperWithinDeadline(entry: HelperEntry): Promise<void> {
    const stop = entry.helper.stop();
    let didTimeOut = false;
    // The helper owns process escalation. A late stop failure is only background
    // cleanup after the pool has released its target's serialized transition.
    void stop.catch((error) => {
      if (didTimeOut) {
        logger.debug(`[IOSSimulatorCaptureHelperPool] helper stop failed after timeout: ${error}`);
      }
    });
    const timeout = new Error("Helper stop deadline expired");
    try {
      await raceWithDeadline(stop, {
        timer: this.timer,
        timeoutMs: IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS,
        label: "Helper stop",
        timeoutError: () => timeout,
        onTimeout: () => {
          didTimeOut = true;
          logger.warn(
            `[IOSSimulatorCaptureHelperPool] helper stop exceeded ${IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS}ms`,
          );
        },
      });
    } catch (error) {
      if (error !== timeout) {
        throw error;
      }
    }
  }

  private enqueue(windowID: number, action: () => Promise<void>): Promise<void> {
    const previous = this.transitions.get(windowID) ?? Promise.resolve();
    const next = Promise.all([previous, this.shutdownTransition]).then(action);
    const settled = next.catch(() => undefined);
    this.transitions.set(windowID, settled);
    void settled.then(() => {
      if (this.transitions.get(windowID) === settled) {
        this.transitions.delete(windowID);
      }
    });
    return next;
  }

  private enqueueBestEffort(
    windowID: number,
    action: () => Promise<void>,
    failureMessage: string,
  ): void {
    void this.enqueue(windowID, action).catch((error) => {
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

function helperTargetKey(target: CaptureTarget, binaryPath: string): string {
  if (target.kind !== "simulator") {
    throw new Error("Simulator helper pool received a non-simulator target.");
  }
  // Encoder config (mode + bitrate) is part of the identity: a lease whose encode
  // settings differ from a warm helper's cannot adopt it (no live reconfiguration
  // in v1), so a mismatched acquire gets an independent entry (issue #4789).
  return JSON.stringify({
    binaryPath,
    windowID: target.windowID,
    fps: target.fps,
    audio: target.audio === true,
    encode: target.encode,
  });
}

function simulatorWindowID(target: CaptureTarget): number {
  if (target.kind !== "simulator") {
    throw new Error("Simulator helper pool received a non-simulator target.");
  }
  return target.windowID;
}

function isFatalHelperStderr(line: string): boolean {
  const normalized = line.trimStart().toLowerCase();
  return normalized.startsWith("error:") || normalized.includes("warn: no frames received");
}

export const iosSimulatorCaptureHelperPool = new IosSimulatorCaptureHelperPool();
