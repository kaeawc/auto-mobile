export type ShownSpecJson = Readonly<Record<string, unknown>>;
export type ShownSpecRead =
  | { kind: "known"; spec: ShownSpecJson; version: number }
  | { kind: "busy" }
  | { kind: "unknown" };
interface DeviceSpecs {
  entry?: { id: string; spec: ShownSpecJson };
  epoch: number;
  issued: number;
  lastTicket: number;
  open: Set<number>;
  poisonedThrough: number;
}
/** Tracks acknowledged device specs, forgetting outcomes whose wire order is indeterminate. */
export class PrototypeShownSpecs {
  private readonly devices = new Map<string, DeviceSpecs>();

  beginShow(deviceId: string): number {
    const state = this.devices.get(deviceId) ?? {
      epoch: 0,
      issued: 0,
      lastTicket: 0,
      open: new Set<number>(),
      poisonedThrough: 0,
    };
    const ticket = ++state.issued;
    state.lastTicket = ticket;
    state.open.add(ticket);
    state.epoch++;
    this.devices.set(deviceId, state);
    return ticket;
  }

  endShow(deviceId: string, ticket: number, shown?: { id: string; spec: ShownSpecJson }): void {
    const state = this.devices.get(deviceId);
    if (!state?.open.delete(ticket)) {
      return;
    }
    state.epoch++;
    if (ticket === state.lastTicket) {
      state.entry =
        shown && ticket > state.poisonedThrough
          ? { id: shown.id, spec: structuredClone(shown.spec) }
          : undefined;
    }
  }

  read(deviceId: string, id: string): ShownSpecRead {
    const state = this.devices.get(deviceId);
    if (state && state.open.size > 0) {
      return { kind: "busy" };
    }
    return state?.entry?.id === id
      ? { kind: "known", spec: state.entry.spec, version: state.epoch }
      : { kind: "unknown" };
  }

  commitPatch(deviceId: string, id: string, version: number, spec: ShownSpecJson): boolean {
    const state = this.devices.get(deviceId);
    if (!state) {
      return false;
    }
    const committed = state.open.size === 0 && state.epoch === version && state.entry?.id === id;
    if (committed) {
      state.entry = { id, spec: structuredClone(spec) };
    } else {
      state.entry = undefined;
      state.poisonedThrough = state.issued;
    }
    state.epoch++;
    return committed;
  }

  forget(deviceId: string, id?: string): void {
    const state = this.devices.get(deviceId);
    if (state?.entry && (id === undefined || state.entry.id === id)) {
      state.entry = undefined;
      state.epoch++;
    }
  }

  retainOnly(deviceId: string, id: string): void {
    const entry = this.devices.get(deviceId)?.entry;
    if (entry && entry.id !== id) {
      this.forget(deviceId);
    }
  }

  clearDevice(deviceId: string): void {
    this.devices.delete(deviceId);
  }
}
