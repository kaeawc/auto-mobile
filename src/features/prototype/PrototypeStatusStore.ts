import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import type { PrototypeEvent, PrototypeResult } from "../observe/android/ctrlProxyProtocol";

export type PrototypeMutation = "show" | "dismiss";
export interface PrototypeLastResult {
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
  displayId?: number;
  success: boolean;
  error?: string;
  totalTimeMs?: number;
  timestamp: number;
}
export interface PrototypeEventState {
  pages: PrototypeEvent["pages"];
  state: PrototypeEvent["state"];
  lastKnown: true;
}
export interface AdoptedPrototype {
  id: string;
  persistent?: boolean;
  suspended?: boolean;
  pages: PrototypeEvent["pages"];
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
   * The prototype currently shown with this id on the device, from any session. The device holds one
   * active prototype, so whether a same-id show replaces in place is a device-wide fact.
   */
  shownOnDevice(deviceId: string, id: string): PrototypeLastResult | undefined;
  startShow(scope: PrototypeScope): void;
  /**
   * The device reported this prototype as showing (`inspect`). Presence and its last known
   * pages/state come from the device, replacing whatever the host remembered for the device.
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
  ): PrototypeLastResult;
}
interface StoredPrototypeStatus extends PrototypeScope {
  shown: Map<string, PrototypeLastResult>;
  lastResult?: PrototypeLastResult;
  snapshot?: PrototypeEventState & { id: string };
  pendingSnapshot?: PrototypeEventState & { id: string };
}

/**
 * Upper bound on remembered (session, device) scopes. Release and device-removal hooks normally
 * clear scopes; the cap bounds growth if a hook is missed, evicting the least recently recorded.
 */
export const MAX_PROTOTYPE_STATUS_SCOPES = 128;

/** Successful shows establish presence; host dismissals and terminal device events remove it. */
export class InMemoryPrototypeStatusStore implements PrototypeStatusStore {
  private readonly scopes = new Map<string, StoredPrototypeStatus>();

  constructor(
    private readonly clock: Pick<Timer, "now"> = defaultTimer,
    private readonly maxScopes: number = MAX_PROTOTYPE_STATUS_SCOPES,
  ) {}

  status(scope: PrototypeScope): PrototypeStatus {
    const stored = this.scopes.get(JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]));
    const snapshot = stored?.snapshot;
    return {
      prototypes: Array.from(stored?.shown.values() ?? [], (entry) => ({
        ...entry,
        ...(snapshot && snapshot.id === entry.id
          ? {
              pages: { ...snapshot.pages },
              state: { ...snapshot.state },
              lastKnown: true as const,
            }
          : {}),
      })),
      ...(stored?.lastResult ? { lastResult: { ...stored.lastResult } } : {}),
    };
  }

  shownOnDevice(deviceId: string, id: string): PrototypeLastResult | undefined {
    for (const stored of this.scopes.values()) {
      const entry = stored.deviceId === deviceId ? stored.shown.get(id) : undefined;
      if (entry) {
        return { ...entry };
      }
    }
    return undefined;
  }

  /** Only events after this show attempt can establish its successful snapshot. */
  startShow(scope: PrototypeScope): void {
    const stored = this.scopes.get(JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]));
    if (stored) {
      stored.pendingSnapshot = undefined;
    }
  }

  adopt(scope: PrototypeScope, prototype: AdoptedPrototype): void {
    const key = JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]);
    const stored = this.scopes.get(key) ?? {
      ...scope,
      shown: new Map<string, PrototypeLastResult>(),
    };
    // The device holds one prototype; what it reports replaces every session's presence.
    this.clearShown(scope.deviceId);
    const entry: PrototypeLastResult = {
      id: prototype.id,
      lastAction: "show",
      adopted: true,
      ...(prototype.persistent === undefined ? {} : { persistent: prototype.persistent }),
      ...(prototype.suspended === true ? { suspended: true as const } : {}),
      success: true,
      timestamp: this.clock.now(),
    };
    stored.lastResult = entry;
    stored.shown.set(prototype.id, entry);
    stored.pendingSnapshot = undefined;
    stored.snapshot = {
      id: prototype.id,
      pages: { ...prototype.pages },
      state: { ...prototype.state },
      lastKnown: true,
    };
    this.remember(key, stored);
  }

  /** Accepted pushes may precede the successful show acknowledgement. */
  recordEvent(scope: PrototypeScope, event: PrototypeEvent): void {
    const key = JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]);
    const stored = this.scopes.get(key) ?? {
      ...scope,
      shown: new Map<string, PrototypeLastResult>(),
    };
    stored.pendingSnapshot = {
      id: event.id,
      pages: { ...event.pages },
      state: { ...event.state },
      lastKnown: true,
    };
    if (stored.shown.has(event.id)) {
      stored.snapshot = stored.pendingSnapshot;
    }
    this.remember(key, stored);
  }

  record(
    scope: PrototypeScope,
    action: PrototypeMutation,
    target: { id?: string; all?: true },
    result: PrototypeResult,
    displayId?: number,
  ): PrototypeLastResult {
    const key = JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]);
    const existing = this.scopes.get(key);
    // A dismiss acts on the prototype already shown, wherever it was shown.
    const shownDisplay =
      action !== "show" && target.id !== undefined
        ? existing?.shown.get(target.id)?.displayId
        : undefined;
    const entry = this.createResult(action, target, result, displayId ?? shownDisplay);
    if (!existing && !result.success) {
      return { ...entry };
    }
    const stored = existing ?? {
      ...scope,
      shown: new Map<string, PrototypeLastResult>(),
      lastResult: entry,
    };
    stored.lastResult = entry;
    this.updatePresence(stored, entry);
    this.remember(key, stored);
    return { ...entry };
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

  private updatePresence(stored: StoredPrototypeStatus, entry: PrototypeLastResult): void {
    if (entry.lastAction === "show" && entry.success && entry.id) {
      // The device has one active prototype; replacement invalidates every session's presence.
      const snapshot = stored.pendingSnapshot;
      this.clearShown(stored.deviceId);
      stored.snapshot = snapshot?.id === entry.id ? snapshot : undefined;
      stored.shown.set(entry.id, entry);
    } else if (entry.lastAction === "dismiss" && entry.success) {
      if (entry.all) {
        this.clearShown(stored.deviceId);
      } else if (entry.id) {
        this.clearShown(stored.deviceId, entry.id);
      }
    } else if (entry.id && stored.shown.has(entry.id)) {
      stored.shown.set(entry.id, entry);
    }
  }

  clearDevice(deviceId: string): void {
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
  ): PrototypeLastResult {
    return {
      ...target,
      lastAction: action,
      ...(displayId === undefined ? {} : { displayId }),
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
      if (id === undefined || known.pendingSnapshot?.id === id) {
        known.pendingSnapshot = undefined;
      }
      if (id === undefined || known.snapshot?.id === id) {
        known.snapshot = undefined;
      }
      if (id === undefined) {
        known.shown.clear();
      } else {
        known.shown.delete(id);
      }
    }
  }
}
