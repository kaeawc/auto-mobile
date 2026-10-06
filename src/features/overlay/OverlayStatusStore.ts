import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import type { OverlayResult } from "../observe/android/ctrlProxyProtocol";

export type OverlayMutation = "show" | "update" | "dismiss";
export interface OverlayLastResult {
  id?: string;
  all?: true;
  lastAction: OverlayMutation;
  /** Android logical display requested for a show; update/dismiss echo the shown overlay's. */
  displayId?: number;
  success: boolean;
  error?: string;
  totalTimeMs?: number;
  timestamp: number;
}
export interface OverlayStatus {
  overlays: OverlayLastResult[];
  lastResult?: OverlayLastResult;
}
export interface OverlayScope {
  sessionUuid?: string;
  deviceId: string;
}
export interface OverlayStatusStore {
  status(scope: OverlayScope): OverlayStatus;
  clearDevice(deviceId: string): void;
  clearSession(sessionUuid: string): void;
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
  lastResult: OverlayLastResult;
}

/** Host knowledge only: successful shows establish presence; successful dismissals remove it. */
export class InMemoryOverlayStatusStore implements OverlayStatusStore {
  private readonly scopes = new Map<string, StoredOverlayStatus>();

  constructor(private readonly clock: Pick<Timer, "now"> = defaultTimer) {}

  status(scope: OverlayScope): OverlayStatus {
    const stored = this.scopes.get(JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]));
    return {
      overlays: Array.from(stored?.shown.values() ?? [], (entry) => ({ ...entry })),
      ...(stored ? { lastResult: { ...stored.lastResult } } : {}),
    };
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
    // An update or dismiss acts on the overlay already shown, wherever it was shown.
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
    this.scopes.set(key, stored);
    return { ...entry };
  }

  private updatePresence(stored: StoredOverlayStatus, entry: OverlayLastResult): void {
    if (entry.lastAction === "show" && entry.success && entry.id) {
      // The device has one active overlay; replacement invalidates every session's presence.
      this.clearShown(stored.deviceId);
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

  clearSession(sessionUuid: string): void {
    const devices = new Set(
      Array.from(this.scopes.values())
        .filter((stored) => stored.sessionUuid === sessionUuid)
        .map((stored) => stored.deviceId),
    );
    for (const deviceId of devices) {
      this.clearDevice(deviceId);
    }
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
      if (id === undefined) {
        known.shown.clear();
      } else {
        known.shown.delete(id);
      }
    }
  }
}
