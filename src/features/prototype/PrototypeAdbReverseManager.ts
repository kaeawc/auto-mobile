import { createAdbReverseCommands } from "../../utils/android-cmdline-tools/adbReverse";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { AdbReverseOwnership, type AdbReverseHolder } from "../portReverse/AdbReverseOwnership";
import { extractDeviceLoopbackPorts, type UnreversibleLoopbackUrl } from "./prototypeLoopbackPorts";

/** The three adb reverse operations the manager needs, for one device. */
export interface PrototypeReverseAdb {
  /** Device port -> `tcp:` host port (undefined for other host specs) of each reverse (`--list`). */
  listReverses(): Promise<ReadonlyMap<number, number | undefined>>;
  /** `adb reverse tcp:<port> tcp:<port>`. */
  addReverse(port: number): Promise<void>;
  /** `adb reverse --remove tcp:<port>`. */
  removeReverse(port: number): Promise<void>;
}

/** Adapts the shared adb reverse commands (one parser, one command builder) to the prototype view. */
export function createPrototypeReverseAdb(
  adb: Pick<AdbExecutor, "executeCommand">,
): PrototypeReverseAdb {
  const commands = createAdbReverseCommands(adb);
  return {
    async listReverses() {
      return new Map((await commands.list()).map((entry) => [entry.devicePort, entry.hostPort]));
    },
    // --no-rebind: a mapping made between the list and the add (a portReverse one) is never replaced.
    addReverse: (port) => commands.add(port, port, { noRebind: true }),
    removeReverse: (port) => commands.remove(port),
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

/** A staged replacement: the new ports are claimed; settle it with exactly one of the two. */
export interface StagedReverses {
  report: PrototypeReverseReport;
  /** The send landed: release the ports the new spec no longer needs. */
  commit(): Promise<void>;
  /** The send failed: release the ports this stage added and keep the earlier claims. */
  rollback(): Promise<void>;
}

interface DeviceState {
  deviceId: string;
  adb: PrototypeReverseAdb;
  /**
   * Ports this manager created, or joined because a portReverse session holds them -> prototypes
   * relying on each (the refcount).
   */
  owned: Map<number, Set<string>>;
  /** Owned ports joined from a portReverse session -> the host port that session mapped them to. */
  joined: Map<number, number>;
  report: Map<string, PrototypeReverseReport>;
  /** Serialises operations on one device so list-then-add cannot interleave. */
  tail: Promise<unknown>;
  /** Tasks queued or running on this device, so a release can tell whether anything waits behind it. */
  pending: number;
}

/**
 * Creates `adb reverse` for the loopback ports of shown prototypes' `via: "device"` requests and
 * removes only the ones it created (#12530). A reverse that already existed is never touched, and a
 * port several prototypes on one device share is removed when the last of them goes. A port a
 * portReverse session holds, and still maps where that session set it, is shared through
 * {@link AdbReverseOwnership}: the prototype joins it, and whichever of the two releases last
 * removes it (#17253). Everything is best-effort: a failure
 * is logged, reported through {@link report}, and never thrown.
 */
export class PrototypeAdbReverseManager {
  private readonly devices = new Map<string, DeviceState>();
  private readonly holder: AdbReverseHolder = {
    kind: "prototype",
    heldHostPort: (deviceId, devicePort) => {
      const state = this.devices.get(deviceId);
      return state?.owned.has(devicePort)
        ? (state.joined.get(devicePort) ?? devicePort)
        : undefined;
    },
  };
  private readonly unregister: () => void;

  constructor(private readonly ownership: AdbReverseOwnership = new AdbReverseOwnership()) {
    this.unregister = ownership.register(this.holder);
  }

  /** Makes `prototypeId`'s device-loopback ports reachable; replaces what it needed before. */
  async sync(
    deviceId: string,
    prototypeId: string,
    spec: unknown,
    adb: PrototypeReverseAdb,
  ): Promise<PrototypeReverseReport> {
    const staged = await this.stage(deviceId, prototypeId, spec, adb);
    await staged.commit();
    return staged.report;
  }

  /**
   * Acquires the ports `spec` needs while keeping what `prototypeId` held before, so a replacement
   * that the device then refuses can be undone. `commit` releases the ports the new spec no longer
   * needs; `rollback` releases only the ports this stage added and restores the previous report,
   * leaving the earlier claims exactly as they were. Whichever runs first wins; the other is a no-op.
   */
  stage(
    deviceId: string,
    prototypeId: string,
    spec: unknown,
    adb: PrototypeReverseAdb,
  ): Promise<StagedReverses> {
    const state = this.stateFor(deviceId, adb);
    return this.enqueue(state, async () => {
      const { ports, unreversible } = extractDeviceLoopbackPorts(spec);
      const failures: ReverseFailure[] = [];
      const heldBefore = new Set(
        [...state.owned].filter(([, holders]) => holders.has(prototypeId)).map(([port]) => port),
      );
      await this.acquire(state, prototypeId, ports, failures);
      const added = ports.filter(
        (port) => !heldBefore.has(port) && state.owned.get(port)?.has(prototypeId),
      );
      const report: PrototypeReverseReport = {
        unreversiblePorts: unreversible.map((entry) => ({ prototypeId, ...entry })),
        reverseFailures: failures,
      };
      const previousReport = state.report.get(prototypeId);
      this.record(state, prototypeId, report);
      let done = false;
      const once = (task: () => Promise<void>) => () => {
        if (done) {
          return Promise.resolve();
        }
        done = true;
        return this.enqueue(state, task);
      };
      return {
        report,
        commit: once(() => this.dropStale(state, prototypeId, new Set(ports))),
        rollback: once(async () => {
          if (previousReport === undefined) {
            state.report.delete(prototypeId);
          } else {
            state.report.set(prototypeId, previousReport);
          }
          await this.releasePorts(state, prototypeId, added);
        }),
      };
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

  /**
   * Drops the claims of every prototype on the device whose key `keep` rejects, removing the
   * reverses nobody else holds (a replacing show ended those prototypes on the device).
   */
  async releaseExcept(deviceId: string, keep: (key: string) => boolean): Promise<void> {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return;
    }
    await this.enqueue(state, async () => {
      const keys = new Set([
        ...state.report.keys(),
        ...[...state.owned.values()].flatMap((h) => [...h]),
      ]);
      for (const key of keys) {
        if (!keep(key)) {
          state.report.delete(key);
          await this.dropStale(state, key, new Set());
        }
      }
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
        const joinedTo = this.forget(state, port);
        if (this.keptForSession(deviceId, port) || (await this.repointed(state, port, joinedTo))) {
          continue;
        }
        // A gone device cannot answer, so a failed removal here is expected, not a warning.
        await this.remove(state, port).catch((error) => {
          logger.debug(`[prototype] reverse tcp:${port} removal on ${deviceId} failed: ${error}`);
        });
      }
      state.report.clear();
      // Forgetting the device is part of the serialized queue: work queued behind this release
      // runs after it, and still finds the same state object (see `pending`).
      if (state.pending === 1 && this.devices.get(deviceId) === state) {
        this.devices.delete(deviceId);
      }
    });
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.devices.keys()].map((id) => this.releaseAll(id)));
    this.unregister();
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
      state = {
        deviceId,
        adb,
        owned: new Map(),
        joined: new Map(),
        report: new Map(),
        tail: Promise.resolve(),
        pending: 0,
      };
      this.devices.set(deviceId, state);
    } else {
      state.adb = adb;
    }
    return state;
  }

  private enqueue<T>(state: DeviceState, task: () => Promise<T>): Promise<T> {
    state.pending++;
    const run = state.tail.then(task, task).finally(() => {
      state.pending--;
    });
    state.tail = run.catch(() => undefined);
    return run;
  }

  private record(state: DeviceState, prototypeId: string, report: PrototypeReverseReport): void {
    if (report.unreversiblePorts.length > 0 || report.reverseFailures.length > 0) {
      state.report.set(prototypeId, report);
    } else {
      state.report.delete(prototypeId);
    }
  }

  private async dropStale(
    state: DeviceState,
    prototypeId: string,
    keep: ReadonlySet<number>,
  ): Promise<void> {
    await this.releasePorts(
      state,
      prototypeId,
      [...state.owned.keys()].filter((port) => !keep.has(port)),
    );
  }

  /** Drops the prototype's claim on each port, removing the ones nobody else holds. */
  private async releasePorts(
    state: DeviceState,
    prototypeId: string,
    ports: readonly number[],
  ): Promise<void> {
    for (const port of ports) {
      const holders = state.owned.get(port);
      if (holders === undefined || !holders.delete(prototypeId) || holders.size > 0) {
        continue;
      }
      const joinedTo = this.forget(state, port);
      if (
        this.keptForSession(state.deviceId, port) ||
        (await this.repointed(state, port, joinedTo))
      ) {
        continue;
      }
      try {
        await this.remove(state, port);
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
    let existing: ReadonlyMap<number, number | undefined>;
    try {
      existing = await state.adb.listReverses();
    } catch (error) {
      logger.warn(`[prototype] adb reverse --list failed: ${errorMessage(error)}`);
      failures.push(...missing.map((port) => ({ prototypeId, port, error: errorMessage(error) })));
      return;
    }
    for (const port of missing) {
      if (await this.joinSession(state, port, prototypeId, existing)) {
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

  /**
   * Joins a listed port a portReverse session holds and still maps where it set it, so the session's
   * removal waits for this prototype too. A port that session is removing right now is waited for
   * and then added (or joined, if the removal failed). True when nothing is left to add: the port
   * was joined, or it is someone else's reverse (the user's, or another tool's), which is left
   * alone and never removed.
   */
  private async joinSession(
    state: DeviceState,
    port: number,
    prototypeId: string,
    existing: ReadonlyMap<number, number | undefined>,
  ): Promise<boolean> {
    if (this.ownership.removalPending(state.deviceId, port)) {
      await this.ownership.settled(state.deviceId, port);
      const kept = this.ownership.heldByOther(this.holder, state.deviceId, port);
      return kept !== undefined && this.join(state, port, prototypeId, kept.hostPort);
    }
    if (!existing.has(port)) {
      return false;
    }
    const hold = this.ownership.heldByOther(this.holder, state.deviceId, port);
    if (hold !== undefined && hold.hostPort === existing.get(port)) {
      this.join(state, port, prototypeId, hold.hostPort);
    }
    return true;
  }

  private join(state: DeviceState, port: number, prototypeId: string, hostPort: number): true {
    state.owned.set(port, new Set([prototypeId]));
    state.joined.set(port, hostPort);
    return true;
  }

  /** Drops the port; returns the session host port it was joined at, if it was joined. */
  private forget(state: DeviceState, port: number): number | undefined {
    const joinedTo = state.joined.get(port);
    state.owned.delete(port);
    state.joined.delete(port);
    return joinedTo;
  }

  /**
   * A port joined from a session is someone else's once it no longer maps to that session's host
   * port (re-pointed outside AutoMobile after the join), so it is left in place. A port this
   * manager created is not re-checked; an unreadable `--list` falls back to removing, as before.
   */
  private async repointed(
    state: DeviceState,
    port: number,
    joinedTo: number | undefined,
  ): Promise<boolean> {
    if (joinedTo === undefined) {
      return false;
    }
    try {
      const live = await state.adb.listReverses();
      const kept = live.has(port) && live.get(port) !== joinedTo;
      if (kept) {
        logger.debug(`[prototype] reverse tcp:${port} on ${state.deviceId} was re-pointed; kept`);
      }
      return kept;
    } catch (error) {
      logger.warn(
        `[prototype] adb reverse --list before removing tcp:${port} failed: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  /** Removes the reverse in view of the shared ownership, so a session can wait for it. */
  private remove(state: DeviceState, port: number): Promise<void> {
    return this.ownership.removing(state.deviceId, port, state.adb.removeReverse(port));
  }

  /** A portReverse session still holds the port: the last prototype leaves the reverse to it. */
  private keptForSession(deviceId: string, port: number): boolean {
    const other = this.ownership.heldByOther(this.holder, deviceId, port);
    if (other !== undefined) {
      logger.debug(`[prototype] reverse tcp:${port} on ${deviceId} kept: a ${other.kind} holds it`);
    }
    return other !== undefined;
  }

  /** Joins an already-owned port's holders; false when this manager does not own it. */
  private share(state: DeviceState, port: number, prototypeId: string): boolean {
    const holders = state.owned.get(port);
    holders?.add(prototypeId);
    return holders !== undefined;
  }
}
