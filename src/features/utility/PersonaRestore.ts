import type { OemPersonaId } from "./OemPersonas";

interface PersonaRestoreEntry {
  /** The persona applied last; reported by reset. */
  personaId: OemPersonaId;
  /** The keyboard profile active before the first persona changed it; undefined once restored. */
  keyboardProfileBefore?: string;
  /** Packages whose kill facet a persona applied, so reset restores each. */
  killAppIds: Set<string>;
}

export interface PersonaRestoreSnapshot {
  personaId: OemPersonaId;
  keyboardProfileBefore?: string;
  killAppIds: string[];
}

/**
 * Per-device record of what `persona` changed outside the kill and display
 * registries (#14055): the keyboard profile before the first change (write-once,
 * so applying a second persona never records the first one's keyboard) and the
 * packages a kill facet was applied to. The kill and display facets keep their
 * own write-once records, which their session cleanups restore on release. In
 * memory only: a daemon restart loses it.
 */
export class PersonaRestoreRegistry {
  private readonly entries = new Map<string, PersonaRestoreEntry>();

  recordApply(
    deviceId: string,
    personaId: OemPersonaId,
    change: { keyboardProfileBefore?: string; killAppId?: string },
  ): void {
    const entry: PersonaRestoreEntry = this.entries.get(deviceId) ?? {
      personaId,
      killAppIds: new Set(),
    };
    entry.personaId = personaId;
    if (!("keyboardProfileBefore" in entry) && change.keyboardProfileBefore !== undefined) {
      entry.keyboardProfileBefore = change.keyboardProfileBefore;
    }
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
          ...(entry.keyboardProfileBefore !== undefined
            ? { keyboardProfileBefore: entry.keyboardProfileBefore }
            : {}),
          killAppIds: [...entry.killAppIds],
        }
      : undefined;
  }

  /** The keyboard profile was put back. */
  forgetKeyboard(deviceId: string): void {
    const entry = this.entries.get(deviceId);
    if (entry) {
      delete entry.keyboardProfileBefore;
    }
  }

  /** The kill facet of `appId` was restored. */
  forgetKill(deviceId: string, appId: string): void {
    this.entries.get(deviceId)?.killAppIds.delete(appId);
  }

  /** Drop the entry once nothing it recorded is waiting to be restored. */
  clearIfRestored(deviceId: string): void {
    const entry = this.entries.get(deviceId);
    if (entry && entry.keyboardProfileBefore === undefined && entry.killAppIds.size === 0) {
      this.entries.delete(deviceId);
    }
  }

  /** The device is gone (or its serial now names another device): nothing left to restore. */
  retireDevice(deviceId: string): void {
    this.entries.delete(deviceId);
  }
}

export const defaultPersonaRestoreRegistry = new PersonaRestoreRegistry();
