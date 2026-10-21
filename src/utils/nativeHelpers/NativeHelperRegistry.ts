import { defaultTimer, type Timer } from "../SystemTimer";
import { logger, type Logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import {
  FileNativeHelperRecordStore,
  type NativeHelperRecord,
  type NativeHelperRecordStore,
} from "./NativeHelperRecordStore";
import {
  DefaultNativeHelperProcessControl,
  type NativeHelperProcessControl,
} from "./NativeHelperProcessControl";
import {
  cleanupNow,
  emptyCleanupSummary,
  finishHelperStop,
  type NativeHelperCleanupSummary,
} from "./sweepNativeHelperOrphans";

export interface NativeHelperChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
}

export interface NativeHelperTracker {
  track(
    child: NativeHelperChild,
    options: { kind: NativeHelperRecord["kind"]; processGroup: boolean },
  ): void;
}

export interface NativeHelperRegistryOptions {
  store?: NativeHelperRecordStore;
  control?: NativeHelperProcessControl;
  ownPid?: number;
  timer?: Timer;
  logger?: Logger;
}

export class NativeHelperRegistry implements NativeHelperTracker {
  private readonly tracked = new Map<number, NativeHelperRecord>();
  private readonly store: NativeHelperRecordStore;
  private readonly control: NativeHelperProcessControl;
  private readonly ownPid: number;
  private readonly timer: Timer;
  private readonly log: Logger;

  constructor(options: NativeHelperRegistryOptions = {}) {
    this.log = options.logger ?? logger;
    this.store = options.store ?? new FileNativeHelperRecordStore(this.log);
    this.control = options.control ?? new DefaultNativeHelperProcessControl();
    this.ownPid = options.ownPid ?? process.pid;
    this.timer = options.timer ?? defaultTimer;
  }

  track(
    child: NativeHelperChild,
    options: { kind: NativeHelperRecord["kind"]; processGroup: boolean },
  ): void {
    try {
      const pid = child.pid;
      if (
        pid === undefined ||
        !Number.isSafeInteger(pid) ||
        pid <= 1 ||
        pid === this.ownPid ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        this.log.debug("[NATIVE_HELPERS] Not recording helper: no live signalable child pid");
        return;
      }
      const startIdentity = this.control.readStartIdentity(pid);
      const ownerStartIdentity = this.control.readStartIdentity(this.ownPid);
      if (!startIdentity || !ownerStartIdentity) {
        this.log.debug(
          `[NATIVE_HELPERS] Not recording helper ${pid}: process identity unavailable`,
        );
        return;
      }
      const record: NativeHelperRecord = {
        version: 1,
        ...options,
        pid,
        startIdentity,
        ownerPid: this.ownPid,
        ownerStartIdentity,
        recordedAtMs: this.timer.now(),
      };
      this.tracked.set(pid, record);
      child.once("exit", () => this.removeExited(record));
      this.store.write(record);
    } catch (error) {
      this.log.warn(`[NATIVE_HELPERS] Failed to track helper: ${errorMessage(error)}`, error);
    }
  }

  private removeExited(record: NativeHelperRecord): void {
    if (this.tracked.get(record.pid) !== record) {
      return;
    }
    this.tracked.delete(record.pid);
    try {
      this.store.remove(record.pid, record.startIdentity);
    } catch (error) {
      this.log.warn(
        `[NATIVE_HELPERS] Failed to remove exited helper ${record.pid}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  async shutdown(
    options: { timer?: Timer; graceMs?: number } = {},
  ): Promise<NativeHelperCleanupSummary> {
    const summary = emptyCleanupSummary();
    try {
      await this.shutdownTracked(options, summary);
    } catch (error) {
      this.log.warn(`[NATIVE_HELPERS] Registry shutdown failed: ${errorMessage(error)}`, error);
      summary.failed++;
    }
    return summary;
  }

  private async shutdownTracked(
    options: { timer?: Timer; graceMs?: number },
    summary: NativeHelperCleanupSummary,
  ): Promise<void> {
    const timer = options.timer ?? this.timer;
    const graceMs = Math.max(0, options.graceMs ?? 500);
    const pending: NativeHelperRecord[] = [];
    for (const record of this.tracked.values()) {
      try {
        const running = this.control.isRunning(record.pid);
        const identity = running ? this.control.readStartIdentity(record.pid) : undefined;
        if (
          running &&
          (identity === undefined ||
            this.control.compareStartIdentity(record.startIdentity, identity) === "incomparable")
        ) {
          // Uncertain identity is not proof this owned helper exited; keep it for a later sweep.
          this.log.debug(
            `[NATIVE_HELPERS] Retaining helper ${record.pid}: shutdown identity unverifiable`,
          );
          summary.failed++;
          continue;
        }
        if (!running || identity !== record.startIdentity) {
          this.removeExited(record);
          summary.staleRecordsRemoved++;
          continue;
        }
        this.control.signal(record.pid, "SIGTERM", { group: record.processGroup });
        pending.push(record);
      } catch (error) {
        this.log.warn(
          `[NATIVE_HELPERS] Failed to stop helper ${record.pid}: ${errorMessage(error)}`,
          error,
        );
        summary.failed++;
      }
    }
    // One shared grace for all helpers, rather than an unbounded per-child shutdown budget.
    const deadline = cleanupNow(timer) + 2 * graceMs + 1;
    const results = await Promise.all(
      pending.map(async (record) => {
        try {
          const result = await finishHelperStop(
            record,
            {
              store: this.store,
              control: this.control,
              timer,
              graceMs,
              logger: this.log,
              retainUnverifiableRecord: true,
            },
            deadline,
          );
          if (result !== "failed" && this.tracked.get(record.pid) === record) {
            this.tracked.delete(record.pid);
          }
          return result;
        } catch (error) {
          this.log.warn(
            `[NATIVE_HELPERS] Failed to settle helper ${record.pid}: ${errorMessage(error)}`,
            error,
          );
          return "failed" as const;
        }
      }),
    );
    for (const result of results) {
      summary[result]++;
    }
  }
}

let singleton: NativeHelperRegistry | undefined;
export function getNativeHelperRegistry(): NativeHelperRegistry {
  return (singleton ??= new NativeHelperRegistry());
}
