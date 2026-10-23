import { holderOf, isIdle, type BindingFields } from "./deviceBinding";
import { exponentialBackoff } from "../utils/Backoff";

/** Pool bindings and startup leases both represent work the monitor must watch. */
export function isHeldDisconnectDevice(
  device: BindingFields | null | undefined,
  leasedForAndroidStartup: boolean,
): boolean {
  return (
    (device !== null && device !== undefined && (!isIdle(device) || !!holderOf(device))) ||
    leasedForAndroidStartup
  );
}

export const DEVICE_DISCONNECT_MAX_IDLE_INTERVAL_MS = 120_000;

export interface IdleSweepState {
  signature: string;
  unchanged: number;
}

/** The first unwatched observation establishes a baseline (exponent zero). */
export function nextIdleSweepState(
  previous: IdleSweepState | undefined,
  signature: string | undefined,
): IdleSweepState | undefined {
  if (signature === undefined) {
    return undefined;
  }
  return { signature, unchanged: previous?.signature === signature ? previous.unchanged + 1 : 0 };
}

export function idleSweepInterval(
  idleIntervalMs: number,
  unchanged: number,
  maxIdleIntervalMs = DEVICE_DISCONNECT_MAX_IDLE_INTERVAL_MS,
): number {
  return exponentialBackoff({
    initialDelayMs: idleIntervalMs,
    maxDelayMs: maxIdleIntervalMs,
  }).delayForAttempt(unchanged + 1);
}

export function idleSweepSignature(
  discoveredIds: Iterable<string>,
  pooledIds: Iterable<string>,
  succeededPlatforms: ReadonlySet<"android" | "ios">,
): string {
  return JSON.stringify([
    [...discoveredIds].sort(),
    [...pooledIds].sort(),
    [...succeededPlatforms].sort(),
  ]);
}

export function selectDisconnectScope(
  platforms: readonly ("android" | "ios")[],
  now: number,
  lastEitherSweepAt: number | undefined,
  idleIntervalMs: number,
): "android" | "ios" | "either" {
  if (lastEitherSweepAt === undefined || now - lastEitherSweepAt >= idleIntervalMs) {
    return "either";
  }
  const platform = platforms[0];
  return platform && platforms.every((value) => value === platform) ? platform : "either";
}

export interface DisconnectMonitorCadence {
  activeIntervalMs: number;
  idleIntervalMs: number;
  maxIdleIntervalMs?: number;
}

/** Timer-free admission and scope bookkeeping for one disconnect monitor. */
export class DisconnectMonitorSchedule {
  private lastEitherSweepAt: number | undefined;
  private idleState: IdleSweepState | undefined;
  private watching = false;

  constructor(
    private readonly cadence: DisconnectMonitorCadence,
    private lastSweepAt: number,
  ) {}

  shouldRun(watching: boolean, now: number): boolean {
    const wasWatching = this.watching;
    this.watching = watching;
    if (watching) {
      this.idleState = undefined;
      if (!wasWatching) {
        this.lastEitherSweepAt = undefined;
      }
    }
    if (
      !watching &&
      now - this.lastSweepAt <
        idleSweepInterval(
          this.cadence.idleIntervalMs,
          this.idleState?.unchanged ?? 0,
          this.cadence.maxIdleIntervalMs,
        )
    ) {
      return false;
    }
    this.lastSweepAt = now;
    return true;
  }

  selectPlatform(
    platforms: readonly ("android" | "ios")[],
    now: number,
    planOnTracked: boolean,
  ): "android" | "ios" | "either" {
    const platform =
      this.watching && !planOnTracked
        ? selectDisconnectScope(platforms, now, this.lastEitherSweepAt, this.cadence.idleIntervalMs)
        : "either";
    if (platform === "either") {
      this.lastEitherSweepAt = now;
    }
    return platform;
  }

  recordSuccess(idleSignature: string | undefined): void {
    if (!this.watching) {
      this.idleState = nextIdleSweepState(this.idleState, idleSignature);
    }
  }

  recordFailure(): void {
    this.idleState = undefined;
    this.lastEitherSweepAt = undefined;
  }
}

/** Back off only when discovery provides successful, complete absence-free evidence. */
export function eligibleIdleSweepSignature(
  succeededPlatforms: ReadonlySet<"android" | "ios">,
  missCount: number,
  candidateDeviceIds: Iterable<string>,
  bootedDeviceIds: ReadonlySet<string>,
  pooledDeviceIds: Iterable<string>,
): string | undefined {
  if (
    succeededPlatforms.size === 0 ||
    missCount !== 0 ||
    ![...candidateDeviceIds].every((id) => bootedDeviceIds.has(id))
  ) {
    return undefined;
  }
  return idleSweepSignature(bootedDeviceIds, pooledDeviceIds, succeededPlatforms);
}
