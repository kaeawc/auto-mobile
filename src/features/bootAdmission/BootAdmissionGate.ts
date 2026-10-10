import {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../../models/BootedDeviceDiscoveryIncompleteError";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { Platform } from "../../models/Platform";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type { CapacityLimits } from "./capacityLimits";

/**
 * Platform-neutral boot admission (#11181): the ledger of admitted boots, the
 * immediate admit-or-refuse decision and the capacity-exhausted failure shared by the Android
 * emulator gate and the iOS simulator gate.
 */

/** Opt-out switch for every boot admission gate; exact `0` disables. */
export const BOOT_CAPACITY_GATE_ENV = "AUTOMOBILE_BOOT_CAPACITY_GATE";
/** iOS-only override of {@link BOOT_CAPACITY_GATE_ENV}: exact `0` disables, exact `1` enables. */
export const IOS_SIM_CAPACITY_GATE_ENV = "AUTOMOBILE_IOS_SIM_CAPACITY_GATE";

/**
 * Suggested wait before retrying a refused boot. Capacity frees when another
 * device shuts down, which takes seconds, not a boot's worth of time; a short
 * fixed hint lets a caller poll without hammering `adb`/`simctl`.
 */
export const DEFAULT_ADMISSION_RETRY_AFTER_MS = 5_000;

/**
 * Whether boots of `platform` go through admission. On by default; the iOS
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

/** A boot the gate refuses now: the platform is at its device-count limit. */
export interface RefusedCapacityDecision {
  outcome: "refuse";
  reason: "at-capacity";
  limits: CapacityLimits;
  bootedCount: number;
  retryAfterMs: number;
  message: string;
  /** Counted devices this process did not start (e.g. launched from Android Studio). */
  externalDevices?: string[];
}

export interface BootAdmissionResult<D> {
  decision: D | RefusedCapacityDecision;
  /**
   * Present when the boot was admitted a boot: it counts toward the limit until
   * released, so concurrent callers cannot all be admitted against one free
   * slot before the first boot shows up in the platform's listing.
   */
  releaseAdmission?: () => void;
}

/** The at-capacity refusal, or undefined when one more boot fits. */
export function atCapacityDecision(
  bootedCount: number,
  limits: CapacityLimits,
  retryAfterMs: number,
  describe: { noun: string; envName: string; externalDevices?: readonly string[] },
): RefusedCapacityDecision | undefined {
  if (bootedCount < limits.maxBooted) {
    return undefined;
  }
  const external = describe.externalDevices ?? [];
  const externalNote =
    external.length > 0
      ? ` ${external.length} of them were not started by AutoMobile but still count toward the limit: ${external.join(", ")}.`
      : "";
  const optOut = external.length > 0 ? ` or disable the gate with ${BOOT_CAPACITY_GATE_ENV}=0` : "";
  return {
    outcome: "refuse",
    reason: "at-capacity",
    limits,
    bootedCount,
    retryAfterMs,
    ...(external.length > 0 ? { externalDevices: [...external] } : {}),
    message: `${bootedCount} ${describe.noun}(s) booted; limit is ${limits.maxBooted} (${limits.source}).${externalNote} Shut one down, raise the limit with ${describe.envName}${optOut}.`,
  };
}

export interface BootAdmissionOptions<S, D extends { outcome: string }> {
  timer: Timer;
  /** Platform being sampled: a sample timeout means its booted count is unknown. */
  platform: Platform;
  signal?: AbortSignal;
  /** e.g. "iOS simulator capacity"; used in timeout and cancellation messages. */
  label: string;
  /** Bound on the one capacity sample; defaults to {@link DEFAULT_SAMPLE_TIMEOUT_MS}. */
  sampleTimeoutMs?: number;
  /** One fresh capacity sample. */
  sample: () => Promise<S>;
  /** The ledger whose in-flight boots the sample may not yet reflect. */
  ledger: BootAdmissionLedger;
  /**
   * Synchronous so a caller decides and records its admission without an interleaving. Pass the
   * `window` to the ledger's `inFlightCount` so a boot released mid-sample still counts.
   */
  decide: (sample: S, window: LedgerSampleWindow) => D | RefusedCapacityDecision;
  /** Records the admission; returns its release. Called synchronously after `decide`. */
  admit: (decision: D) => () => void;
}

export const DEFAULT_SAMPLE_TIMEOUT_MS = 15_000;

/**
 * Takes one capacity sample and decides at once (owner decision 2026-10-09:
 * a platform at its limit fails the boot immediately instead of queueing it
 * against the boot's budget). A refusal carries no admission; an allowed
 * decision is recorded in the same synchronous turn, so concurrent callers
 * cannot all take one free slot.
 */
export async function admitBootNow<S, D extends { outcome: string }>(
  options: BootAdmissionOptions<S, D>,
): Promise<BootAdmissionResult<D>> {
  options.signal?.throwIfAborted();
  // A boot in flight when the sample starts must still hold its slot in this decision even if it
  // ends before the sample returns: the (possibly slow) listing may predate it (#11465).
  const window = options.ledger.beginSample();
  let sample: S;
  try {
    sample = await sampleWithin(options);
  } finally {
    window.close();
  }
  options.signal?.throwIfAborted();
  const decision = options.decide(sample, window);
  if (isRefused(decision)) {
    return { decision };
  }
  return { decision, releaseAdmission: options.admit(decision) };
}

function isRefused<D extends { outcome: string }>(
  decision: D | RefusedCapacityDecision,
): decision is RefusedCapacityDecision {
  return decision.outcome === "refuse";
}

/** A capacity sample bounded by a timeout and cancellation. */
async function sampleWithin<S, D extends { outcome: string }>(
  options: BootAdmissionOptions<S, D>,
): Promise<S> {
  const { timer } = options;
  const timeoutMs = options.sampleTimeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS;
  return await raceWithDeadline(options.sample, {
    timer,
    timeoutMs,
    signal: options.signal,
    label: `Collecting ${options.label}`,
    timeoutError: () => sampleTimeoutError(options.platform, timeoutMs, options.label),
  });
}

/**
 * An unfinished sample leaves the booted count unknown, which never fails open: retryable
 * `discovery_incomplete`, as for a failed listing.
 */
function sampleTimeoutError(
  platform: Platform,
  timeoutMs: number,
  label: string,
): BootedDeviceDiscoveryIncompleteError {
  const discoveryError = {
    code: "timeout",
    message: `timed out after ${timeoutMs}ms collecting ${label}`,
    retryable: true,
  } as const;
  return platform === "android"
    ? new AndroidBootedDeviceDiscoveryIncompleteError(discoveryError)
    : new BootedDeviceDiscoveryIncompleteError(platform, discoveryError);
}

/** Throws the typed retryable {@link BootCapacityExhaustedError} when the boot was refused. */
export function assertBootCapacityGranted<D extends { outcome: string }>(
  result: BootAdmissionResult<D>,
  platform: Platform,
  noun: string,
): void {
  const { decision } = result;
  if (!isRefused(decision)) {
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
    `Refused to boot: no ${noun} capacity (code capacity_exhausted, retryable; retry after ${decision.retryAfterMs}ms): ${decision.message}`,
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
 * Boots in flight when a capacity sample started. Entries released while it runs stay in
 * `released`, because the sample may have been taken before the device showed up in the listing.
 */
export interface LedgerSampleWindow {
  close(): void;
}

class SampleWindow implements LedgerSampleWindow {
  readonly released: LedgerEntry[] = [];

  constructor(
    readonly inFlightAtStart: ReadonlySet<symbol>,
    private readonly onClose: (window: SampleWindow) => void,
  ) {}

  close(): void {
    this.onClose(this);
  }
}

/**
 * Boots admitted by a gate and not yet visible in the platform listing. Each
 * counts toward the limit, so concurrent callers cannot all be admitted
 * against one free slot.
 */
export class BootAdmissionLedger {
  private readonly entries = new Map<symbol, LedgerEntry>();
  private readonly openWindows = new Set<SampleWindow>();

  constructor(private readonly timer: Pick<Timer, "now">) {}

  admit(deviceId?: string): LedgerAdmission {
    const token = Symbol("boot-admission");
    this.entries.set(token, { deviceId });
    return {
      release: () => {
        const entry = this.entries.get(token);
        if (!entry) {
          return;
        }
        this.entries.delete(token);
        for (const window of this.openWindows) {
          if (window.inFlightAtStart.has(token)) {
            window.released.push(entry);
          }
        }
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

  /** Start tracking the boots in flight now; `close` it once the sample returns. */
  beginSample(): LedgerSampleWindow {
    const window = new SampleWindow(new Set(this.entries.keys()), (closed) =>
      this.openWindows.delete(closed),
    );
    this.openWindows.add(window);
    return window;
  }

  /**
   * Admitted boots the listing does not already show. A handed-off boot that
   * is now visible, or past its hand-off window, leaves the ledger here.
   * An entry for `excludeDeviceId` is not counted: a boot's own target needs no second slot.
   */
  inFlightCount(
    visibleDeviceIds: ReadonlySet<string>,
    excludeDeviceId?: string,
    sampleWindow?: LedgerSampleWindow,
  ): number {
    const now = this.timer.now();
    let count = this.releasedDuringSample(sampleWindow, visibleDeviceIds, excludeDeviceId, now);
    for (const [token, entry] of this.entries) {
      const visible = entry.deviceId !== undefined && visibleDeviceIds.has(entry.deviceId);
      if (entry.handedOffUntilMs !== undefined && (visible || now >= entry.handedOffUntilMs)) {
        this.entries.delete(token);
      } else if (
        !visible &&
        (excludeDeviceId === undefined || entry.deviceId !== excludeDeviceId)
      ) {
        count += 1;
      }
    }
    return count;
  }

  /** Boots that ended after the sample started and that the sample does not show either. */
  private releasedDuringSample(
    window: LedgerSampleWindow | undefined,
    visibleDeviceIds: ReadonlySet<string>,
    excludeDeviceId: string | undefined,
    now: number,
  ): number {
    if (!(window instanceof SampleWindow)) {
      return 0;
    }
    return window.released.filter(
      (entry) =>
        !(entry.handedOffUntilMs !== undefined && now >= entry.handedOffUntilMs) &&
        !(entry.deviceId !== undefined && visibleDeviceIds.has(entry.deviceId)) &&
        (excludeDeviceId === undefined || entry.deviceId !== excludeDeviceId),
    ).length;
  }
}

/** The capacity numbers `listDevices` reports per platform. */
export interface BootCapacitySnapshot {
  limit: number;
  /** Booted devices of the platform, including ones started outside AutoMobile. */
  booted: number;
  /** Admitted boots not yet visible as booted. */
  inFlight: number;
  /** Reported only, never a reason to refuse a boot (#11209). iOS only. */
  hostPressure?: { sustained: boolean; consecutiveSamples: number; memoryPressure: string };
}

/**
 * Read-only "would a cold boot be refused now" check: throws the typed retryable
 * `BootCapacityExhaustedError` at the limit and takes no admission. Lets a caller refuse before a
 * side effect (creating a device it would then have to delete) rather than after it (#11236).
 */
export interface BootCapacityChecker {
  assertCapacityAvailable(options?: { signal?: AbortSignal }): Promise<void>;
}

/** Read-only capacity report a gate exposes to listings. */
export interface BootCapacityReporter {
  describeCapacity(options?: { signal?: AbortSignal }): Promise<BootCapacitySnapshot>;
}
