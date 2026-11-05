import type {
  AdbReverseCommands,
  AdbReverseEntry,
} from "../../utils/android-cmdline-tools/adbReverse";
import { rethrowDeviceTransportUnavailable } from "../../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { toActionableError } from "../../models/ActionableError";
import { PortReverseError } from "./PortReverseError";

/** One device port to reverse to a host loopback port. */
export interface PortReverseRequest {
  devicePort: number;
  hostPort: number;
}

/**
 * `added`/`present`/`restored`: the mapping is on the device. `missing`: an owned mapping is gone
 * and could not be restored, or a mapping that was asked about does not exist. `removed`: this call
 * removed it. `gone`: it had already disappeared. `foreign`: the device port now maps somewhere this
 * session did not create, so it was left in place.
 */
export type PortReverseStatus =
  | "added"
  | "present"
  | "restored"
  | "missing"
  | "removed"
  | "gone"
  | "foreign";

export interface PortReverseMapping {
  devicePort: number;
  /** Host TCP port; absent when the host side is not `tcp:` (e.g. `localabstract:`). */
  hostPort?: number;
  /** Host spec as adb reports it, e.g. `tcp:8080`. */
  host: string;
  /** This session created the mapping and will remove it on release. */
  owned: boolean;
  status: PortReverseStatus;
}

export interface PortReverseRestoreFailure {
  devicePort: number;
  error: string;
}

/** Owned mappings the call found missing from the device and re-applied (or failed to). */
export interface PortReverseRestoreReport {
  restored: number[];
  restoreFailures: PortReverseRestoreFailure[];
}

export interface PortReverseResult extends PortReverseRestoreReport {
  mappings: PortReverseMapping[];
}

/** The device, the adb it is reached through, and the session the call acts for. */
export interface PortReverseTarget {
  deviceId: string;
  /** The holder key: the session UUID, or a fixed key for sessionless calls. */
  owner: string;
  adb: AdbReverseCommands;
}

interface OwnedMapping {
  hostPort: number;
  owner: string;
}

interface DeviceState {
  adb: AdbReverseCommands;
  /** Device port -> the mapping AutoMobile created there and the session that owns it. */
  owned: Map<number, OwnedMapping>;
  /**
   * Device port -> host port of a released mapping whose removal failed. Never restored; the removal
   * is retried on the device's next `--list` while the port still maps to that host port.
   */
  pendingRemoval: Map<number, number>;
  /** Serialises operations on one device so list-then-add/remove cannot interleave. */
  tail: Promise<unknown>;
  pending: number;
}

/** Device port -> what `adb reverse --list` shows there. */
type DeviceView = Map<number, AdbReverseEntry>;

export type PortReverseAudit = (event: string) => void;

const tcp = (port: number) => `tcp:${port}`;

const defaultAudit: PortReverseAudit = (event) => logger.info(`[portReverse] ${event}`);

/**
 * Owns client-requested `adb reverse` mappings per device and session (#17099). A mapping belongs
 * to the session that created it: another session's, or one made outside this manager (a user's,
 * another tool's, a prototype's), is reported as a conflict and never overwritten or removed. Every
 * call first re-applies the device's owned mappings that `adb reverse --list` no longer shows (an
 * adb server restart, `adb reconnect`, an adbd restart or an emulator restart drops them) and
 * reports what it restored. Removal re-checks `--list` and removes a port only while it still maps
 * where this manager pointed it. `--remove-all` is never used.
 */
export class PortReverseManager {
  private readonly devices = new Map<string, DeviceState>();

  constructor(private readonly audit: PortReverseAudit = defaultAudit) {}

  /** Idempotently adds each mapping; throws `port_reverse_conflict` and changes nothing on a clash. */
  ensure(target: PortReverseTarget, requests: readonly PortReverseRequest[]) {
    const state = this.stateFor(target);
    return this.enqueue(state, async (): Promise<PortReverseResult> => {
      const wanted = uniqueRequests(requests);
      // Conflicts are judged on the device as it is, before any restore: a refused request changes
      // nothing on the device.
      const view = await this.view(target.deviceId, state);
      this.assertNoConflicts(target.owner, state, view, wanted);
      const report = await this.restoreFor(target, state, view);
      const added: number[] = [];
      const mappings: PortReverseMapping[] = [];
      for (const request of wanted) {
        if (view.has(request.devicePort)) {
          const status = report.restored.includes(request.devicePort) ? "restored" : "present";
          mappings.push(ownedMapping(request, status));
          continue;
        }
        await this.add(target, state, request, added);
        mappings.push(ownedMapping(request, "added"));
      }
      return { mappings, ...report };
    });
  }

  /** Every reverse on the device, each marked whether this session owns it. */
  list(target: PortReverseTarget) {
    const state = this.stateFor(target);
    return this.enqueue(state, async (): Promise<PortReverseResult> => {
      const { view, report } = await this.reconciled(target, state);
      const mappings = [...view.values()].map((entry) =>
        this.describe(target.owner, state, entry, report),
      );
      for (const [devicePort, mapping] of state.owned) {
        if (mapping.owner === target.owner && !view.has(devicePort)) {
          mappings.push(ownedMapping({ devicePort, hostPort: mapping.hostPort }, "missing"));
        }
      }
      return { mappings: mappings.sort((a, b) => a.devicePort - b.devicePort), ...report };
    });
  }

  /** Whether each port (default: every port this session owns) is mapped on the device now. */
  verify(target: PortReverseTarget, ports?: readonly number[]) {
    const state = this.stateFor(target);
    return this.enqueue(state, async (): Promise<PortReverseResult> => {
      const { view, report } = await this.reconciled(target, state);
      const asked = ports ?? this.portsOf(state, target.owner);
      const mappings = [...new Set(asked)].map((devicePort) => {
        const entry = view.get(devicePort);
        if (entry !== undefined) {
          return this.describe(target.owner, state, entry, report);
        }
        const owned = state.owned.get(devicePort);
        return {
          devicePort,
          ...(owned === undefined ? {} : { hostPort: owned.hostPort }),
          host: owned === undefined ? "" : tcp(owned.hostPort),
          owned: owned?.owner === target.owner,
          status: "missing" as const,
        };
      });
      return { mappings, ...report };
    });
  }

  /** Removes mappings this session owns; throws `port_reverse_not_owned` and changes nothing otherwise. */
  remove(target: PortReverseTarget, ports: readonly number[]) {
    const state = this.stateFor(target);
    return this.enqueue(state, async (): Promise<PortReverseResult> => {
      const unique = [...new Set(ports)];
      const notOwned = unique.filter((port) => state.owned.get(port)?.owner !== target.owner);
      if (notOwned.length > 0) {
        throw new PortReverseError(
          "port_reverse_not_owned",
          `Port(s) ${notOwned.join(", ")} on ${target.deviceId} were not reversed by this session; ` +
            "portReverse only removes mappings it created. Use action list to see owners.",
          notOwned,
        );
      }
      const view = await this.view(target.deviceId, state);
      const mappings: PortReverseMapping[] = [];
      for (const devicePort of unique) {
        mappings.push(await this.removeOwned(target.deviceId, state, devicePort, view));
      }
      return { mappings, restored: [], restoreFailures: [] };
    });
  }

  /**
   * Re-applies every owned mapping the device lost, for every session on it. A transport-recovery
   * path calls this after the device is back; failures are logged and retried on the next call.
   */
  async reconcile(deviceId: string): Promise<PortReverseRestoreReport> {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return { restored: [], restoreFailures: [] };
    }
    return this.enqueue(state, async () => {
      const view = await this.view(deviceId, state);
      return this.restoreMissing(deviceId, state, view);
    });
  }

  /** Whether `owner` holds any mapping on the device. */
  hasOwnedMappings(owner: string, deviceId: string): boolean {
    return [...(this.devices.get(deviceId)?.owned.values() ?? [])].some((m) => m.owner === owner);
  }

  /** The session ended or left the device: remove the mappings it owns there. */
  async releaseOwnerOnDevice(owner: string, deviceId: string): Promise<void> {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return;
    }
    await this.enqueue(state, () =>
      this.releaseWhere(deviceId, state, (mapping) => mapping.owner === owner),
    );
  }

  /**
   * Another device now answers on this serial: forget the owner's mappings there, and any pending
   * removals, without sending a command, since the replacement's mappings are not ours.
   */
  async forgetOwnerOnDevice(owner: string, deviceId: string): Promise<void> {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return;
    }
    await this.enqueue(state, async () => {
      for (const [port, mapping] of [...state.owned]) {
        if (mapping.owner === owner) {
          state.owned.delete(port);
        }
      }
      state.pendingRemoval.clear();
    });
  }

  /** Released mappings on the device whose removal is still pending, ascending. */
  pendingRemovals(deviceId: string): number[] {
    return [...(this.devices.get(deviceId)?.pendingRemoval.keys() ?? [])].sort((a, b) => a - b);
  }

  /** The session ended: remove the mappings it owns on every device. */
  async releaseOwner(owner: string): Promise<void> {
    await Promise.all(
      [...this.devices].map(([deviceId, state]) =>
        this.enqueue(state, () =>
          this.releaseWhere(deviceId, state, (mapping) => mapping.owner === owner),
        ),
      ),
    );
  }

  /** The device went away or was unbound: remove every mapping this manager owns on it. */
  async releaseDeviceMappings(deviceId: string): Promise<void> {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return;
    }
    await this.enqueue(state, async () => {
      await this.releaseWhere(deviceId, state, () => true);
      // A failed removal keeps the state so its retry is not lost.
      if (
        state.pending === 1 &&
        state.pendingRemoval.size === 0 &&
        this.devices.get(deviceId) === state
      ) {
        this.devices.delete(deviceId);
      }
    });
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.devices.keys()].map((id) => this.releaseDeviceMappings(id)));
  }

  /** Device ports AutoMobile owns on a device, ascending. */
  ownedPorts(deviceId: string): number[] {
    return [...(this.devices.get(deviceId)?.owned.keys() ?? [])].sort((a, b) => a - b);
  }

  private stateFor(target: PortReverseTarget): DeviceState {
    let state = this.devices.get(target.deviceId);
    if (state === undefined) {
      state = {
        adb: target.adb,
        owned: new Map(),
        pendingRemoval: new Map(),
        tail: Promise.resolve(),
        pending: 0,
      };
      this.devices.set(target.deviceId, state);
    } else {
      state.adb = target.adb;
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

  private portsOf(state: DeviceState, owner: string): number[] {
    return [...state.owned]
      .filter(([, mapping]) => mapping.owner === owner)
      .map(([port]) => port)
      .sort((a, b) => a - b);
  }

  private async view(deviceId: string, state: DeviceState): Promise<DeviceView> {
    try {
      const entries = await state.adb.list();
      const view: DeviceView = new Map(entries.map((entry) => [entry.devicePort, entry]));
      await this.retryPendingRemovals(deviceId, state, view);
      return view;
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      throw toActionableError(error, `adb reverse --list failed on ${deviceId}`);
    }
  }

  /** Retries released mappings whose removal failed, while they still map where AutoMobile set them. */
  private async retryPendingRemovals(deviceId: string, state: DeviceState, view: DeviceView) {
    for (const [devicePort, hostPort] of [...state.pendingRemoval]) {
      if (view.get(devicePort)?.hostPort !== hostPort) {
        // Gone, or re-pointed by someone else: nothing of ours is left to remove.
        state.pendingRemoval.delete(devicePort);
        continue;
      }
      try {
        await state.adb.remove(devicePort);
        state.pendingRemoval.delete(devicePort);
        view.delete(devicePort);
        this.audit(`remove ${tcp(devicePort)} -> ${tcp(hostPort)} device=${deviceId} (retried)`);
      } catch (error) {
        logger.warn(
          `[portReverse] retrying removal of released ${tcp(devicePort)} on ${deviceId} failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  /** The device's current reverses after re-applying the owned ones it lost. */
  private async reconciled(target: PortReverseTarget, state: DeviceState) {
    const view = await this.view(target.deviceId, state);
    return { view, report: await this.restoreFor(target, state, view) };
  }

  /** Restores the device's lost owned mappings into `view`; reports the caller's own. */
  private async restoreFor(
    target: PortReverseTarget,
    state: DeviceState,
    view: DeviceView,
  ): Promise<PortReverseRestoreReport> {
    const all = await this.restoreMissing(target.deviceId, state, view);
    const mine = (port: number) => state.owned.get(port)?.owner === target.owner;
    const report: PortReverseRestoreReport = {
      restored: all.restored.filter(mine),
      restoreFailures: all.restoreFailures.filter((failure) => mine(failure.devicePort)),
    };
    return report;
  }

  /** Re-adds owned mappings absent from `view` (updating it); drops ones another owner took over. */
  private async restoreMissing(
    deviceId: string,
    state: DeviceState,
    view: DeviceView,
  ): Promise<PortReverseRestoreReport> {
    const report: PortReverseRestoreReport = { restored: [], restoreFailures: [] };
    for (const [devicePort, mapping] of [...state.owned]) {
      const current = view.get(devicePort);
      if (current !== undefined) {
        if (current.hostPort !== mapping.hostPort) {
          // Someone re-pointed the port after ours was lost: it is theirs now, never touched.
          state.owned.delete(devicePort);
          logger.warn(
            `[portReverse] ${tcp(devicePort)} on ${deviceId} now maps to ${current.host}; ` +
              `dropping session ${mapping.owner}'s ownership without removing it`,
          );
        }
        continue;
      }
      try {
        await state.adb.add(devicePort, mapping.hostPort, { noRebind: true });
        view.set(devicePort, entryFor({ devicePort, hostPort: mapping.hostPort }));
        report.restored.push(devicePort);
        this.audit(
          `restore ${tcp(devicePort)} -> ${tcp(mapping.hostPort)} device=${deviceId} session=${mapping.owner}`,
        );
      } catch (error) {
        // Kept owned so the next call retries; the failure is reported in that call's result.
        logger.warn(
          `[portReverse] restoring ${tcp(devicePort)} on ${deviceId} failed: ${errorMessage(error)}`,
        );
        report.restoreFailures.push({ devicePort, error: errorMessage(error) });
      }
    }
    return report;
  }

  private assertNoConflicts(
    owner: string,
    state: DeviceState,
    view: DeviceView,
    wanted: readonly PortReverseRequest[],
  ): void {
    const conflicts = wanted.flatMap((request) => {
      const reason = conflictReason(owner, state.owned.get(request.devicePort), view, request);
      return reason === undefined ? [] : [{ port: request.devicePort, reason }];
    });
    if (conflicts.length > 0) {
      throw new PortReverseError(
        "port_reverse_conflict",
        `Cannot reverse ports already in use: ${conflicts.map((c) => c.reason).join("; ")}. ` +
          "Existing mappings were left in place; remove them first or choose another port.",
        conflicts.map((c) => c.port),
      );
    }
  }

  private async add(
    target: PortReverseTarget,
    state: DeviceState,
    request: PortReverseRequest,
    added: number[],
  ): Promise<void> {
    try {
      // --no-rebind: a mapping someone made since our --list is refused rather than overwritten.
      await state.adb.add(request.devicePort, request.hostPort, { noRebind: true });
    } catch (error) {
      // The add may have reached adbd before failing, so the mapping can exist untracked.
      logger.warn(
        `[portReverse] adb reverse ${tcp(request.devicePort)} failed on ${target.deviceId}; a mapping there may exist untracked: ${errorMessage(error)}`,
      );
      await this.rollback(target.deviceId, state, added);
      await this.throwIfTakenMeanwhile(target, state, request);
      rethrowDeviceTransportUnavailable(error);
      throw toActionableError(
        error,
        `adb reverse ${tcp(request.devicePort)} ${tcp(request.hostPort)} failed on ${target.deviceId}`,
      );
    }
    // A port already owned (lost, then re-added here) keeps its ownership if a later add fails.
    if (!state.owned.has(request.devicePort)) {
      added.push(request.devicePort);
    }
    state.owned.set(request.devicePort, { hostPort: request.hostPort, owner: target.owner });
    this.audit(
      `ensure ${tcp(request.devicePort)} -> ${tcp(request.hostPort)} device=${target.deviceId} session=${target.owner}`,
    );
  }

  /**
   * A failed `--no-rebind` add whose port `--list` now shows was mapped by someone else after this
   * call's own `--list` read: report it as the conflict it is, not as a generic adb failure.
   */
  private async throwIfTakenMeanwhile(
    target: PortReverseTarget,
    state: DeviceState,
    request: PortReverseRequest,
  ): Promise<void> {
    const current = await state.adb.list().then(
      (entries) => entries.find((entry) => entry.devicePort === request.devicePort),
      (error: unknown) => {
        // The add's own error is reported instead; this re-read only refines it.
        logger.debug(`[portReverse] re-list after failed add failed: ${errorMessage(error)}`);
        return undefined;
      },
    );
    if (current !== undefined) {
      throw new PortReverseError(
        "port_reverse_conflict",
        `${tcp(request.devicePort)} on ${target.deviceId} was mapped to ${current.host} by someone else during this call; it was left in place.`,
        [request.devicePort],
      );
    }
  }

  /**
   * Undoes this call's adds after a later one failed, so ensure is all-or-nothing. It re-reads
   * `--list` first, like `remove`, so a port someone re-pointed meanwhile is left alone. A port
   * whose removal cannot be confirmed stays owned, so release still cleans it up.
   */
  private async rollback(deviceId: string, state: DeviceState, added: readonly number[]) {
    if (added.length === 0) {
      return;
    }
    let view: DeviceView;
    try {
      view = await this.view(deviceId, state);
    } catch (error) {
      logger.warn(
        `[portReverse] rollback on ${deviceId} could not read --list; keeping ${added.map(tcp).join(", ")} owned: ${errorMessage(error)}`,
      );
      return;
    }
    for (const devicePort of added) {
      await this.removeOwned(deviceId, state, devicePort, view).catch((error: unknown) => {
        logger.warn(
          `[portReverse] rolling back ${tcp(devicePort)} on ${deviceId} failed: ${errorMessage(error)}`,
        );
      });
    }
  }

  /**
   * Removes the port only while it still maps where AutoMobile pointed it. Ownership is dropped
   * once the mapping is confirmed absent or foreign, or after the removal succeeds; a failed removal
   * keeps it, so the caller can retry and release can still clean it up.
   */
  private async removeOwned(
    deviceId: string,
    state: DeviceState,
    devicePort: number,
    view: DeviceView,
  ): Promise<PortReverseMapping> {
    const mapping = state.owned.get(devicePort);
    const current = view.get(devicePort);
    if (mapping === undefined || current === undefined) {
      state.owned.delete(devicePort);
      return { devicePort, host: "", owned: false, status: "gone" };
    }
    if (current.hostPort !== mapping.hostPort) {
      state.owned.delete(devicePort);
      return { ...current, owned: false, status: "foreign" };
    }
    try {
      await state.adb.remove(devicePort);
    } catch (error) {
      rethrowDeviceTransportUnavailable(error);
      throw toActionableError(
        error,
        `adb reverse --remove ${tcp(devicePort)} failed on ${deviceId}`,
      );
    }
    state.owned.delete(devicePort);
    this.audit(
      `remove ${tcp(devicePort)} -> ${tcp(mapping.hostPort)} device=${deviceId} session=${mapping.owner}`,
    );
    return { ...current, owned: false, status: "removed" };
  }

  /** Best-effort release: the device may be gone, so failures are expected and logged at debug. */
  private async releaseWhere(
    deviceId: string,
    state: DeviceState,
    matches: (mapping: OwnedMapping) => boolean,
  ): Promise<void> {
    const ports = [...state.owned].filter(([, mapping]) => matches(mapping)).map(([port]) => port);
    if (ports.length === 0) {
      return;
    }
    let view: DeviceView;
    try {
      view = await this.view(deviceId, state);
    } catch (error) {
      // A released or unplugged device often cannot answer; the removal is kept pending, never
      // restored, and retried if the device answers again.
      logger.debug(`[portReverse] release on ${deviceId}: --list failed: ${errorMessage(error)}`);
      ports.forEach((port) => this.deferRemoval(state, port));
      return;
    }
    for (const port of ports) {
      await this.removeOwned(deviceId, state, port, view).catch((error: unknown) => {
        logger.warn(
          `[portReverse] release ${tcp(port)} on ${deviceId} failed; retrying on the next call: ${errorMessage(error)}`,
        );
        this.deferRemoval(state, port);
      });
    }
  }

  /** The owner is released, so the port leaves `owned` (never restored) and waits for removal. */
  private deferRemoval(state: DeviceState, port: number): void {
    const mapping = state.owned.get(port);
    state.owned.delete(port);
    if (mapping !== undefined) {
      state.pendingRemoval.set(port, mapping.hostPort);
    }
  }

  private describe(
    owner: string,
    state: DeviceState,
    entry: AdbReverseEntry,
    report: PortReverseRestoreReport,
  ): PortReverseMapping {
    const owned = state.owned.get(entry.devicePort)?.owner === owner;
    const status = report.restored.includes(entry.devicePort) ? "restored" : "present";
    return { ...entry, owned, status };
  }
}

function conflictReason(
  owner: string,
  owned: OwnedMapping | undefined,
  view: DeviceView,
  request: PortReverseRequest,
): string | undefined {
  if (owned !== undefined) {
    if (owned.owner !== owner) {
      return `${tcp(request.devicePort)} is owned by another session`;
    }
    if (owned.hostPort !== request.hostPort) {
      return `${tcp(request.devicePort)} already maps to ${tcp(owned.hostPort)} for this session`;
    }
    const live = view.get(request.devicePort);
    return live === undefined || live.hostPort === owned.hostPort
      ? undefined
      : `${tcp(request.devicePort)} was re-pointed to ${live.host} outside AutoMobile`;
  }
  const current = view.get(request.devicePort);
  return current === undefined
    ? undefined
    : `${tcp(request.devicePort)} already maps to ${current.host}, not created by AutoMobile`;
}

function entryFor(request: PortReverseRequest): AdbReverseEntry {
  return {
    devicePort: request.devicePort,
    host: tcp(request.hostPort),
    hostPort: request.hostPort,
  };
}

function ownedMapping(request: PortReverseRequest, status: PortReverseStatus): PortReverseMapping {
  return { ...entryFor(request), owned: true, status };
}

/** One request per device port; two different host ports for one device port is a conflict. */
function uniqueRequests(requests: readonly PortReverseRequest[]): PortReverseRequest[] {
  const byPort = new Map<number, PortReverseRequest>();
  for (const request of requests) {
    const earlier = byPort.get(request.devicePort);
    if (earlier !== undefined && earlier.hostPort !== request.hostPort) {
      throw new PortReverseError(
        "port_reverse_conflict",
        `${tcp(request.devicePort)} was requested for both ${tcp(earlier.hostPort)} and ${tcp(request.hostPort)}.`,
        [request.devicePort],
      );
    }
    byPort.set(request.devicePort, request);
  }
  return [...byPort.values()];
}
