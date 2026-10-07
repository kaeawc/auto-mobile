import { defaultTimer, type Timer } from "../SystemTimer";

/** How long a serial stays marked after its adbd restart command returns. */
export const ADB_TRANSPORT_RESTART_GRACE_MS = 5_000;

/** `adb` subcommands that restart adbd and drop the device from `adb devices`. */
const TRANSPORT_RESTART_COMMANDS = new Set(["root", "unroot"]);

/** True when `args` (after any `-s <serial>` prefix) is an adbd-restarting command. */
export function isAdbTransportRestartCommand(args: readonly string[]): boolean {
  return TRANSPORT_RESTART_COMMANDS.has(args[0] ?? "");
}

/**
 * Serials whose adbd AutoMobile itself is restarting (`adb root`/`adb unroot`).
 * The disconnect monitor must not treat their brief absence from `adb devices`
 * as a physical unplug (#10493). Process-local, like the console-busy registry.
 */
export interface AdbTransportRestartRegistry {
  /** Whether a restart is running for the serial, or ended within the grace. */
  isRestarting(deviceId: string): boolean;
  /** Keep the serial marked while `task` runs, then for the grace period. */
  runRestart<T>(deviceId: string, task: () => Promise<T>): Promise<T>;
}

/** The read side the disconnect monitor consults. */
export type AdbTransportRestartLookup = Pick<AdbTransportRestartRegistry, "isRestarting">;

export class InMemoryAdbTransportRestartRegistry implements AdbTransportRestartRegistry {
  private readonly inFlight = new Map<string, number>();
  private readonly graceUntil = new Map<string, number>();

  constructor(
    private readonly timer: Pick<Timer, "now"> = defaultTimer,
    private readonly graceMs: number = ADB_TRANSPORT_RESTART_GRACE_MS,
  ) {}

  isRestarting(deviceId: string): boolean {
    if ((this.inFlight.get(deviceId) ?? 0) > 0) {
      return true;
    }
    const until = this.graceUntil.get(deviceId);
    if (until === undefined) {
      return false;
    }
    if (this.timer.now() < until) {
      return true;
    }
    this.graceUntil.delete(deviceId);
    return false;
  }

  async runRestart<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    this.inFlight.set(deviceId, (this.inFlight.get(deviceId) ?? 0) + 1);
    try {
      return await task();
    } finally {
      const remaining = (this.inFlight.get(deviceId) ?? 1) - 1;
      if (remaining > 0) {
        this.inFlight.set(deviceId, remaining);
      } else {
        this.inFlight.delete(deviceId);
      }
      this.graceUntil.set(deviceId, this.timer.now() + this.graceMs);
    }
  }
}

/** Shared by every AdbClient and the daemon's disconnect monitor. */
export const defaultAdbTransportRestartRegistry = new InMemoryAdbTransportRestartRegistry();
