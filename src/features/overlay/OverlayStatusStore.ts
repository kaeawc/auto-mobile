import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import type { OverlayEvent, OverlayResult } from "../observe/android/ctrlProxyProtocol";

export type OverlayMutation = "show" | "dismiss";
export interface OverlayLastResult {
  id?: string;
  all?: true;
  lastAction: OverlayMutation;
  /**
   * Android logical display the overlay is on: the one requested for a fresh show; a same-id show
   * without reset and a dismiss echo the shown overlay's.
   */
  displayId?: number;
  success: boolean;
  error?: string;
  totalTimeMs?: number;
  timestamp: number;
}
export interface OverlayEventState {
  pages: OverlayEvent["pages"];
  state: OverlayEvent["state"];
  lastKnown: true;
}
export interface OverlayStatus {
  overlays: (OverlayLastResult & Partial<OverlayEventState>)[];
  lastResult?: OverlayLastResult;
}
export interface OverlayScope {
  sessionUuid?: string;
  deviceId: string;
}
export interface OverlayStatusStore {
  status(scope: OverlayScope): OverlayStatus;
  startShow(scope: OverlayScope): void;
  recordEvent(scope: OverlayScope, event: OverlayEvent): void;
  /** The device reported a terminal dismissal for this overlay; its presence is gone. */
  dismissed(scope: OverlayScope, id: string): void;
  clearDevice(deviceId: string): void;
  /** Forgets every scope on each device the session touched; returns those device ids. */
  clearSession(sessionUuid: string): readonly string[];
  record(
    scope: OverlayScope,
    action: OverlayMutation,
    target: { id?: string; all?: true },
    result: OverlayResult,
    displayId?: number,
  ): OverlayLastResult;
}
interface StoredOverlayStatus extends OverlayScope {
  shown: Map<string, OverlayLastResult>;
  lastResult?: OverlayLastResult;
  snapshot?: OverlayEventState & { id: string };
  pendingSnapshot?: OverlayEventState & { id: string };
}

/**
 * Upper bound on remembered (session, device) scopes. Release and device-removal hooks normally
 * clear scopes; the cap bounds growth if a hook is missed, evicting the least recently recorded.
 */
export const MAX_OVERLAY_STATUS_SCOPES = 128;

/** Successful shows establish presence; host dismissals and terminal device events remove it. */
export class InMemoryOverlayStatusStore implements OverlayStatusStore {
  private readonly scopes = new Map<string, StoredOverlayStatus>();

  constructor(
    private readonly clock: Pick<Timer, "now"> = defaultTimer,
    private readonly maxScopes: number = MAX_OVERLAY_STATUS_SCOPES,
  ) {}

  status(scope: OverlayScope): OverlayStatus {
    const stored = this.scopes.get(JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]));
    const snapshot = stored?.snapshot;
    return {
      overlays: Array.from(stored?.shown.values() ?? [], (entry) => ({
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

  /** Only events after this show attempt can establish its successful snapshot. */
  startShow(scope: OverlayScope): void {
    const stored = this.scopes.get(JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]));
    if (stored) {
      stored.pendingSnapshot = undefined;
    }
  }

  /** Accepted pushes may precede the successful show acknowledgement. */
  recordEvent(scope: OverlayScope, event: OverlayEvent): void {
    const key = JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]);
    const stored = this.scopes.get(key) ?? {
      ...scope,
      shown: new Map<string, OverlayLastResult>(),
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
    scope: OverlayScope,
    action: OverlayMutation,
    target: { id?: string; all?: true },
    result: OverlayResult,
    displayId?: number,
  ): OverlayLastResult {
    const key = JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]);
    const existing = this.scopes.get(key);
    // A dismiss acts on the overlay already shown, wherever it was shown.
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
      shown: new Map<string, OverlayLastResult>(),
      lastResult: entry,
    };
    stored.lastResult = entry;
    this.updatePresence(stored, entry);
    this.remember(key, stored);
    return { ...entry };
  }

  /** Re-insert so Map order tracks recency, then evict the oldest scopes past the cap. */
  private remember(key: string, stored: StoredOverlayStatus): void {
    this.scopes.delete(key);
    this.scopes.set(key, stored);
    for (const oldest of this.scopes.keys()) {
      if (this.scopes.size <= this.maxScopes) {
        break;
      }
      this.scopes.delete(oldest);
    }
  }

  private updatePresence(stored: StoredOverlayStatus, entry: OverlayLastResult): void {
    if (entry.lastAction === "show" && entry.success && entry.id) {
      // The device has one active overlay; replacement invalidates every session's presence.
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

  dismissed(scope: OverlayScope, id: string): void {
    this.clearShown(scope.deviceId, id);
  }

  private createResult(
    action: OverlayMutation,
    target: { id?: string; all?: true },
    result: OverlayResult,
    displayId?: number,
  ): OverlayLastResult {
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
