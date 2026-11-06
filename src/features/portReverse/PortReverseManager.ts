import type {
  AdbReverseCommands,
  AdbReverseEntry,
} from "../../utils/android-cmdline-tools/adbReverse";
import { rethrowDeviceTransportUnavailable } from "../../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { DeviceLostError } from "../../models/DeviceLostError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { unknownHostLoopbackProbe, type HostLoopbackProbe } from "./HostLoopbackProbe";
import { PortReverseError } from "./PortReverseError";
import { assertNoConflicts } from "./portReverseConflicts";
import { deviceListeners, throwIfDevicePortHeld, type DeviceListener } from "./deviceListeners";
import { httpProbePort, tcpProbePort, type PortReverseHttpProbe } from "./portReverseProbes";

export { PORT_PROBE_TIMEOUT_MS } from "./portReverseProbes";

/** One device port to reverse to a host loopback port. */
export interface PortReverseRequest {
  devicePort: number;
  hostPort: number;
}

/**
 * `added`/`present`/`restored`: the mapping is on the device. `missing`: an owned mapping is gone
 * and could not be restored, or a mapping that was asked about does not exist. `removed`: this call
 * removed it. `gone`: it had already disappeared. `foreign`: the device port now maps somewhere this
 * session did not create, so it was left in place. Only `verify` with `probe` reports the last three
 * for a mapping that is on the device: `reachable` (a device-side connect reached a host server
 * that kept it open), `unreachable` (see `probeReason`), `probe_unsupported` (the device shell
 * cannot run the connect, so nothing is guessed).
 */
export type PortReverseStatus =
  | "added"
  | "present"
  | "restored"
  | "missing"
  | "removed"
  | "gone"
  | "foreign"
  | "reachable"
  | "unreachable"
  | "probe_unsupported";

/**
 * Why a probe was `unreachable` or `probe_unsupported`. `closed`: the reverse accepted the connect
 * but the host side is not listening. `refused`: nothing listens on the device port. `timeout`: the
 * device did not answer the probe in time. HTTP probe only: `http_status` (a status not in
 * `expectStatus`), `http_body` (the body lacks `expectBodyContains`), `no_http_response` (the
 * connection ended, or something answered, without an HTTP status line).
 */
export type PortProbeReason =
  | "closed"
  | "refused"
  | "timeout"
  | "unsupported"
  | "http_status"
  | "http_body"
  | "no_http_response";

/** `verify`'s probe: `true` for a TCP connect, or an HTTP request whose response is checked. */
export type PortReverseProbeOption = boolean | { http: PortReverseHttpProbe };

export interface PortReverseMapping {
  devicePort: number;
  /** Host TCP port; absent when the host side is not `tcp:` (e.g. `localabstract:`). */
  hostPort?: number;
  /** Host spec as adb reports it, e.g. `tcp:8080`. */
  host: string;
  /** This session created the mapping and will remove it on release. */
  owned: boolean;
  status: PortReverseStatus;
  /** Set with `unreachable` and `probe_unsupported`. */
  probeReason?: PortProbeReason;
  /** Device output that made the probe unsupported, or what came back instead of HTTP. */
  probeDetail?: string;
  /** HTTP probe: the response's status code. */
  httpStatus?: number;
  /** `list` only: whether the `tcp:` host target accepts a loopback connect; absent when unknown. */
  hostListening?: boolean;
  /** `ensure` with `reclaimStale`: the stale mapping this call removed before adding its own. */
  reclaimed?: PortReverseReclaim;
  /** `list`/`verify`: what listens on the device port. */
  deviceListener?: DeviceListener;
}

/** A stale mapping `ensure` removed: its host spec, and why it was judged dead. */
export interface PortReverseReclaim {
  host: string;
  reason: "host_refused";
}

export interface PortReverseEnsureOptions {
  /**
   * Remove a mapping no live session owns when its `tcp:` host target refuses a loopback connect,
   * then add the requested one. Needs a caller that holds the device (`holdsDevice`).
   */
  reclaimStale?: boolean;
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
  /** The call comes from a session the device is bound to; required to reclaim a stale mapping. */
  holdsDevice?: boolean;
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
  /**
   * Owner -> number of its `ensure` calls queued or running. Ownership is recorded only after the
   * add succeeds, so a release that races an in-flight ensure counts these as mappings to clean up
   * and queues its removal behind them (#17104).
   */
  ensuring: Map<string, number>;
  /**
   * Owner -> owned device ports a background {@link PortReverseManager.reconcile} re-applied since
   * that owner's last ensure/list/verify, which reports them as `restored` once and clears them.
   */
  backgroundRestored: Map<string, Set<number>>;
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

  constructor(
    private readonly audit: PortReverseAudit = defaultAudit,
    private readonly timer: Timer = defaultTimer,
    private readonly hostProbe: HostLoopbackProbe = unknownHostLoopbackProbe,
  ) {}

  /**
   * Idempotently adds each mapping; throws `port_reverse_conflict` and changes nothing on a clash.
   * With `reclaimStale`, a clash with a stale mapping (see {@link PortReverseEnsureOptions}) is
   * removed and replaced instead.
   */
  ensure(
    target: PortReverseTarget,
    requests: readonly PortReverseRequest[],
    options?: PortReverseEnsureOptions,
  ) {
    const state = this.stateFor(target);
    const { owner } = target;
    state.ensuring.set(owner, (state.ensuring.get(owner) ?? 0) + 1);
    const run = this.enqueue(state, async (): Promise<PortReverseResult> => {
      const wanted = uniqueRequests(requests);
      // Conflicts are judged on the device as it is, before any restore: a refused request changes
      // nothing on the device.
      const view = await this.view(target.deviceId, state);
      const reclaimable = await assertNoConflicts(
        { owner: target.owner, holdsDevice: target.holdsDevice === true, view, owned: state.owned },
        wanted,
        { hostProbe: this.hostProbe, reclaimStale: options?.reclaimStale === true },
      );
      const report = await this.restoreFor(target, state, view);
      const added: number[] = [];
      const mappings: PortReverseMapping[] = [];
      for (const request of wanted) {
        const stale = reclaimable.get(request.devicePort);
        if (stale !== undefined) {
          const reclaimed = await this.reclaim(target, state, stale, added);
          await this.add(target, state, request, added);
          mappings.push({ ...ownedMapping(request, "added"), ...(reclaimed ? { reclaimed } : {}) });
          continue;
        }
        if (view.has(request.devicePort)) {
          const status = report.restored.includes(request.devicePort) ? "restored" : "present";
          mappings.push(ownedMapping(request, status));
          continue;
        }
        await this.add(target, state, request, added);
        mappings.push(ownedMapping(request, "added"));
      }
      return this.acknowledge(state, target.owner, { mappings, ...report });
    });
    return run.finally(() => {
      const left = (state.ensuring.get(owner) ?? 1) - 1;
      if (left === 0) {
        state.ensuring.delete(owner);
      } else {
        state.ensuring.set(owner, left);
      }
    });
  }

  /** Every reverse on the device, each marked whether this session owns it. */
  list(target: PortReverseTarget) {
    const state = this.stateFor(target);
    return this.enqueue(state, async (): Promise<PortReverseResult> => {
      const { view, report } = await this.reconciled(target, state);
      const mappings = await Promise.all(
        [...view.values()].map(async (entry) => ({
          ...this.describe(target.owner, state, entry, report),
          ...(await this.hostListening(entry)),
        })),
      );
      for (const [devicePort, mapping] of state.owned) {
        if (mapping.owner === target.owner && !view.has(devicePort)) {
          mappings.push(ownedMapping({ devicePort, hostPort: mapping.hostPort }, "missing"));
        }
      }
      return this.acknowledge(state, target.owner, {
        mappings: (await this.withDeviceListeners(target, view, mappings)).sort(
          (a, b) => a.devicePort - b.devicePort,
        ),
        ...report,
      });
    });
  }

  /**
   * Whether each port (default: every port this session owns) is mapped on the device now. With
   * `probe`, each mapping that is on the device is then connected to from the device, so it
   * reports `reachable`, `unreachable` or `probe_unsupported`; `missing` ports are not probed.
   */
  verify(
    target: PortReverseTarget,
    ports?: readonly number[],
    options?: { probe?: PortReverseProbeOption },
  ) {
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
      const described = await this.withDeviceListeners(target, view, mappings);
      const probe = options?.probe;
      if (probe !== undefined && probe !== false) {
        const probed = await Promise.all(
          described.map((mapping) => this.probeMapping(target, mapping, probe)),
        );
        return this.acknowledge(state, target.owner, { mappings: probed, ...report });
      }
      return this.acknowledge(state, target.owner, { mappings: described, ...report });
    });
  }

  /** Adds each mapping's `deviceListener`, from one read of the device's listener table. */
  private async withDeviceListeners(
    target: PortReverseTarget,
    view: DeviceView,
    mappings: readonly PortReverseMapping[],
  ): Promise<PortReverseMapping[]> {
    const listeners = await deviceListeners(
      target.adb,
      target.deviceId,
      mappings.map((mapping) => mapping.devicePort),
      new Set(view.keys()),
    );
    return mappings.map((mapping) => {
      const deviceListener = listeners.get(mapping.devicePort);
      return deviceListener === undefined ? mapping : { ...mapping, deviceListener };
    });
  }

  /** One mapping's probe result; a mapping that is not on the device is returned as it is. */
  private async probeMapping(
    target: PortReverseTarget,
    mapping: PortReverseMapping,
    probe: true | { http: PortReverseHttpProbe },
  ): Promise<PortReverseMapping> {
    if (mapping.status === "missing") {
      return mapping;
    }
    const pass = { deviceId: target.deviceId, devicePort: mapping.devicePort, timer: this.timer };
    const verdict =
      probe === true
        ? await tcpProbePort(target.adb, pass)
        : await httpProbePort(target.adb, pass, probe.http);
    return { ...mapping, ...verdict };
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
   * path calls this after the device is back (`PortReverseRecoveryScheduler`). What it restores is
   * reported to each owning session as `restored` in its next ensure/list/verify result; a failure
   * is logged, stays owned, and is retried (and reported in `restoreFailures`) by that next call.
   */
  async reconcile(deviceId: string): Promise<PortReverseRestoreReport> {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return { restored: [], restoreFailures: [] };
    }
    return this.enqueue(state, async () => {
      const view = await this.view(deviceId, state);
      const report = await this.restoreMissing(deviceId, state, view);
      for (const devicePort of report.restored) {
        const owner = state.owned.get(devicePort)?.owner;
        if (owner !== undefined) {
          const ports = state.backgroundRestored.get(owner) ?? new Set<number>();
          ports.add(devicePort);
          state.backgroundRestored.set(owner, ports);
        }
      }
      return report;
    });
  }

  /**
   * Whether `owner` holds any mapping on the device, or has an `ensure` there still in flight that
   * may yet create one. A release queued now runs after that ensure, so it removes what it adds.
   */
  hasOwnedMappings(owner: string, deviceId: string): boolean {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return false;
    }
    return state.ensuring.has(owner) || [...state.owned.values()].some((m) => m.owner === owner);
  }

  /** The session ended or left the device: remove the mappings it owns there. */
  async releaseOwnerOnDevice(owner: string, deviceId: string): Promise<void> {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return;
    }
    await this.enqueue(state, () =>
      this.releaseWhere(deviceId, state, (holder) => holder === owner),
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
      state.backgroundRestored.delete(owner);
    });
  }

  /**
   * The pool has evidence another device now answers on this serial: forget every owned mapping and
   * pending removal there, synchronously and without a command, so no reconcile queued or scheduled
   * afterwards re-adds the old device's mappings to the replacement.
   */
  forgetDevice(deviceId: string): void {
    const state = this.devices.get(deviceId);
    if (state === undefined) {
      return;
    }
    state.owned.clear();
    state.pendingRemoval.clear();
    state.backgroundRestored.clear();
  }

  /** Released mappings on the device whose removal is still pending, ascending. */
  pendingRemovals(deviceId: string): number[] {
    return [...(this.devices.get(deviceId)?.pendingRemoval.keys() ?? [])].sort((a, b) => a - b);
  }

  /** The session ended: remove the mappings it owns on every device. */
  async releaseOwner(owner: string): Promise<void> {
    await Promise.all(
      [...this.devices].map(([deviceId, state]) =>
        this.enqueue(state, () => this.releaseWhere(deviceId, state, (holder) => holder === owner)),
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
        ensuring: new Map(),
        backgroundRestored: new Map(),
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

  /** A call returned these background restores to the owner: stop reporting them. */
  private acknowledge(
    state: DeviceState,
    owner: string,
    result: PortReverseResult,
  ): PortReverseResult {
    const pending = state.backgroundRestored.get(owner);
    result.restored.forEach((port) => pending?.delete(port));
    if (pending?.size === 0) {
      state.backgroundRestored.delete(owner);
    }
    return result;
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
    // Ports a background reconcile restored since this owner's last call, still owned and mapped;
    // cleared by `acknowledge` once the call returns them, so a call that throws keeps them.
    const earlier = [...(state.backgroundRestored.get(target.owner) ?? [])].filter(
      (port) => mine(port) && view.has(port),
    );
    const report: PortReverseRestoreReport = {
      restored: [...new Set([...earlier, ...all.restored.filter(mine)])].sort((a, b) => a - b),
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
      // Fence: forgetDevice (another device now on this serial) may have run while an earlier add
      // of this loop was in flight; never restore a mapping that is no longer owned.
      if (state.owned.get(devicePort) === mapping) {
        await this.restoreOne({ deviceId, state, view, report }, devicePort, mapping);
      }
    }
    return report;
  }

  /** Re-adds one lost owned mapping, recording the outcome in `report`. */
  private async restoreOne(
    pass: {
      deviceId: string;
      state: DeviceState;
      view: DeviceView;
      report: PortReverseRestoreReport;
    },
    devicePort: number,
    mapping: OwnedMapping,
  ): Promise<void> {
    const { deviceId, state, view, report } = pass;
    try {
      await state.adb.add(devicePort, mapping.hostPort, { noRebind: true });
    } catch (error) {
      // Kept owned so the next call retries; the failure is reported in that call's result.
      logger.warn(
        `[portReverse] restoring ${tcp(devicePort)} on ${deviceId} failed: ${errorMessage(error)}`,
      );
      report.restoreFailures.push({ devicePort, error: errorMessage(error) });
      return;
    }
    if (state.owned.get(devicePort) !== mapping) {
      // The device was forgotten while this add was in flight: the mapping may now sit on a
      // replacement device that no cleanup would remove, so undo it here.
      await this.undoForgottenRestore(deviceId, state, devicePort, mapping.hostPort);
      return;
    }
    view.set(devicePort, entryFor({ devicePort, hostPort: mapping.hostPort }));
    report.restored.push(devicePort);
    this.audit(
      `restore ${tcp(devicePort)} -> ${tcp(mapping.hostPort)} device=${deviceId} session=${mapping.owner}`,
    );
  }

  /**
   * Removes a restore that landed after its device was forgotten, but only while `--list` still
   * shows the port mapped where this restore pointed it: a different mapping there is someone
   * else's and is left alone. A removal that cannot be confirmed is kept pending, so the device's
   * next `--list` retries it under the same rule.
   */
  private async undoForgottenRestore(
    deviceId: string,
    state: DeviceState,
    devicePort: number,
    hostPort: number,
  ): Promise<void> {
    try {
      const current = (await state.adb.list()).find((entry) => entry.devicePort === devicePort);
      if (current?.hostPort !== hostPort) {
        return;
      }
      await state.adb.remove(devicePort);
      this.audit(`remove ${tcp(devicePort)} -> ${tcp(hostPort)} device=${deviceId} (forgotten)`);
    } catch (error) {
      logger.warn(
        `[portReverse] undoing ${tcp(devicePort)} restored on ${deviceId} after it was forgotten failed; retrying on the next call: ${errorMessage(error)}`,
      );
      state.pendingRemoval.set(devicePort, hostPort);
    }
  }

  /**
   * Removes a stale mapping found by this call's `--list`, after reading `--list` again: a port
   * that changed meanwhile is someone's live mapping and is left in place. Returns what was
   * reclaimed, or undefined when the mapping had already gone.
   */
  private async reclaim(
    target: PortReverseTarget,
    state: DeviceState,
    stale: AdbReverseEntry,
    added: number[],
  ): Promise<PortReverseReclaim | undefined> {
    const port = tcp(stale.devicePort);
    const fail = async (detail: string, cause?: unknown): Promise<never> => {
      // A lost device is the call's failure, never a reclaim failure the caller could retry.
      if (cause instanceof DeviceLostError) {
        throw cause;
      }
      await this.rollback(target.deviceId, state, added);
      if (cause !== undefined) {
        rethrowDeviceTransportUnavailable(cause);
      }
      throw new PortReverseError(
        "port_reverse_reclaim_failed",
        `Could not reclaim the stale ${port} -> ${stale.host} on ${target.deviceId}: ${detail}`,
        [stale.devicePort],
      );
    };
    let current: AdbReverseEntry | undefined;
    try {
      current = (await state.adb.list()).find((entry) => entry.devicePort === stale.devicePort);
    } catch (error) {
      logger.warn(
        `[portReverse] re-list before reclaiming ${port} on ${target.deviceId} failed: ${errorMessage(error)}`,
      );
      return fail(
        `adb reverse --list failed (${errorMessage(error)}); it was left in place.`,
        error,
      );
    }
    if (current === undefined) {
      return undefined;
    }
    if (current.host !== stale.host) {
      return fail(`it now maps to ${current.host}, so it was left in place.`);
    }
    try {
      await state.adb.remove(stale.devicePort);
    } catch (error) {
      logger.warn(
        `[portReverse] removing stale ${port} on ${target.deviceId} failed: ${errorMessage(error)}`,
      );
      return fail(`adb reverse --remove failed (${errorMessage(error)}).`, error);
    }
    this.audit(
      `reclaim ${port} -> ${stale.host} device=${target.deviceId} session=${target.owner} reason=host_refused`,
    );
    return { host: stale.host, reason: "host_refused" };
  }

  /** `hostListening` for a `tcp:` mapping whose host target answered either way. */
  private async hostListening(entry: AdbReverseEntry): Promise<{ hostListening?: boolean }> {
    if (entry.hostPort === undefined) {
      return {};
    }
    const state = await this.hostProbe.probe(entry.hostPort);
    return state === "unknown" ? {} : { hostListening: state === "listening" };
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
      await throwIfDevicePortHeld(state.adb, target.deviceId, request.devicePort);
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
        [{ devicePort: request.devicePort, conflictKind: "external_unknown" }],
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
    matchesOwner: (owner: string) => boolean,
  ): Promise<void> {
    const ports = [...state.owned]
      .filter(([, mapping]) => matchesOwner(mapping.owner))
      .map(([port]) => port);
    // A released owner's pending restore notices die with it; no later call of theirs reads them.
    for (const owner of state.backgroundRestored.keys()) {
      if (matchesOwner(owner)) {
        state.backgroundRestored.delete(owner);
      }
    }
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
