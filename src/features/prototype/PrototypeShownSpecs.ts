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
interface DeviceSpecs {
  entries: Map<string, ShownSpecJson>;
  epoch: number;
  issued: number;
  open: Map<number, PendingShow>;
  poisonedThrough: number;
}
/** Tracks acknowledged device specs, forgetting outcomes whose wire order is indeterminate. */
export class PrototypeShownSpecs {
  private sequence = 0;
  private readonly devices = new Map<string, DeviceSpecs>();

  beginShow(deviceId: string, id?: string, replaceOthers = true): number {
    const state = this.devices.get(deviceId) ?? {
      entries: new Map<string, ShownSpecJson>(),
      epoch: 0,
      issued: 0,
      open: new Map<number, PendingShow>(),
      poisonedThrough: 0,
    };
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
    shown?: { id: string; spec: ShownSpecJson; replaceOthers?: boolean },
    refused = false,
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
    if (refused) {
      if (pending.id !== undefined) {
        state.entries.delete(pending.id);
      }
      return;
    }
    if (shown && ticket > state.poisonedThrough) {
      if (shown.replaceOthers !== false) {
        state.entries.clear();
      }
      state.entries.set(shown.id, structuredClone(shown.spec));
    } else {
      state.entries.clear();
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

  /** A patch for this device has an unknown outcome: forget the entries and distrust every show dispatched so far. */
  abandon(deviceId: string): void {
    const state = this.devices.get(deviceId);
    if (!state) {
      return;
    }
    state.entries.clear();
    state.poisonedThrough = state.issued;
    state.epoch = ++this.sequence;
  }

  forget(deviceId: string, id?: string): void {
    const state = this.devices.get(deviceId);
    if (state && (id === undefined || state.entries.has(id))) {
      if (id === undefined) {
        state.entries.clear();
      } else {
        state.entries.delete(id);
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
