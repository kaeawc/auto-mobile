import type { OemPersonaId } from "./OemPersonas";

interface PersonaRestoreEntry {
  /** The persona applied last; reported by reset. */
  personaId: OemPersonaId;
  /** Packages whose kill facet a persona applied, so reset restores each. */
  killAppIds: Set<string>;
}

export interface PersonaRestoreSnapshot {
  personaId: OemPersonaId;
  killAppIds: string[];
}

/**
 * Per-device record of what `persona` applied (#14055): the persona applied
 * last and the packages a kill facet was applied to. The kill, display and
 * keyboard facets keep their own write-once records (the keyboard one shared
 * with `keyboard setProfile`, #14705), which their session cleanups restore on
 * release. In memory only: a daemon restart loses it.
 */
export class PersonaRestoreRegistry {
  private readonly entries = new Map<string, PersonaRestoreEntry>();

  recordApply(deviceId: string, personaId: OemPersonaId, change: { killAppId?: string }): void {
    const entry: PersonaRestoreEntry = this.entries.get(deviceId) ?? {
      personaId,
      killAppIds: new Set(),
    };
    entry.personaId = personaId;
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
          killAppIds: [...entry.killAppIds],
        }
      : undefined;
  }

  /** The kill facet of `appId` was restored. */
  forgetKill(deviceId: string, appId: string): void {
    this.entries.get(deviceId)?.killAppIds.delete(appId);
  }

  /** Drop the entry once nothing it recorded is waiting to be restored. */
  clearIfRestored(deviceId: string): void {
    const entry = this.entries.get(deviceId);
    if (entry && entry.killAppIds.size === 0) {
      this.entries.delete(deviceId);
    }
  }

  /** The device is gone (or its serial now names another device): nothing left to restore. */
  retireDevice(deviceId: string): void {
    this.entries.delete(deviceId);
  }
}

export const defaultPersonaRestoreRegistry = new PersonaRestoreRegistry();
