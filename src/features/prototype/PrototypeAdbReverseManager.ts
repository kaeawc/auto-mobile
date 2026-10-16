import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { extractDeviceLoopbackPorts, type UnreversibleLoopbackUrl } from "./prototypeLoopbackPorts";

/** The three adb reverse operations the manager needs, for one device. */
export interface PrototypeReverseAdb {
  /** Device-side ports of the reverses that exist (`adb reverse --list`). */
  listReversedPorts(): Promise<ReadonlySet<number>>;
  /** `adb reverse tcp:<port> tcp:<port>`. */
  addReverse(port: number): Promise<void>;
  /** `adb reverse --remove tcp:<port>`. */
  removeReverse(port: number): Promise<void>;
}

const REVERSE_TIMEOUT_MS = 5000;
const TCP_PREFIX = "tcp:";

/** `adb reverse --list` lines are whitespace-separated; the first `tcp:` token is the device side. */
function devicePortsFromList(stdout: string): Set<number> {
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    const device = line.split(/\s+/).find((token) => token.startsWith(TCP_PREFIX));
    const port = device === undefined ? NaN : Number(device.slice(TCP_PREFIX.length));
    if (Number.isInteger(port)) {
      ports.add(port);
    }
  }
  return ports;
}

export function createPrototypeReverseAdb(
  adb: Pick<AdbExecutor, "executeCommand">,
): PrototypeReverseAdb {
  return {
    async listReversedPorts() {
      const result = await adb.executeCommand("reverse --list", REVERSE_TIMEOUT_MS);
      return devicePortsFromList(result.stdout);
    },
    async addReverse(port) {
      await adb.executeCommand(`reverse tcp:${port} tcp:${port}`, REVERSE_TIMEOUT_MS);
    },
    async removeReverse(port) {
      await adb.executeCommand(`reverse --remove tcp:${port}`, REVERSE_TIMEOUT_MS);
    },
  };
}

export interface ReverseFailure {
  prototypeId: string;
  port: number;
  error: string;
}

export interface UnreversiblePort extends UnreversibleLoopbackUrl {
  prototypeId: string;
}

export interface PrototypeReverseReport {
  /** Templated or unparseable device-side loopback URLs: use via "host" for these. */
  unreversiblePorts: UnreversiblePort[];
  /** Ports whose `adb reverse` failed (best-effort; the show itself is never failed). */
  reverseFailures: ReverseFailure[];
}

interface DeviceState {
  adb: PrototypeReverseAdb;
  /** Ports this manager created -> prototypes relying on each (the refcount). */
  owned: Map<number, Set<string>>;
  report: Map<string, PrototypeReverseReport>;
  /** Serialises operations on one device so list-then-add cannot interleave. */
  tail: Promise<unknown>;
}

/**
 * Creates `adb reverse` for the loopback ports of shown prototypes' `via: "device"` requests and
 * removes only the ones it created (#12530). A reverse that already existed is never touched, and a
 * port several prototypes on one device share is removed when the last of them goes. Everything is
 * best-effort: a failure is logged, reported through {@link report}, and never thrown.
 */
export class PrototypeAdbReverseManager {
  private readonly devices = new Map<string, DeviceState>();

  /** Makes `prototypeId`'s device-loopback ports reachable; replaces what it needed before. */
  sync(
    deviceId: string,
    prototypeId: string,
    spec: unknown,
    adb: PrototypeReverseAdb,
  ): Promise<PrototypeReverseReport> {
    const state = this.stateFor(deviceId, adb);
    return this.enqueue(state, async () => {
      const { ports, unreversible } = extractDeviceLoopbackPorts(spec);
      const failures: ReverseFailure[] = [];
      await this.dropStale(state, prototypeId, new Set(ports));
      await this.acquire(state, prototypeId, ports, failures);
      const report: PrototypeReverseReport = {
        unreversiblePorts: unreversible.map((entry) => ({ prototypeId, ...entry })),
        reverseFailures: failures,
      };
      if (report.unreversiblePorts.length > 0 || failures.length > 0) {
        state.report.set(prototypeId, report);
      } else {
        state.report.delete(prototypeId);
      }
      return report;
    });
  }

  /** The prototype was dismissed: drop its claim on each port, removing the ones nobody else uses. */
  async release(deviceId: string, prototypeId: string): Promise<void> {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return;
    }
    await this.enqueue(state, async () => {
      state.report.delete(prototypeId);
      await this.dropStale(state, prototypeId, new Set());
    });
  }

  /** The device went away or lost its session: remove every reverse this manager created on it. */
  async releaseAll(deviceId: string): Promise<void> {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return;
    }
    await this.enqueue(state, async () => {
      for (const port of [...state.owned.keys()]) {
        state.owned.delete(port);
        // A gone device cannot answer, so a failed removal here is expected, not a warning.
        await state.adb.removeReverse(port).catch((error) => {
          logger.debug(`[prototype] reverse tcp:${port} removal on ${deviceId} failed: ${error}`);
        });
      }
      state.report.clear();
    });
    // A sync queued behind this release may have created reverses again: keep tracking those.
    if (state.owned.size === 0) {
      this.devices.delete(deviceId);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.devices.keys()].map((id) => this.releaseAll(id)));
  }

  /** Warnings for inspect: the unreversible URLs and failed reverses of every prototype on a device. */
  report(deviceId: string): PrototypeReverseReport {
    const entries = [...(this.devices.get(deviceId)?.report.values() ?? [])];
    return {
      unreversiblePorts: entries.flatMap((entry) => entry.unreversiblePorts),
      reverseFailures: entries.flatMap((entry) => entry.reverseFailures),
    };
  }

  /** Ports this manager currently owns on a device, ascending. */
  ownedPorts(deviceId: string): number[] {
    return [...(this.devices.get(deviceId)?.owned.keys() ?? [])].sort((a, b) => a - b);
  }

  private stateFor(deviceId: string, adb: PrototypeReverseAdb): DeviceState {
    let state = this.devices.get(deviceId);
    if (state === undefined) {
      state = { adb, owned: new Map(), report: new Map(), tail: Promise.resolve() };
      this.devices.set(deviceId, state);
    } else {
      state.adb = adb;
    }
    return state;
  }

  private enqueue<T>(state: DeviceState, task: () => Promise<T>): Promise<T> {
    const run = state.tail.then(task, task);
    state.tail = run.catch(() => undefined);
    return run;
  }

  private async dropStale(
    state: DeviceState,
    prototypeId: string,
    keep: ReadonlySet<number>,
  ): Promise<void> {
    for (const [port, holders] of [...state.owned]) {
      if (keep.has(port) || !holders.delete(prototypeId) || holders.size > 0) {
        continue;
      }
      state.owned.delete(port);
      try {
        await state.adb.removeReverse(port);
      } catch (error) {
        logger.warn(`[prototype] adb reverse --remove tcp:${port} failed: ${errorMessage(error)}`);
      }
    }
  }

  private async acquire(
    state: DeviceState,
    prototypeId: string,
    ports: readonly number[],
    failures: ReverseFailure[],
  ): Promise<void> {
    const missing = ports.filter((port) => !this.share(state, port, prototypeId));
    if (missing.length === 0) {
      return;
    }
    let existing: ReadonlySet<number>;
    try {
      existing = await state.adb.listReversedPorts();
    } catch (error) {
      logger.warn(`[prototype] adb reverse --list failed: ${errorMessage(error)}`);
      failures.push(...missing.map((port) => ({ prototypeId, port, error: errorMessage(error) })));
      return;
    }
    for (const port of missing) {
      // Someone else's reverse (the user's, or another tool's) is left alone and never removed.
      if (existing.has(port)) {
        continue;
      }
      try {
        await state.adb.addReverse(port);
        state.owned.set(port, new Set([prototypeId]));
      } catch (error) {
        logger.warn(`[prototype] adb reverse tcp:${port} failed: ${errorMessage(error)}`);
        failures.push({ prototypeId, port, error: errorMessage(error) });
      }
    }
  }

  /** Joins an already-owned port's holders; false when this manager does not own it. */
  private share(state: DeviceState, port: number, prototypeId: string): boolean {
    const holders = state.owned.get(port);
    holders?.add(prototypeId);
    return holders !== undefined;
  }
}
