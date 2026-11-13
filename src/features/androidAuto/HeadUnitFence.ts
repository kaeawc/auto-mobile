import { ActionableError } from "../../models/ActionableError";
import type { HeadUnitPanel } from "./DesktopHeadUnit";

/**
 * The head unit a previous head-unit action left behind, per phone (#17842). An action whose
 * pre-input read no longer matches it is refused before any input is sent, the way a phone tap is
 * refused when its display moved since the last observation.
 */
export interface HeadUnitFenceState {
  panel?: HeadUnitPanel;
  /** `package/carSessionId` of each projected session with template data, sorted. */
  apps?: string[];
}

/** One pre-input read, as the fence compares it. */
export interface HeadUnitFenceRead {
  panel?: HeadUnitPanel;
  /** Absent when the read had no template data (the screenshot fallback, or nothing at all). */
  apps?: string[];
}

function panelChange(last: HeadUnitPanel | undefined, now: HeadUnitPanel | undefined) {
  if (!last || !now) {
    return undefined;
  }
  if (last.configPath !== now.configPath) {
    return `the Desktop Head Unit now runs ${now.configPath ?? "another config"} instead of ${last.configPath ?? "the config of the last action"}, so head-unit pixels may not match`;
  }
  return last.instance === now.instance
    ? undefined
    : "the Desktop Head Unit restarted since the last head-unit action";
}

function appChange(last: string[] | undefined, now: string[] | undefined) {
  if (!last || !now || last.join("\n") === now.join("\n")) {
    return undefined;
  }
  const describe = (apps: string[]) => (apps.length > 0 ? apps.join(", ") : "none");
  return `the projected apps changed since the last head-unit action (was ${describe(last)}, now ${describe(now)})`;
}

export class HeadUnitFence {
  private readonly states = new Map<string, HeadUnitFenceState>();

  /**
   * Throws when the head unit moved since this phone's last head-unit action. The current read is
   * recorded first, so a retry after reviewing the screen goes through.
   */
  assertCurrent(deviceId: string, read: HeadUnitFenceRead): void {
    const last = this.states.get(deviceId);
    this.record(deviceId, read);
    if (!last) {
      return;
    }
    const reason = panelChange(last.panel, read.panel) ?? appChange(last.apps, read.apps);
    if (reason) {
      throw new ActionableError(
        `Head unit input not sent: ${reason}. Observe the head unit again, recompute the input, then retry.`,
      );
    }
  }

  /** Remembers the head unit an action left behind; a read with no template data keeps the apps. */
  record(deviceId: string, read: HeadUnitFenceRead): void {
    const last = this.states.get(deviceId);
    this.states.set(deviceId, {
      ...(read.panel ? { panel: read.panel } : last?.panel ? { panel: last.panel } : {}),
      ...(read.apps ? { apps: read.apps } : last?.apps ? { apps: last.apps } : {}),
    });
  }
}

/** The daemon's fence; every head-unit action for a phone checks and updates the same state. */
export const defaultHeadUnitFence = new HeadUnitFence();
