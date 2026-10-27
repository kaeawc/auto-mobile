import { prototypeDataPointerTokens } from "./prototypeData";
import { applyPrototypeDataWrite } from "./prototypeDataWrite";
import { prototypeDeviceDataWrite, type PrototypeDataWriteEvent } from "./prototypeDataWriteEvent";
import type { PrototypeData } from "./prototypeSpec";

export type ShownSpecJson = Readonly<Record<string, unknown>>;
export type ShownSpecRead =
  | { kind: "known"; spec: ShownSpecJson; version: number }
  | { kind: "busy" }
  | { kind: "unknown" };
interface PendingShow {
  id?: string;
  replaceOthers: boolean;
  superseded: boolean;
}
/** Device `/data` writes the host has seen for one prototype, oldest first, bounded. */
interface DataWriteLog {
  /** Writes at or below this revision were dropped from `writes`, so their paths are unknown. */
  floor: number;
  writes: { path: string; revision: number }[];
}
/** What a device data write did to the host's mirror of the prototype. */
export type DeviceDataWriteOutcome =
  | { kind: "mirrored"; data: PrototypeData }
  | { kind: "dropped" }
  | { kind: "untracked" };
/** Whether a host `/data` patch may be built on `baseRevision` given the device writes seen. */
export type DataPatchGuard =
  | { kind: "ok" }
  | { kind: "baseRevisionRequired" }
  | { kind: "conflict"; revision: number; paths: string[] };
const MAX_TRACKED_DATA_WRITES = 64;

function dataPathTokens(path: string): string[] {
  return path === "/data" ? [] : prototypeDataPointerTokens(path.slice("/data".length));
}
/** Two `/data` paths overlap when one addresses the other or something inside it. */
function pathsOverlap(a: string, b: string): boolean {
  const left = dataPathTokens(a);
  const right = dataPathTokens(b);
  const shared = Math.min(left.length, right.length);
  return left.slice(0, shared).every((token, index) => token === right[index]);
}

interface DeviceSpecs {
  /** The device's platform, as the show that created this state reported it. */
  platform?: "android" | "ios";
  entries: Map<string, ShownSpecJson>;
  dataWrites: Map<string, DataWriteLog>;
  epoch: number;
  issued: number;
  open: Map<number, PendingShow>;
  poisonedThrough: number;
}
/** Tracks acknowledged device specs, forgetting outcomes whose wire order is indeterminate. */
export class PrototypeShownSpecs {
  private sequence = 0;
  private readonly devices = new Map<string, DeviceSpecs>();

  beginShow(
    deviceId: string,
    id?: string,
    replaceOthers = true,
    platform?: "android" | "ios",
  ): number {
    const state = this.devices.get(deviceId) ?? {
      entries: new Map<string, ShownSpecJson>(),
      dataWrites: new Map<string, DataWriteLog>(),
      epoch: 0,
      issued: 0,
      open: new Map<number, PendingShow>(),
      poisonedThrough: 0,
    };
    state.platform = platform ?? state.platform;
    const ticket = ++this.sequence;
    state.issued = ticket;
    for (const pending of state.open.values()) {
      // Keep default-show ordering conservative; additive shows of separate ids are independent.
      if (replaceOthers || pending.replaceOthers || pending.id === id) {
        pending.superseded = true;
      }
    }
    state.open.set(ticket, { id, replaceOthers, superseded: false });
    state.epoch = ++this.sequence;
    this.devices.set(deviceId, state);
    return ticket;
  }

  endShow(
    deviceId: string,
    ticket: number,
    shown?: { id: string; spec?: ShownSpecJson; replaceOthers?: boolean },
    refusal?: "typed" | "indeterminate",
  ): void {
    const state = this.devices.get(deviceId);
    const pending = state?.open.get(ticket);
    if (!state || !pending) {
      return;
    }
    state.open.delete(ticket);
    state.epoch = ++this.sequence;
    if (pending.superseded) {
      return;
    }
    if (refusal) {
      // A typed refusal leaves the previous prototype on screen, so its mirror stays; only an
      // indeterminate outcome (the device may have replaced it) forgets it.
      if (refusal === "indeterminate" && pending.id !== undefined) {
        state.entries.delete(pending.id);
        state.dataWrites.delete(pending.id);
      }
      return;
    }
    if (shown && ticket > state.poisonedThrough) {
      if (shown.replaceOthers !== false) {
        state.entries.clear();
        state.dataWrites.clear();
      }
      // No spec means the device may have restored stored `/data` the host cannot see: untracked
      // until the next show.
      if (shown.spec) {
        state.entries.set(shown.id, structuredClone(shown.spec));
      } else {
        state.entries.delete(shown.id);
      }
      // A show makes its spec's data authoritative again, so earlier device writes are void.
      state.dataWrites.delete(shown.id);
    } else {
      state.entries.clear();
      state.dataWrites.clear();
    }
  }

  read(deviceId: string, id: string): ShownSpecRead {
    const state = this.devices.get(deviceId);
    if (state && state.open.size > 0) {
      return { kind: "busy" };
    }
    const spec = state?.entries.get(id);
    return spec && state ? { kind: "known", spec, version: state.epoch } : { kind: "unknown" };
  }

  /** The platform of a device a show was sent to, while its state is kept. */
  platformOf(deviceId: string): "android" | "ios" | undefined {
    return this.devices.get(deviceId)?.platform;
  }

  /** Devices with an acknowledged spec for this id, sorted. */
  devicesShowing(id: string): string[] {
    return [...this.devices.entries()]
      .filter(([, state]) => state.entries.has(id))
      .map(([deviceId]) => deviceId)
      .sort();
  }

  commitPatch(deviceId: string, id: string, version: number, spec: ShownSpecJson): boolean {
    const state = this.devices.get(deviceId);
    if (!state) {
      return false;
    }
    const committed = state.open.size === 0 && state.epoch === version && state.entries.has(id);
    if (committed) {
      state.entries.set(id, structuredClone(spec));
      state.epoch = ++this.sequence;
    } else {
      this.abandon(deviceId);
    }
    return committed;
  }

  /**
   * The device wrote `/data` (setData, appendData, removeData). The write is applied to the host's
   * copy of the spec with the same function the device uses, so the copy stays exact; when that is
   * not possible (the value did not travel, the copy disagrees, or a show is in flight and the two
   * cannot be ordered) the host stops tracking the spec and the next patch must follow a show.
   * Applied writes are logged for {@link dataPatchGuard}.
   */
  recordDeviceDataWrite(
    deviceId: string,
    id: string,
    write: PrototypeDataWriteEvent,
  ): DeviceDataWriteOutcome {
    const state = this.devices.get(deviceId);
    if (!state) {
      return { kind: "untracked" };
    }
    if (state.open.size > 0) {
      this.abandon(deviceId);
      return { kind: "dropped" };
    }
    const spec = state.entries.get(id);
    if (!spec) {
      return { kind: "untracked" };
    }
    const applied =
      write.op === "remove"
        ? applyPrototypeDataWrite(spec.data, { op: "remove", path: write.path })
        : write.value === undefined
          ? undefined
          : applyPrototypeDataWrite(spec.data, prototypeDeviceDataWrite(write, write.value));
    if (!applied?.success) {
      this.forget(deviceId, id);
      return { kind: "dropped" };
    }
    state.entries.set(id, { ...spec, data: applied.data });
    state.epoch = ++this.sequence;
    const log = state.dataWrites.get(id) ?? { floor: 0, writes: [] };
    log.writes.push({ path: write.path, revision: write.revision });
    while (log.writes.length > MAX_TRACKED_DATA_WRITES) {
      log.floor = Math.max(log.floor, log.writes.shift()!.revision);
    }
    state.dataWrites.set(id, log);
    return { kind: "mirrored", data: applied.data };
  }

  /**
   * The rule that keeps a host `/data` patch and a device data write from silently losing each
   * other. Once the device has written this prototype's data, a patch with `/data` ops needs the
   * `baseRevision` its author last saw, and it conflicts when a write newer than that revision
   * touched an overlapping path (or the host no longer remembers which paths were written).
   * `paths` are the patch's `/data` op paths.
   */
  dataPatchGuard(
    deviceId: string,
    id: string,
    paths: readonly string[],
    baseRevision: number | undefined,
  ): DataPatchGuard {
    const log = this.devices.get(deviceId)?.dataWrites.get(id);
    if (!log || paths.length === 0) {
      return { kind: "ok" };
    }
    if (baseRevision === undefined) {
      return { kind: "baseRevisionRequired" };
    }
    // Writes at or below the floor were forgotten, so a base that old cannot be shown safe.
    const unknown = baseRevision < log.floor;
    const touched = log.writes.filter(
      (write) =>
        write.revision > baseRevision && paths.some((path) => pathsOverlap(path, write.path)),
    );
    if (!unknown && touched.length === 0) {
      return { kind: "ok" };
    }
    return {
      kind: "conflict",
      revision: Math.max(baseRevision, log.floor, ...log.writes.map((write) => write.revision)),
      paths: unknown ? [...paths] : [...new Set(touched.map((write) => write.path))],
    };
  }

  /** A patch for this device has an unknown outcome: forget the entries and distrust every show dispatched so far. */
  abandon(deviceId: string): void {
    const state = this.devices.get(deviceId);
    if (!state) {
      return;
    }
    state.entries.clear();
    state.dataWrites.clear();
    state.poisonedThrough = state.issued;
    state.epoch = ++this.sequence;
  }

  forget(deviceId: string, id?: string): void {
    const state = this.devices.get(deviceId);
    if (state && (id === undefined || state.entries.has(id))) {
      if (id === undefined) {
        state.entries.clear();
        state.dataWrites.clear();
      } else {
        state.entries.delete(id);
        state.dataWrites.delete(id);
      }
      state.epoch = ++this.sequence;
    }
  }

  retainOnly(deviceId: string, id: string): void {
    const state = this.devices.get(deviceId);
    for (const knownId of state?.entries.keys() ?? []) {
      if (knownId !== id) {
        this.forget(deviceId, knownId);
      }
    }
  }

  clearDevice(deviceId: string): void {
    this.devices.delete(deviceId);
  }
}
