import { ActionableError } from "../../models/ActionableError";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { Platform } from "../../models/Platform";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type { CapacityLimits } from "./capacityLimits";

/**
 * Platform-neutral boot admission (#11181): the ledger of admitted boots, the
 * queue/wait loop and the capacity-exhausted failure shared by the Android
 * emulator gate and the iOS simulator gate.
 */

/** Opt-out switch for every boot admission gate; exact `0` disables. */
export const BOOT_CAPACITY_GATE_ENV = "AUTOMOBILE_BOOT_CAPACITY_GATE";
/** iOS-only override of {@link BOOT_CAPACITY_GATE_ENV}: exact `0` disables, exact `1` enables. */
export const IOS_SIM_CAPACITY_GATE_ENV = "AUTOMOBILE_IOS_SIM_CAPACITY_GATE";

export const DEFAULT_ADMISSION_RETRY_AFTER_MS = 5_000;

/**
 * Whether boots of `platform` wait for admission. On by default; the iOS
 * override wins over the shared switch when it is exactly `0` or `1`.
 */
export function isBootCapacityGateEnabled(platform: Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === "ios") {
    const iosOverride = env[IOS_SIM_CAPACITY_GATE_ENV]?.trim();
    if (iosOverride === "0" || iosOverride === "1") {
      return iosOverride === "1";
    }
  }
  return env[BOOT_CAPACITY_GATE_ENV]?.trim() !== "0";
}

/** A wait that must keep waiting: the platform is at its limit or the host is under pressure. */
export interface QueuedCapacityDecision {
  outcome: "queue";
  reason: "at-capacity" | "sustained-pressure";
  limits: CapacityLimits;
  bootedCount: number;
  retryAfterMs: number;
  message: string;
  /** Counted devices this process did not start (e.g. launched from Android Studio). */
  externalDevices?: string[];
}

export interface BootAdmissionWaitResult<D> {
  decision: D | QueuedCapacityDecision;
  waitedMs: number;
  timedOut: boolean;
  /**
   * Present when the wait admitted a boot: it counts toward the limit until
   * released, so concurrent waiters cannot all be admitted against one free
   * slot before the first boot shows up in the platform's listing.
   */
  releaseAdmission?: () => void;
}

/** The at-capacity queue decision, or undefined when one more boot fits. */
export function atCapacityDecision(
  bootedCount: number,
  limits: CapacityLimits,
  retryAfterMs: number,
  describe: { noun: string; envName: string; externalDevices?: readonly string[] },
): QueuedCapacityDecision | undefined {
  if (bootedCount < limits.maxBooted) {
    return undefined;
  }
  const external = describe.externalDevices ?? [];
  const externalNote =
    external.length > 0
      ? ` ${external.length} of them were not started by AutoMobile but still count toward the limit: ${external.join(", ")}.`
      : "";
  const optOut =
    external.length > 0 ? ` or disable the gate with ${BOOT_CAPACITY_GATE_ENV}=0` : "";
  return {
    outcome: "queue",
    reason: "at-capacity",
    limits,
    bootedCount,
    retryAfterMs,
    ...(external.length > 0 ? { externalDevices: [...external] } : {}),
    message: `${bootedCount} ${describe.noun}(s) booted; limit is ${limits.maxBooted} (${limits.source}).${externalNote} Shut one down, raise the limit with ${describe.envName}${optOut}.`,
  };
}

export interface BootAdmissionWaitOptions<S, D extends { outcome: string }> {
  timer: Timer;
  /** Absolute deadline on the timer's clock. */
  deadlineMs: number;
  signal?: AbortSignal;
  /** e.g. "iOS simulator capacity"; used in timeout and cancellation messages. */
  label: string;
  /** One fresh capacity sample, bounded by the remaining deadline. */
  sample: () => Promise<S>;
  /** Synchronous so a waiter decides and records its admission without an interleaving. */
  decide: (sample: S) => D | QueuedCapacityDecision;
  /** Records the admission; returns its release. Called synchronously after `decide`. */
  admit: (decision: D) => () => void;
}

/**
 * Polls `sample` with the injected timer until `decide` admits the boot, the
 * next poll would pass the deadline, or the signal aborts.
 */
export async function waitForBootAdmission<S, D extends { outcome: string }>(
  options: BootAdmissionWaitOptions<S, D>,
): Promise<BootAdmissionWaitResult<D>> {
  const { timer } = options;
  const startedAt = timer.now();
  for (;;) {
    options.signal?.throwIfAborted();
    const sample = await sampleWithin(options, startedAt);
    options.signal?.throwIfAborted();
    const decision = options.decide(sample);
    const waitedMs = timer.now() - startedAt;
    if (!isQueued(decision)) {
      return { decision, waitedMs, timedOut: false, releaseAdmission: options.admit(decision) };
    }
    if (timer.now() + decision.retryAfterMs > options.deadlineMs) {
      return { decision, waitedMs, timedOut: true };
    }
    await raceWithDeadline(timer.sleep(decision.retryAfterMs), {
      timer,
      signal: options.signal,
      label: `Waiting for ${options.label}`,
    });
  }
}

function isQueued<D extends { outcome: string }>(
  decision: D | QueuedCapacityDecision,
): decision is QueuedCapacityDecision {
  return decision.outcome === "queue";
}

/** A capacity sample bounded by the wait's deadline and cancellation. */
async function sampleWithin<S, D extends { outcome: string }>(
  options: BootAdmissionWaitOptions<S, D>,
  startedAt: number,
): Promise<S> {
  const { timer } = options;
  const remainingMs = Math.floor(options.deadlineMs - timer.now());
  const timedOut = () =>
    new ActionableError(
      `Timed out after ${timer.now() - startedAt}ms collecting ${options.label}.`,
    );
  if (remainingMs <= 0) {
    throw timedOut();
  }
  return await raceWithDeadline(options.sample, {
    timer,
    timeoutMs: remainingMs,
    signal: options.signal,
    label: `Collecting ${options.label}`,
    timeoutError: timedOut,
  });
}

/** Throws the typed retryable {@link BootCapacityExhaustedError} when a wait ended without capacity. */
export function assertBootCapacityGranted<D extends { outcome: string }>(
  result: BootAdmissionWaitResult<D>,
  platform: Platform,
  noun: string,
): void {
  const { decision } = result;
  if (!result.timedOut || !isQueued(decision)) {
    return;
  }
  throw new BootCapacityExhaustedError(
    {
      platform,
      limit: decision.limits.maxBooted,
      booted: decision.bootedCount,
      retryAfterMs: decision.retryAfterMs,
      ...(decision.externalDevices ? { externalDevices: decision.externalDevices } : {}),
    },
    `Timed out after ${result.waitedMs}ms waiting for ${noun} capacity (code capacity_exhausted, retryable): ${decision.message}`,
  );
}

interface LedgerEntry {
  deviceId?: string;
  /** Set once the boot was handed off: the entry ends when the device is visible or this passes. */
  handedOffUntilMs?: number;
}

/** A ledger entry's handle; `handOff` takes the absolute end of the hand-off window. */
export interface LedgerAdmission {
  release(): void;
  handOff(deviceId: string | undefined, untilMs: number): void;
}

/**
 * Boots admitted by a gate and not yet visible in the platform listing. Each
 * counts toward the limit, so concurrent waiters cannot all be admitted
 * against one free slot.
 */
export class BootAdmissionLedger {
  private readonly entries = new Map<symbol, LedgerEntry>();

  constructor(private readonly timer: Pick<Timer, "now">) {}

  admit(deviceId?: string): LedgerAdmission {
    const token = Symbol("boot-admission");
    this.entries.set(token, { deviceId });
    return {
      release: () => {
        this.entries.delete(token);
      },
      handOff: (handedOffDeviceId, untilMs) => {
        const entry = this.entries.get(token);
        if (entry) {
          this.entries.set(token, {
            deviceId: handedOffDeviceId ?? entry.deviceId,
            handedOffUntilMs: untilMs,
          });
        }
      },
    };
  }

  /**
   * Admitted boots the listing does not already show. A handed-off boot that
   * is now visible, or past its hand-off window, leaves the ledger here.
   */
  inFlightCount(visibleDeviceIds: ReadonlySet<string>): number {
    const now = this.timer.now();
    let count = 0;
    for (const [token, entry] of this.entries) {
      const visible = entry.deviceId !== undefined && visibleDeviceIds.has(entry.deviceId);
      if (entry.handedOffUntilMs !== undefined && (visible || now >= entry.handedOffUntilMs)) {
        this.entries.delete(token);
      } else if (!visible) {
        count += 1;
      }
    }
    return count;
  }
}

/** The capacity numbers `listDevices` reports per platform. */
export interface BootCapacitySnapshot {
  limit: number;
  /** Booted devices of the platform, including ones started outside AutoMobile. */
  booted: number;
  /** Admitted boots not yet visible as booted. */
  inFlight: number;
}

/** Read-only capacity report a gate exposes to listings. */
export interface BootCapacityReporter {
  describeCapacity(options?: { signal?: AbortSignal }): Promise<BootCapacitySnapshot>;
}
