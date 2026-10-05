import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import type { OverlayResult } from "../observe/android/ctrlProxyProtocol";

export type OverlayMutation = "show" | "update" | "dismiss";
export interface OverlayLastResult {
  id?: string;
  all?: true;
  lastAction: OverlayMutation;
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
  record(
    scope: OverlayScope,
    action: OverlayMutation,
    target: { id?: string; all?: true },
    result: OverlayResult,
  ): OverlayLastResult;
}

/** Host knowledge only: successful shows establish presence; successful dismissals remove it. */
export class InMemoryOverlayStatusStore implements OverlayStatusStore {
  private readonly scopes = new Map<
    string,
    { deviceId: string; shown: Map<string, OverlayLastResult>; lastResult: OverlayLastResult }
  >();

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
  ): OverlayLastResult {
    const entry = this.createResult(action, target, result);
    const stored = this.scopes.get(JSON.stringify([scope.sessionUuid ?? null, scope.deviceId])) ?? {
      deviceId: scope.deviceId,
      shown: new Map<string, OverlayLastResult>(),
      lastResult: entry,
    };
    stored.lastResult = entry;
    if (action === "dismiss" && result.success) {
      if (target.all) {
        this.clearDevice(scope.deviceId);
      } else if (target.id) {
        this.clearDevice(scope.deviceId, target.id);
      }
    } else if (
      target.id &&
      ((action === "show" && result.success) || stored.shown.has(target.id))
    ) {
      stored.shown.set(target.id, entry);
    }
    this.scopes.set(JSON.stringify([scope.sessionUuid ?? null, scope.deviceId]), stored);
    return { ...entry };
  }

  private createResult(
    action: OverlayMutation,
    target: { id?: string; all?: true },
    result: OverlayResult,
  ): OverlayLastResult {
    return {
      ...target,
      lastAction: action,
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      ...(result.totalTimeMs === undefined ? {} : { totalTimeMs: result.totalTimeMs }),
      timestamp: this.clock.now(),
    };
  }

  private clearDevice(deviceId: string, id?: string): void {
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
