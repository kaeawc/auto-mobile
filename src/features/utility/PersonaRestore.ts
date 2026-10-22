import type { BootedDevice } from "../../models";
import type { OemPersonaId } from "./OemPersonas";

interface PersonaRestoreEntry {
  /** The persona applied last; reported by reset. */
  personaId: OemPersonaId;
  /** The keyboard profile active before the first persona changed it; undefined once restored. */
  keyboardProfileBefore?: string;
  /** Packages whose kill facet a persona applied, so reset restores each. */
  killAppIds: Set<string>;
  /** The session whose release restores the keyboard (#14058), and the device it runs on. */
  releaseOwner?: { sessionId: string; device: BootedDevice };
}

/** A released session's keyboard restore: the profile to put back on `device`. */
export interface OwnedKeyboardRestore {
  device: BootedDevice;
  keyboardProfileBefore: string;
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
    change: {
      keyboardProfileBefore?: string;
      killAppId?: string;
      releaseOwner?: { sessionId: string; device: BootedDevice };
    },
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
    if (change.releaseOwner !== undefined) {
      entry.releaseOwner = change.releaseOwner;
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

  /**
   * The keyboard restore `sessionId`'s release owes on `deviceId`, taken so it runs once.
   * Undefined when another session (or none) owns it or nothing is left to restore.
   */
  takeKeyboardOwnedBy(deviceId: string, sessionId: string): OwnedKeyboardRestore | undefined {
    const entry = this.entries.get(deviceId);
    if (entry?.releaseOwner?.sessionId !== sessionId) {
      return undefined;
    }
    const { device } = entry.releaseOwner;
    delete entry.releaseOwner;
    const keyboardProfileBefore = entry.keyboardProfileBefore;
    if (keyboardProfileBefore === undefined) {
      return undefined;
    }
    delete entry.keyboardProfileBefore;
    this.clearIfRestored(deviceId);
    return { device, keyboardProfileBefore };
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
