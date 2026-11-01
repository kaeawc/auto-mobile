import {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../../models/BootedDeviceDiscoveryIncompleteError";
import { BootCapacityExhaustedError } from "../../models/BootCapacityExhaustedError";
import type { Platform } from "../../models/Platform";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type { CapacityLimits, InFlightBootMemory } from "./capacityLimits";
import { SampleWindow } from "./SampleWindow";
import { ENV } from "../../config/env";
import type { BootAdmissionReason } from "./BootSlotReservation";

/**
 * Platform-neutral boot admission (#11181): the ledger of admitted boots, the
 * immediate admit-or-refuse decision and the capacity-exhausted failure shared by the Android
 * emulator gate and the iOS simulator gate.
 */

/** Opt-out switch for every boot admission gate; exact `0` disables. */
export const BOOT_CAPACITY_GATE_ENV = ENV.BOOT_CAPACITY_GATE.name;
/** iOS-only override of {@link BOOT_CAPACITY_GATE_ENV}: exact `0` disables, exact `1` enables. */
export const IOS_SIM_CAPACITY_GATE_ENV = ENV.IOS_SIM_CAPACITY_GATE.name;

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
  /** Counted iOS simulators owned by AutoMobile admissions, sessions or bindings. */
  heldDevices?: string[];
  ownershipUnknown?: boolean;
}

export interface BootAdmissionResult<D> {
  decision: D | RefusedCapacityDecision;
  /**
   * Present when the boot was admitted a boot: it counts toward the limit until
   * released, so concurrent callers cannot all be admitted against one free
   * slot before the first boot shows up in the platform's listing. A failed boot
   * reports `bootFailed` so an unobserved target can be forgotten; omission means success.
   */
  releaseAdmission?: (outcome?: { bootFailed?: boolean }) => void;
}

/** Ownership context shared by gate and broker capacity refusals, including leading spaces. */
export function bootCapacityOwnershipNote(describe: {
  externalDevices?: readonly string[];
  heldDevices?: readonly string[];
  ownershipUnknown?: boolean;
}): string {
  const external = describe.externalDevices ?? [];
  const held = describe.heldDevices ?? [];
  const heldNote =
    held.length > 0 ? ` ${held.length} of them are held by AutoMobile: ${held.join(", ")}.` : "";
  const externalNote =
    external.length > 0
      ? ` ${external.length} of them ${describe.ownershipUnknown ? "have unconfirmed AutoMobile ownership" : describe.heldDevices ? "have no AutoMobile owner" : "were not started by AutoMobile"} but still count toward the limit: ${external.join(", ")}.`
      : "";
  return `${externalNote}${heldNote}`;
}

/** The at-capacity refusal, or undefined when one more boot fits. */
export function atCapacityDecision(
  bootedCount: number,
  limits: CapacityLimits,
  retryAfterMs: number,
  describe: {
    noun: string;
    envName: string;
    externalDevices?: readonly string[];
    heldDevices?: readonly string[];
    /** Ownership labels use a retained or empty snapshot after a failed read. */
    ownershipUnknown?: boolean;
  },
): RefusedCapacityDecision | undefined {
  if (bootedCount < limits.maxBooted) {
    return undefined;
  }
  const external = describe.externalDevices ?? [];
  const held = describe.heldDevices ?? [];
  const optOut = external.length > 0 ? ` or disable the gate with ${BOOT_CAPACITY_GATE_ENV}=0` : "";
  return {
    outcome: "refuse",
    reason: "at-capacity",
    limits,
    bootedCount,
    retryAfterMs,
    ...(external.length > 0 ? { externalDevices: [...external] } : {}),
    ...(held.length > 0 ? { heldDevices: [...held] } : {}),
    ...(describe.ownershipUnknown ? { ownershipUnknown: true } : {}),
    message: `${bootedCount} ${describe.noun}(s) booted; limit is ${limits.maxBooted} (${limits.source}).${bootCapacityOwnershipNote(describe)} Shut one down, raise the limit with ${describe.envName}${optOut}.`,
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
  /** Wait hint carried by the retryable error a timed-out sample throws (iOS only; #15307). */
  timeoutRetryAfterMs?: number;
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
    timeoutError: () =>
      sampleTimeoutError(options.platform, timeoutMs, options.label, options.timeoutRetryAfterMs),
  });
}

/**
 * An unfinished sample leaves the booted count unknown, which never fails open: retryable
 * `discovery_incomplete`, as for a failed listing.
 */
export function sampleTimeoutError(
  platform: Platform,
  timeoutMs: number,
  label: string,
  retryAfterMs?: number,
): BootedDeviceDiscoveryIncompleteError {
  const discoveryError = {
    code: "timeout",
    message: `timed out after ${timeoutMs}ms collecting ${label}`,
    retryable: true,
  } as const;
  return platform === "android"
    ? new AndroidBootedDeviceDiscoveryIncompleteError(discoveryError)
    : new BootedDeviceDiscoveryIncompleteError(platform, discoveryError, undefined, retryAfterMs);
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
      ...(decision.heldDevices ? { heldDevices: decision.heldDevices } : {}),
      ...(decision.ownershipUnknown ? { ownershipUnknown: true } : {}),
    },
    `Refused to boot: no ${noun} capacity (code capacity_exhausted, retryable; retry after ${decision.retryAfterMs}ms): ${decision.message}`,
  );
}

export interface LedgerEntry {
  reason?: BootAdmissionReason;
  deviceId?: string;
  /** An old device whose slot is held until the replacement binds its own identity. */
  replacement?: boolean;
  /** Pid of the process spawned for the boot, once handed off with one. */
  processId?: number;
  /** Set once the boot was handed off: the entry ends when the device is visible or this passes. */
  handedOffUntilMs?: number;
  /** Retained for sizing even when an older sample keeps a listed entry without its deadline. */
  handedOff?: boolean;
}

/**
 * A ledger entry's handle; `handOff` takes the absolute end of the hand-off window and may be
 * repeated, a later call adding the device id or process id the earlier one lacked.
 */
export interface LedgerAdmission {
  bind(deviceId?: string): void;
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

export interface InFlightBootView extends InFlightBoots {
  /** Exactly the boots behind `count`, including entries retained by the sample window. */
  boots: readonly InFlightBootMemory[];
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

  admit(
    deviceId?: string,
    replacement = false,
    reason: BootAdmissionReason = "create",
  ): LedgerAdmission {
    const token = Symbol("boot-admission");
    this.entries.set(token, { deviceId, replacement, reason });
    return {
      bind: (boundDeviceId) => {
        const entry = this.entries.get(token);
        if (entry) {
          this.entries.set(token, { ...entry, deviceId: boundDeviceId, replacement: false });
        }
      },
      release: () => this.end(token),
      handOff: (handedOffDeviceId, untilMs, processId) => {
        const entry = this.entries.get(token);
        if (entry) {
          this.entries.set(token, {
            deviceId: handedOffDeviceId ?? entry.deviceId,
            processId: processId ?? entry.processId,
            handedOffUntilMs: untilMs,
            handedOff: true,
          });
        }
      },
    };
  }

  admissionsByReason(): Record<BootAdmissionReason, number> {
    const counts = { reset: 0, create: 0, restart: 0 };
    for (const entry of this.entries.values()) {
      counts[entry.reason ?? "create"] += 1;
    }
    return counts;
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
    const kept = listed
      ? {
          deviceId: entry.deviceId,
          processId: entry.processId,
          handedOff: entry.handedOff,
          replacement: entry.replacement,
          reason: entry.reason,
        }
      : entry;
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
    const { count, withListedProcess, listedWithoutProcess } = this.inFlightView(
      visibleDeviceIds,
      excludeDeviceId,
      sampleWindow,
      listedProcessIds,
    );
    return { count, withListedProcess, listedWithoutProcess };
  }

  /** Counts and boot identities from one ledger traversal, for sizing against the same view. */
  inFlightView(
    visibleDeviceIds: ReadonlySet<string>,
    excludeDeviceId?: string,
    sampleWindow?: LedgerSampleWindow,
    listedProcessIds: ReadonlySet<number> = new Set(),
  ): InFlightBootView {
    const now = this.timer.now();
    const hasListedProcess = (entry: LedgerEntry): boolean =>
      entry.processId !== undefined && listedProcessIds.has(entry.processId);
    const isVisible = (entry: LedgerEntry): boolean =>
      entry.deviceId !== undefined && visibleDeviceIds.has(entry.deviceId);
    const ended = this.endedDuringSample(sampleWindow, visibleDeviceIds, excludeDeviceId, now);
    const boots = [...ended];
    let withListedProcess = ended.filter(hasListedProcess).length;
    // Read before the loop below ends the listed entries into the open windows, this one included.
    const known = [...this.windowEnded(sampleWindow), ...this.entries.values()];
    const listedWithoutProcess = known.filter(
      (entry) =>
        isVisible(entry) &&
        !hasListedProcess(entry) &&
        entry.deviceId !== excludeDeviceId &&
        !entry.replacement,
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
        boots.push(entry);
        withListedProcess += hasListedProcess(entry) ? 1 : 0;
      }
    }
    return {
      count: boots.length,
      boots: boots.map((entry) => ({
        deviceId: entry.deviceId,
        replacement: entry.replacement,
        processId: entry.processId,
        handedOff: entry.handedOff === true,
      })),
      withListedProcess,
      listedWithoutProcess,
    };
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
  admissionsByReason?: Record<BootAdmissionReason, number>;
  limit: number;
  /** Booted devices of the platform, including ones started outside AutoMobile. */
  booted: number;
  /** Admitted boots not yet visible as booted. */
  inFlight: number;
  /** Android only: this sample lacked the table, or this daemon admitted a boot on adb alone. */
  processTable?: {
    /** The sample behind this report lacked the table. */
    unavailable: boolean;
    /** The most recent failure. */
    reason: string;
    detail: string;
    attempts: number;
    /** Boots this daemon admitted on the adb-only count since it started. */
    admissionsWithoutProcessTable: number;
    lastAdmissionWithoutProcessTableAtMs?: number;
  };
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
