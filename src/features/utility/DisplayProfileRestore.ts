import type { BootedDevice } from "../../models";
import type { RequestedPosture } from "../device/postureCommands";
import type { SetDisplayConfigInput } from "./DisplayConfig";

/** A display-profile facet: what one apply step changes and reset restores. */
export type DisplayProfileFacet =
  | "screenSize"
  | "display"
  | "cutout"
  | "navigationMode"
  | "forceDark"
  | "posture";

/** How to put one facet back the way it was before the first display-profile change. */
export type DisplayProfileRestoreAction =
  | { facet: "display"; values: SetDisplayConfigInput }
  | {
      facet: "screenSize" | "cutout" | "navigationMode" | "forceDark";
      commands: string[];
      /** Logical display ids whose state `commands` restore; absent means the default display. */
      scopes?: string[];
    }
  | { facet: "posture"; posture: RequestedPosture };

interface DisplayProfileRestoreEntry {
  device: BootedDevice;
  /** The session whose release restores the entry; undefined while only sessionless calls wrote. */
  owner?: string;
  actions: Map<DisplayProfileFacet, DisplayProfileRestoreAction>;
}

export interface OwnedDisplayProfileRestore {
  device: BootedDevice;
  /** In the order reset runs them: the reverse of the order apply first changed them. */
  actions: DisplayProfileRestoreAction[];
}

type CommandRestoreAction = Extract<DisplayProfileRestoreAction, { commands: string[] }>;

const DEFAULT_DISPLAY_SCOPE = "0";

/**
 * A command facet is write-once per display: a second display (#14101) adds its own restore
 * commands to the same facet, while a display already recorded keeps its first original.
 */
function mergeScopedCommands(existing: CommandRestoreAction, added: CommandRestoreAction): boolean {
  const recorded = existing.scopes ?? [DEFAULT_DISPLAY_SCOPE];
  const fresh = (added.scopes ?? [DEFAULT_DISPLAY_SCOPE]).filter(
    (scope) => !recorded.includes(scope),
  );
  if (fresh.length === 0) {
    return false;
  }
  existing.commands = [...existing.commands, ...added.commands];
  existing.scopes = [...recorded, ...fresh];
  return true;
}

/**
 * Per-device, write-once record of each facet's state before a display
 * profile first changed it (#14052), so applying a second profile never
 * overwrites the original with the state the first one applied. In memory
 * only: a daemon restart loses it.
 *
 * A session that applies a profile takes ownership of the device's entry, so
 * its release restores every facet recorded there, including any a sessionless
 * call changed first. An entry only sessionless calls wrote stays until reset.
 */
export class DisplayProfileRestoreRegistry {
  private readonly entries = new Map<string, DisplayProfileRestoreEntry>();

  has(deviceId: string, facet: DisplayProfileFacet): boolean {
    return this.entries.get(deviceId)?.actions.has(facet) ?? false;
  }

  /**
   * Record `action` unless its facet is already recorded; the display facet
   * merges fields a later profile changes for the first time. Returns true when
   * this call recorded something.
   */
  record(
    device: BootedDevice,
    action: DisplayProfileRestoreAction,
    owner: string | undefined,
  ): boolean {
    const entry: DisplayProfileRestoreEntry = this.entries.get(device.deviceId) ?? {
      device,
      actions: new Map(),
    };
    this.entries.set(device.deviceId, entry);
    entry.device = device;
    if (owner !== undefined) {
      entry.owner = owner;
    }
    const existing = entry.actions.get(action.facet);
    if (existing?.facet === "display" && action.facet === "display") {
      const added = Object.keys(action.values).some((key) => !(key in existing.values));
      existing.values = { ...action.values, ...existing.values };
      return added;
    }
    if (existing && "commands" in existing && "commands" in action) {
      return mergeScopedCommands(existing, action);
    }
    if (existing) {
      return false;
    }
    entry.actions.set(action.facet, action);
    return true;
  }

  /** Drop one facet: it was restored, or the write that recorded it was refused. */
  forget(deviceId: string, facet: DisplayProfileFacet): void {
    const entry = this.entries.get(deviceId);
    entry?.actions.delete(facet);
    if (entry && entry.actions.size === 0) {
      this.entries.delete(deviceId);
    }
  }

  /**
   * Drop the given displays from a command facet, keeping the commands and scopes of the rest
   * (`commands[i]` restores `scopes[i]`); the facet goes when nothing remains.
   */
  forgetScopes(deviceId: string, facet: DisplayProfileFacet, scopes: readonly string[]): void {
    const action = this.entries.get(deviceId)?.actions.get(facet);
    if (!action || !("commands" in action)) {
      return;
    }
    const recorded = action.scopes ?? [DEFAULT_DISPLAY_SCOPE];
    const keep = recorded.flatMap((scope, index) => (scopes.includes(scope) ? [] : [index]));
    if (keep.length === 0) {
      this.forget(deviceId, facet);
      return;
    }
    action.commands = keep.map((index) => action.commands[index]);
    action.scopes = keep.map((index) => recorded[index]);
  }

  /** What reset restores, latest-changed facet first. */
  pending(deviceId: string): DisplayProfileRestoreAction[] {
    return [...(this.entries.get(deviceId)?.actions.values() ?? [])].reverse();
  }

  /** Whether a session release will restore this device's recorded facets. */
  restoresOnRelease(deviceId: string): boolean {
    return this.entries.get(deviceId)?.owner !== undefined;
  }

  /** Remove and return the entry `sessionId` owns on `deviceId`, for its release to restore. */
  takeOwnedBy(deviceId: string, sessionId: string): OwnedDisplayProfileRestore | undefined {
    const entry = this.entries.get(deviceId);
    if (entry?.owner !== sessionId) {
      return undefined;
    }
    this.entries.delete(deviceId);
    return { device: entry.device, actions: [...entry.actions.values()].reverse() };
  }

  /** The device is gone (or its serial now names another device): nothing left to restore. */
  retireDevice(deviceId: string): void {
    this.entries.delete(deviceId);
  }
}

export const defaultDisplayProfileRestoreRegistry = new DisplayProfileRestoreRegistry();
