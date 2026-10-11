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
  // A boot that ends before the sample returns must still hold its slot in this decision, whether
  // it was admitted before or after the sample started: the (possibly slow) listing may predate
  // it (#11465, #11537).
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
  /** Pid of the process spawned for the boot, once handed off with one. */
  processId?: number;
  /** Set once the boot was handed off: the entry ends when the device is visible or this passes. */
  handedOffUntilMs?: number;
}

/**
 * A ledger entry's handle; `handOff` takes the absolute end of the hand-off window and may be
 * repeated, a later call adding the device id or process id the earlier one lacked.
 */
export interface LedgerAdmission {
  release(): void;
  handOff(deviceId: string | undefined, untilMs: number, processId?: number): void;
}

/**
 * One capacity sample in progress. Every entry that leaves the ledger while the window is open
 * stays in `ended`, whenever it was admitted: the listing may have been taken before that boot
 * showed up in it, so the boot still holds its slot for this sample's decision (#11465, #11537).
 */
export interface LedgerSampleWindow {
  close(): void;
}

class SampleWindow implements LedgerSampleWindow {
  readonly ended: LedgerEntry[] = [];

  constructor(private readonly onClose: (window: SampleWindow) => void) {}

  close(): void {
    this.onClose(this);
  }
}

/** Admitted boots a capacity sample's device listing does not show. */
export interface InFlightBoots {
  count: number;
  /**
   * How many of `count` have their own process in the sample's process listing: the boot was
   * handed off with a process id and the listing shows that process. Any other admitted boot is
   * not in the listing, whatever it shows: not spawned yet, spawned after the listing was read,
   * or spawned as a launcher that is not the counted process yet (#11564). Zero when no listed
   * process ids are given.
   */
  withListedProcess: number;
  /**
   * Boots NOT in `count`, because the device listing shows them, whose own process the process
   * listing does not show: boots in the ledger, or ended while the sample was open. The two
   * listings are read at different moments, so such a boot spawned after the process listing was
   * read and the device listing then caught it; the process listing is short by exactly that boot
   * (#11588). A listed boot handed off without a process id is one of them: it cannot be matched.
   */
  listedWithoutProcess: number;
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
      release: () => this.end(token),
      handOff: (handedOffDeviceId, untilMs, processId) => {
        const entry = this.entries.get(token);
        if (entry) {
          this.entries.set(token, {
            deviceId: handedOffDeviceId ?? entry.deviceId,
            processId: processId ?? entry.processId,
            handedOffUntilMs: untilMs,
          });
        }
      },
    };
  }

  /**
   * The only way an entry leaves the ledger. Every open sample window keeps it: a window that
   * kept only the boots in flight when it opened lost a boot admitted and ended inside it, and
   * a listing older than that boot then admitted past the limit (#11537).
   */
  private end(token: symbol, listed = false): void {
    const entry = this.entries.get(token);
    if (!entry) {
      return;
    }
    this.entries.delete(token);
    // A device a listing showed is running whatever its boot deadline says: an older listing
    // still open counts it until that sample decides, so the window keeps it without a deadline.
    const kept = listed ? { deviceId: entry.deviceId, processId: entry.processId } : entry;
    for (const window of this.openWindows) {
      window.ended.push(kept);
    }
  }

  /**
   * Start tracking the boots that end from now on; `close` it once the sample returns. The
   * sample's listing must start no earlier than this call, or a boot that ended in between is
   * in neither the window nor the listing.
   */
  beginSample(): LedgerSampleWindow {
    const window = new SampleWindow((closed) => this.openWindows.delete(closed));
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
    return this.inFlight(visibleDeviceIds, excludeDeviceId, sampleWindow).count;
  }

  /**
   * {@link inFlightCount}, split by whether the sample's process listing shows the boot's own
   * process. `listedProcessIds` holds every id that identifies a listed device process.
   */
  inFlight(
    visibleDeviceIds: ReadonlySet<string>,
    excludeDeviceId?: string,
    sampleWindow?: LedgerSampleWindow,
    listedProcessIds: ReadonlySet<number> = new Set(),
  ): InFlightBoots {
    const now = this.timer.now();
    const hasListedProcess = (entry: LedgerEntry): boolean =>
      entry.processId !== undefined && listedProcessIds.has(entry.processId);
    const isVisible = (entry: LedgerEntry): boolean =>
      entry.deviceId !== undefined && visibleDeviceIds.has(entry.deviceId);
    const ended = this.endedDuringSample(sampleWindow, visibleDeviceIds, excludeDeviceId, now);
    let count = ended.length;
    let withListedProcess = ended.filter(hasListedProcess).length;
    // Read before the loop below ends the listed entries into the open windows, this one included.
    const known = [...this.windowEnded(sampleWindow), ...this.entries.values()];
    const listedWithoutProcess = known.filter(
      (entry) => isVisible(entry) && !hasListedProcess(entry) && entry.deviceId !== excludeDeviceId,
    ).length;
    for (const [token, entry] of [...this.entries]) {
      const visible = isVisible(entry);
      if (entry.handedOffUntilMs !== undefined && (visible || now >= entry.handedOffUntilMs)) {
        // Visible in this listing, but a sample still open may hold an older one without it.
        this.end(token, visible);
      } else if (
        !visible &&
        (excludeDeviceId === undefined || entry.deviceId !== excludeDeviceId)
      ) {
        count += 1;
        withListedProcess += hasListedProcess(entry) ? 1 : 0;
      }
    }
    return { count, withListedProcess, listedWithoutProcess };
  }

  private windowEnded(window: LedgerSampleWindow | undefined): readonly LedgerEntry[] {
    return window instanceof SampleWindow ? window.ended : [];
  }

  /** Boots that ended while the sample was open and that the sample does not show either. */
  private endedDuringSample(
    window: LedgerSampleWindow | undefined,
    visibleDeviceIds: ReadonlySet<string>,
    excludeDeviceId: string | undefined,
    now: number,
  ): LedgerEntry[] {
    return this.windowEnded(window).filter(
      (entry) =>
        !(entry.handedOffUntilMs !== undefined && now >= entry.handedOffUntilMs) &&
        !(entry.deviceId !== undefined && visibleDeviceIds.has(entry.deviceId)) &&
        (excludeDeviceId === undefined || entry.deviceId !== excludeDeviceId),
    );
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
