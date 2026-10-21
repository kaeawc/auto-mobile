import type { OemPersonaId } from "./OemPersonas";

interface PersonaRestoreEntry {
  /** The persona applied last; reported by reset. */
  personaId: OemPersonaId;
  /** Whether a persona changed the keyboard profile and reset has not restored it yet. */
  keyboard: boolean;
  /** Packages whose kill facet a persona applied, so reset restores each. */
  killAppIds: Set<string>;
}

export interface PersonaRestoreSnapshot {
  personaId: OemPersonaId;
  keyboard: boolean;
  killAppIds: string[];
}

/**
 * Per-device record of which persona was applied last (#14055), whether it
 * changed the keyboard profile, and the packages a kill facet was applied to.
 * The keyboard, kill and display facets keep their own write-once records of
 * the state before the first change, which their session cleanups restore on
 * release (#14705) and reset restores otherwise. In memory only: a daemon
 * restart loses it.
 */
export class PersonaRestoreRegistry {
  private readonly entries = new Map<string, PersonaRestoreEntry>();

  recordApply(
    deviceId: string,
    personaId: OemPersonaId,
    change: { keyboard?: boolean; killAppId?: string },
  ): void {
    const entry: PersonaRestoreEntry = this.entries.get(deviceId) ?? {
      personaId,
      keyboard: false,
      killAppIds: new Set(),
    };
    entry.personaId = personaId;
    entry.keyboard ||= change.keyboard === true;
    if (change.killAppId !== undefined) {
      entry.killAppIds.add(change.killAppId);
    }
    this.entries.set(deviceId, entry);
  }

  get(deviceId: string): PersonaRestoreSnapshot | undefined {
    const entry = this.entries.get(deviceId);
    return entry
      ? {
          personaId: entry.personaId,
          keyboard: entry.keyboard,
          killAppIds: [...entry.killAppIds],
        }
      : undefined;
  }

  /** The keyboard profile was put back, by reset or by the owning session's release. */
  forgetKeyboard(deviceId: string): void {
    const entry = this.entries.get(deviceId);
    if (entry) {
      entry.keyboard = false;
    }
  }

  /** The kill facet of `appId` was restored. */
  forgetKill(deviceId: string, appId: string): void {
    this.entries.get(deviceId)?.killAppIds.delete(appId);
  }

  /** Drop the entry once nothing it recorded is waiting to be restored. */
  clearIfRestored(deviceId: string): void {
    const entry = this.entries.get(deviceId);
    if (entry && !entry.keyboard && entry.killAppIds.size === 0) {
      this.entries.delete(deviceId);
    }
  }

  /** The device is gone (or its serial now names another device): nothing left to restore. */
  retireDevice(deviceId: string): void {
    this.entries.delete(deviceId);
  }
}

export const defaultPersonaRestoreRegistry = new PersonaRestoreRegistry();
