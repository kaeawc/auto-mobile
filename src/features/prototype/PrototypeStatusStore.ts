import { prototypeDegradedEffectsField, type DegradedEffect } from "./prototypeDegradedEffects";
import type { PrototypeTimerReport } from "./prototypeTimerSchema";
import type { PrototypeHiddenReason } from "./prototypeHidden";
import { PrototypeShownSpecs } from "./PrototypeShownSpecs";
import type { PrototypeData } from "./prototypeSpec";
import { applyPrototypeDataWrite } from "./prototypeDataWrite";
import { prototypeDataWriteOf, prototypeDeviceDataWrite } from "./prototypeDataWriteEvent";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import type {
  PrototypeEvent,
  PrototypeResult,
  PrototypeStorageReport,
} from "../observe/android/ctrlProxyProtocol";
import {
  prototypeAppearanceAfterChange,
  shownAppearance,
  type ShownPrototypeAppearance,
} from "./prototypeAppearance";
import type { PrototypeWindowChrome } from "./prototypeWindowChrome";

export type PrototypeMutation = "show" | "dismiss";
export interface PrototypeLastResult {
  stacks?: PrototypeEvent["stacks"];
  data?: PrototypeData;
  id?: string;
  all?: true;
  lastAction: PrototypeMutation;
  /**
   * Android logical display the prototype is on: the one requested for a fresh show; a same-id show
   * without reset and a dismiss echo the shown prototype's.
   */
  /** Reported by the device through `inspect`, not shown by this host. */
  adopted?: true;
  /** Adopted prototypes only: the device keeps it after the host disconnects (`persistence: "device"`). */
  persistent?: boolean;
  /**
   * Android only: the device reported this prototype hidden because the app it was shown over is not
   * in front (as of the last `inspect`). Absent when visible and always on iOS.
   */
  suspended?: true;
  hiddenReason?: PrototypeHiddenReason;
  displayId?: number;
  /** Host-resolved chrome for a successful fullscreen show; absent for adopted prototypes. */
  chrome?: PrototypeWindowChrome;
  /**
   * The light or dark mode the prototype is drawn in, as last reported by the device: a show
   * result, an `inspect`, or an `appearance_changed` event since (which updates `mode` and `source`
   * and drops `deviceDark` until the next device result). The tool's host-local `status` action
   * strips `deviceDark` from this anyway (#11416). Absent on a dismiss, a failed show, and
   * whenever the device lacks `prototype_appearance_v1`.
   */
  appearance?: ShownPrototypeAppearance;
  /**
   * What the device last reported it has stored for this prototype (#12522), from an `inspect`.
   * Absent when the device does not report it (no prototype_storage_v1, or no `storage` block), and
   * after a show or a clearStorage, which leave the stored values for the next inspect to report.
   */
  storage?: PrototypeStorageReport;
  timers?: PrototypeTimerReport[];
  degradedEffects?: DegradedEffect[];
  success: boolean;
  error?: string;
  totalTimeMs?: number;
  timestamp: number;
}
export interface PrototypeEventState {
  pages: PrototypeEvent["pages"];
  stacks?: PrototypeEvent["stacks"];
  state: PrototypeEvent["state"];
  lastKnown: true;
  context?: PrototypeEvent["context"];
  contextTruncated?: true;
}
export interface AdoptedPrototype {
  data?: PrototypeData;
  id: string;
  persistent?: boolean;
  suspended?: boolean;
  hiddenReason?: PrototypeHiddenReason;
  appearance?: ShownPrototypeAppearance;
  storage?: PrototypeStorageReport;
  timers?: PrototypeTimerReport[];
  degradedEffects?: DegradedEffect[];
  pages: PrototypeEvent["pages"];
  stacks?: PrototypeEvent["stacks"];
  state: PrototypeEvent["state"];
}
export interface PrototypeStatus {
  prototypes: (PrototypeLastResult & Partial<PrototypeEventState>)[];
  lastResult?: PrototypeLastResult;
}
export interface PrototypeScope {
  sessionUuid?: string;
  deviceId: string;
}
export interface PrototypeStatusStore {
  status(scope: PrototypeScope): PrototypeStatus;
  /**
   * The prototype currently shown with this id on the device, from any session. Whether a same-id show
   * replaces in place is a device-wide fact, independently of its siblings.
   */
  shownOnDevice(deviceId: string, id: string): PrototypeLastResult | undefined;
  startShow(scope: PrototypeScope, id?: string): void;
  /**
   * A show is about to be sent. An accepted appearance change before its result is recorded
   * cannot be ordered against that result, so its presence must carry no appearance (#11416).
   */
  beginShowDispatch(deviceId: string, id: string): void;
  /**
   * The device reported this prototype as showing (`inspect`). Presence and its last known
   * pages/state come from the device, replacing whatever the host remembered for this id.
   */
  adopt(scope: PrototypeScope, prototype: AdoptedPrototype): void;
  recordEvent(scope: PrototypeScope, event: PrototypeEvent): void;
  /** The device reported a terminal dismissal for this prototype; its presence is gone. */
  dismissed(scope: PrototypeScope, id: string): void;
  /** Ids any session on the device still lists as shown. */
  shownIds(deviceId: string): readonly string[];
  clearDevice(deviceId: string): void;
  /** Forgets every scope on each device the session touched; returns those device ids. */
  clearSession(sessionUuid: string): readonly string[];
  record(
    scope: PrototypeScope,
    action: PrototypeMutation,
    target: { id?: string; all?: true },
    result: PrototypeResult,
    displayId?: number,
    details?: PrototypeRecordDetails,
  ): PrototypeLastResult;
  readonly shownSpecs: PrototypeShownSpecs;
  recordPatchedData(deviceId: string, id: string, data: PrototypeData | undefined): void;
  /** The device wiped this prototype's stored values (#12522): drop the reported `storage`. */
  forgetStorage(deviceId: string, id: string): void;
}
/** What a show placed besides its display: the spec's data (#11673) and the chrome drawn (#12064). */
export interface PrototypeRecordDetails {
  data?: PrototypeData;
  chrome?: PrototypeWindowChrome;
  replaceOthers?: boolean;
}
interface StoredPrototypeStatus extends PrototypeScope {
  shown: Map<string, PrototypeLastResult>;
  lastResult?: PrototypeLastResult;
  snapshots?: Map<string, PrototypeEventState>;
  pendingSnapshots?: Map<string, PrototypeEventState>;
}

function shownData(
  action: PrototypeMutation,
  result: PrototypeResult,
  data: PrototypeData | undefined,
): { data?: PrototypeData; stacks?: PrototypeEvent["stacks"] } {
  return action === "show" && result.success
    ? {
        ...(data === undefined ? {} : { data: structuredClone(data) }),
        ...(result.stacks ? { stacks: structuredClone(result.stacks) } : {}),
      }
    : {};
}

/**
 * Upper bound on remembered (session, device) scopes. Release and device-removal hooks normally
 * clear scopes; the cap bounds growth if a hook is missed, evicting the least recently recorded.
 */
export const MAX_PROTOTYPE_STATUS_SCOPES = 128;

function eventSnapshot(event: PrototypeEvent): PrototypeEventState {
  return {
    pages: { ...event.pages },
    ...(event.stacks ? { stacks: structuredClone(event.stacks) } : {}),
    state: { ...event.state },
    ...(event.context === undefined ? {} : { context: structuredClone(event.context) }),
    ...(event.contextTruncated === true ? { contextTruncated: true as const } : {}),
    lastKnown: true,
  };
}

function snapshotOverlay(snapshot: PrototypeEventState | undefined): Partial<PrototypeEventState> {
  if (!snapshot) {
    return {};
  }
  return {
    pages: { ...snapshot.pages },
    ...(snapshot.stacks ? { stacks: structuredClone(snapshot.stacks) } : {}),
    state: { ...snapshot.state },
    ...(snapshot.context === undefined ? {} : { context: structuredClone(snapshot.context) }),
    ...(snapshot.contextTruncated === true ? { contextTruncated: true as const } : {}),
    lastKnown: true as const,
  };
}

/** One shown entry, overlaid with its last known snapshot when the device reported one. */
function presenceWithSnapshot(
  entry: PrototypeLastResult,
  snapshot: PrototypeEventState | undefined,
): PrototypeLastResult & Partial<PrototypeEventState> {
  const { stacks, ...presence } = entry;
  return {
    ...presence,
    ...(!snapshot && stacks ? { stacks: structuredClone(stacks) } : {}),
    ...(entry.data === undefined ? {} : { data: structuredClone(entry.data) }),
    ...snapshotOverlay(snapshot),
  };
}

/** Successful shows establish presence; host dismissals and terminal device events remove it. */
export class InMemoryPrototypeStatusStore implements PrototypeStatusStore {
  private readonly scopes = new Map<string, StoredPrototypeStatus>();
  // A marker left by a failed, thrown or superseded show is reset by the next dispatch of that id and dropped with the device.
  private readonly showDispatches = new Map<string, Map<string, boolean>>();

  constructor(
    private readonly clock: Pick<Timer, "now"> = defaultTimer,
    private readonly maxScopes: number = MAX_PROTOTYPE_STATUS_SCOPES,
  ) {}

  status(scope: PrototypeScope): PrototypeStatus {
    const stored = this.scopes.get(JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]));

    return {
      prototypes: Array.from(stored?.shown.values() ?? [], (entry) =>
        presenceWithSnapshot(entry, entry.id ? stored?.snapshots?.get(entry.id) : undefined),
      ),
      ...(stored?.lastResult ? { lastResult: { ...stored.lastResult } } : {}),
    };
  }

  shownOnDevice(deviceId: string, id: string): PrototypeLastResult | undefined {
    for (const stored of this.scopes.values()) {
      const entry = stored.deviceId === deviceId ? stored.shown.get(id) : undefined;
      if (entry) {
        return structuredClone(entry);
      }
    }
    return undefined;
  }

  /** Only events after this show attempt can establish its successful snapshot. */
  startShow(scope: PrototypeScope, id?: string): void {
    const stored = this.scopes.get(JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]));
    if (stored) {
      if (id === undefined) {
        stored.pendingSnapshots?.clear();
      } else {
        stored.pendingSnapshots?.delete(id);
      }
    }
  }

  beginShowDispatch(deviceId: string, id: string): void {
    const dispatches = this.showDispatches.get(deviceId) ?? new Map<string, boolean>();
    dispatches.set(id, false);
    this.showDispatches.set(deviceId, dispatches);
  }

  adopt(scope: PrototypeScope, prototype: AdoptedPrototype): void {
    const key = JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]);
    const stored = this.scopes.get(key) ?? {
      ...scope,
      shown: new Map<string, PrototypeLastResult>(),
    };
    // Adoption transfers this id to the inspecting scope while retaining its siblings.
    this.clearShown(scope.deviceId, prototype.id);
    const entry: PrototypeLastResult = {
      id: prototype.id,
      lastAction: "show",
      adopted: true,
      ...(prototype.persistent === undefined ? {} : { persistent: prototype.persistent }),
      ...(prototype.suspended === true ? { suspended: true as const } : {}),
      ...(prototype.hiddenReason ? { hiddenReason: prototype.hiddenReason } : {}),
      ...(prototype.appearance ? { appearance: { ...prototype.appearance } } : {}),
      ...(prototype.storage ? { storage: structuredClone(prototype.storage) } : {}),
      ...prototypeDegradedEffectsField(prototype.degradedEffects),
      ...(prototype.timers ? { timers: structuredClone(prototype.timers) } : {}),
      success: true,
      timestamp: this.clock.now(),
    };
    stored.lastResult = entry;
    stored.shown.set(prototype.id, {
      ...entry,
      ...shownData("show", { success: true }, prototype.data),
    });
    stored.pendingSnapshots?.delete(prototype.id);
    stored.snapshots ??= new Map();
    stored.snapshots.set(prototype.id, {
      pages: { ...prototype.pages },
      ...(prototype.stacks ? { stacks: structuredClone(prototype.stacks) } : {}),
      state: { ...prototype.state },
      lastKnown: true,
    });
    this.remember(key, stored);
  }

  /** Accepted pushes may precede the successful show acknowledgement. */
  recordEvent(scope: PrototypeScope, event: PrototypeEvent): void {
    this.applyDeviceDataWrite(scope.deviceId, event);
    const dispatches = this.showDispatches.get(scope.deviceId);
    if (
      dispatches?.has(event.id) &&
      event.kind === "appearance_changed" &&
      prototypeAppearanceAfterChange(undefined, event.payload)
    ) {
      dispatches.set(event.id, true);
    }
    const key = JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]);
    const stored = this.scopes.get(key) ?? {
      ...scope,
      shown: new Map<string, PrototypeLastResult>(),
    };
    stored.pendingSnapshots ??= new Map();
    const snapshot = eventSnapshot(event);
    stored.pendingSnapshots.set(event.id, snapshot);
    const shown = stored.shown.get(event.id);
    if (shown) {
      stored.snapshots ??= new Map();
      stored.snapshots.set(event.id, snapshot);
      if (event.kind === "appearance_changed") {
        this.recordAppearanceChange(stored, shown, event);
      }
    }
    this.remember(key, stored);
  }

  /**
   * The shown prototype's resolved mode changed. Only its presence entry is refreshed: `lastResult`
   * stays the record of what the last request reported.
   */
  private recordAppearanceChange(
    stored: StoredPrototypeStatus,
    shown: PrototypeLastResult,
    event: PrototypeEvent,
  ): void {
    const appearance = prototypeAppearanceAfterChange(shown.appearance, event.payload);
    if (appearance) {
      stored.shown.set(event.id, { ...shown, appearance });
    }
  }

  record(
    scope: PrototypeScope,
    action: PrototypeMutation,
    target: { id?: string; all?: true },
    result: PrototypeResult,
    displayId?: number,
    details: PrototypeRecordDetails = {},
  ): PrototypeLastResult {
    const key = JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]);
    const existing = this.scopes.get(key);
    // A dismiss acts on the prototype already shown, wherever it was shown.
    const shownDisplay =
      action !== "show" && target.id !== undefined
        ? existing?.shown.get(target.id)?.displayId
        : undefined;
    const entry = this.createResult(
      action,
      target,
      result,
      displayId ?? shownDisplay,
      details.chrome,
    );
    const presence = this.consumeShowDispatch(scope.deviceId, entry);
    if (!existing && !result.success) {
      return structuredClone(entry);
    }
    const stored = existing ?? {
      ...scope,
      shown: new Map<string, PrototypeLastResult>(),
      lastResult: entry,
    };
    stored.lastResult = entry;
    this.updatePresence(
      stored,
      { ...presence, ...shownData(action, result, details.data) },
      details.replaceOthers,
    );
    this.remember(key, stored);
    return structuredClone(entry);
  }

  readonly shownSpecs = new PrototypeShownSpecs();

  /**
   * A `change` event reporting a device `/data` write (#12519) updates the host's spec copy and
   * the data status reports. A write that cannot be applied exactly removes the reported data
   * rather than leaving content the device no longer shows.
   */
  private applyDeviceDataWrite(deviceId: string, event: PrototypeEvent): void {
    const write = prototypeDataWriteOf(event);
    if (!write) {
      return;
    }
    this.shownSpecs.recordDeviceDataWrite(deviceId, event.id, write);
    for (const stored of this.scopes.values()) {
      const entry = stored.deviceId === deviceId ? stored.shown.get(event.id) : undefined;
      if (!entry) {
        continue;
      }
      const applied =
        write.op === "remove"
          ? applyPrototypeDataWrite(entry.data, { op: "remove", path: write.path })
          : write.value === undefined
            ? undefined
            : applyPrototypeDataWrite(entry.data, prototypeDeviceDataWrite(write, write.value));
      const written = { ...entry };
      if (applied?.success) {
        written.data = applied.data;
      } else {
        delete written.data;
      }
      stored.shown.set(event.id, written);
    }
  }

  recordPatchedData(deviceId: string, id: string, data: PrototypeData | undefined): void {
    for (const stored of this.scopes.values()) {
      const entry = stored.deviceId === deviceId ? stored.shown.get(id) : undefined;
      if (entry) {
        const patched = { ...entry };
        if (data === undefined) {
          delete patched.data;
        } else {
          patched.data = structuredClone(data);
        }
        stored.shown.set(id, patched);
      }
    }
  }

  forgetStorage(deviceId: string, id: string): void {
    for (const stored of this.scopes.values()) {
      if (stored.deviceId !== deviceId) {
        continue;
      }
      const entry = stored.shown.get(id);
      if (entry?.storage) {
        stored.shown.set(id, { ...entry, storage: undefined });
      }
      if (stored.lastResult?.id === id && stored.lastResult.storage) {
        stored.lastResult = { ...stored.lastResult, storage: undefined };
      }
    }
  }

  /** Consume successful shows' windows, while preserving their device answers in lastResult. */
  private consumeShowDispatch(deviceId: string, entry: PrototypeLastResult): PrototypeLastResult {
    if (entry.lastAction !== "show" || !entry.success || !entry.id) {
      return entry;
    }
    const dispatches = this.showDispatches.get(deviceId);
    const crossed = dispatches?.get(entry.id);
    dispatches?.delete(entry.id);
    if (dispatches?.size === 0) {
      this.showDispatches.delete(deviceId);
    }
    if (!crossed) {
      return entry;
    }
    const presence = { ...entry };
    delete presence.appearance;
    return presence;
  }

  /** Re-insert so Map order tracks recency, then evict the oldest scopes past the cap. */
  private remember(key: string, stored: StoredPrototypeStatus): void {
    this.scopes.delete(key);
    this.scopes.set(key, stored);
    for (const oldest of this.scopes.keys()) {
      if (this.scopes.size <= this.maxScopes) {
        break;
      }
      this.scopes.delete(oldest);
    }
  }

  private updatePresence(
    stored: StoredPrototypeStatus,
    entry: PrototypeLastResult,
    replaceOthers?: boolean,
  ): void {
    if (entry.lastAction === "show" && entry.success && entry.id) {
      this.showPresence(stored, entry, replaceOthers);
    } else if (entry.lastAction === "dismiss" && entry.success) {
      this.shownSpecs.forget(stored.deviceId, entry.all ? undefined : entry.id);
      if (entry.all) {
        this.clearShown(stored.deviceId);
      } else if (entry.id) {
        this.clearShown(stored.deviceId, entry.id);
      }
    }
    // Any other outcome (a refused or failed show or dismiss) leaves the prototype still on screen
    // exactly as it was: its adopted/persistent/suspended flags, display and appearance stay, and
    // the failure is reported through the call's result and `lastResult` (#11394).
  }

  private showPresence(
    stored: StoredPrototypeStatus,
    entry: PrototypeLastResult,
    replaceOthers?: boolean,
  ): void {
    if (!entry.id) {
      return;
    }
    // Default replacement clears siblings; an additive show replaces only its own id.
    const snapshot = stored.pendingSnapshots?.get(entry.id);
    this.clearShown(stored.deviceId, replaceOthers === false ? entry.id : undefined);
    stored.snapshots ??= new Map();
    if (snapshot) {
      stored.snapshots.set(entry.id, snapshot);
    }
    stored.shown.set(entry.id, entry);
  }

  clearDevice(deviceId: string): void {
    this.shownSpecs.clearDevice(deviceId);
    this.showDispatches.delete(deviceId);
    for (const [key, stored] of this.scopes) {
      if (stored.deviceId === deviceId) {
        this.scopes.delete(key);
      }
    }
  }

  clearSession(sessionUuid: string): readonly string[] {
    const devices = new Set(
      Array.from(this.scopes.values())
        .filter((stored) => stored.sessionUuid === sessionUuid && stored.lastResult !== undefined)
        .map((stored) => stored.deviceId),
    );
    for (const deviceId of devices) {
      this.clearDevice(deviceId);
    }
    for (const [key, stored] of this.scopes) {
      if (stored.sessionUuid === sessionUuid) {
        this.scopes.delete(key);
      }
    }
    return Array.from(devices);
  }

  dismissed(scope: PrototypeScope, id: string): void {
    this.shownSpecs.forget(scope.deviceId, id);
    this.clearShown(scope.deviceId, id);
  }

  shownIds(deviceId: string): readonly string[] {
    const ids = new Set<string>();
    for (const known of this.scopes.values()) {
      if (known.deviceId === deviceId) {
        for (const id of known.shown.keys()) {
          ids.add(id);
        }
      }
    }
    return Array.from(ids);
  }

  private createResult(
    action: PrototypeMutation,
    target: { id?: string; all?: true },
    result: PrototypeResult,
    displayId?: number,
    chrome?: PrototypeWindowChrome,
  ): PrototypeLastResult {
    return {
      ...target,
      lastAction: action,
      ...(displayId === undefined ? {} : { displayId }),
      ...(action === "show" && result.success && chrome !== undefined ? { chrome } : {}),
      ...shownAppearance(action, result),
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      ...(result.totalTimeMs === undefined ? {} : { totalTimeMs: result.totalTimeMs }),
      timestamp: this.clock.now(),
    };
  }

  private clearShown(deviceId: string, id?: string): void {
    for (const known of this.scopes.values()) {
      if (known.deviceId !== deviceId) {
        continue;
      }
      if (id === undefined) {
        known.pendingSnapshots?.clear();
        known.snapshots?.clear();
      } else {
        known.pendingSnapshots?.delete(id);
        known.snapshots?.delete(id);
      }
      if (id === undefined) {
        known.shown.clear();
      } else {
        known.shown.delete(id);
      }
    }
  }
}
