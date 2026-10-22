import { ActionableError, type BootedDevice } from "../../models";
import type { DeviceSettingKey } from "../../models/DeviceSettingDefaults";
import type { DeviceProfileSelector } from "../../models/ManufacturerProfileIds";
import { KEYBOARD_PROFILE_IDS, type KeyboardProfileId } from "../action/keyboardProfiles";
import { applyKillProfile, resetKillProfile } from "./ApplyKillProfile";
import {
  applyPersona,
  type ApplyPersonaResult,
  type PersonaFacetExecutors,
  type RoutePersonaResult,
} from "./ApplyPersona";
import { recordDeviceSettingDefaultsBeforeChange } from "./DeviceSettingDefaults";
import {
  defaultKeyboardProfileRestoreRegistry,
  resetKeyboardProfileFromRecord,
  setKeyboardProfileRecorded,
} from "./KeyboardProfileRestore";
import {
  applyDisplayProfile,
  resetDisplayProfile,
  type DisplayProfileInput,
} from "./DisplayProfile";
import { defaultDisplayProfilePortsFactory } from "./DisplayProfilePorts";
import { defaultDisplayProfileRestoreRegistry } from "./DisplayProfileRestore";
import {
  defaultKillProfileRestoreRegistry,
  defaultKillProfileShellFactory,
} from "./KillProfileRestore";

/** Records fontScale/density/nightMode defaults for the next-owner reset (#11145). */
export type RecordSettingDefaults = (
  device: BootedDevice,
  keys: readonly DeviceSettingKey[],
) => Promise<void>;

/** The device settings a display profile changes, for the next-owner defaults record. */
export function changedSettings(input: DisplayProfileInput): DeviceSettingKey[] {
  return [
    ...(input.fontScale !== undefined ? (["fontScale"] as const) : []),
    ...(input.density !== undefined ? (["density"] as const) : []),
    ...(input.forceDark === true ? (["nightMode"] as const) : []),
  ];
}

function isKeyboardProfileId(value: string): value is KeyboardProfileId {
  return (KEYBOARD_PROFILE_IDS as readonly string[]).includes(value);
}

/** The production executors: `keyboard setProfile`, `killProfile` and `displayProfile`. */
export const defaultPersonaExecutors = (
  device: BootedDevice,
  signal: AbortSignal | undefined,
  recordSettingDefaults: RecordSettingDefaults = recordDeviceSettingDefaultsBeforeChange,
): PersonaFacetExecutors => {
  const killDeps = (owner?: string) => ({
    shell: defaultKillProfileShellFactory(device),
    registry: defaultKillProfileRestoreRegistry,
    owner,
    signal,
  });
  const displayDeps = (owner?: string) => ({
    ...defaultDisplayProfilePortsFactory(device),
    registry: defaultDisplayProfileRestoreRegistry,
    owner,
    signal,
  });
  return {
    keyboard: {
      set: (profile, owner, setSignal) => {
        if (!isKeyboardProfileId(profile)) {
          throw new ActionableError(`Unknown keyboard profile '${profile}'.`);
        }
        return setKeyboardProfileRecorded(device, profile, undefined, setSignal, { owner });
      },
      pending: () => defaultKeyboardProfileRestoreRegistry.pending(device.deviceId),
      reset: (resetSignal) => resetKeyboardProfileFromRecord(device, undefined, resetSignal),
    },
    kill: {
      apply: (appId, profile, owner) => applyKillProfile(device, appId, profile, killDeps(owner)),
      reset: (appId, owner) => resetKillProfile(device, appId, {}, killDeps(owner)),
      hasPending: (appId) =>
        defaultKillProfileRestoreRegistry
          .pendingFor(device.deviceId, appId)
          .some((action) => action.appId === appId),
    },
    display: {
      apply: async (input, owner) => {
        await recordSettingDefaults(device, changedSettings(input));
        return applyDisplayProfile(device, input, displayDeps(owner));
      },
      reset: (owner) => resetDisplayProfile(device, displayDeps(owner)),
    },
  };
};

/** Applies an OEM manufacturer profile to an acquired device for its owning session (#14058). */
export interface ManufacturerProfileApplier {
  apply(
    device: BootedDevice,
    profile: DeviceProfileSelector,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ApplyPersonaResult | RoutePersonaResult>;
}

/**
 * The production applier for acquisition: the kill facet is deferred (no app is known yet) and
 * the owning session's release restores everything, keyboard included (through the shared
 * keyboard-profile record, #14705).
 */
export const defaultManufacturerProfileApplier: ManufacturerProfileApplier = {
  apply: (device, profile, sessionId, signal) =>
    applyPersona(
      device,
      profile.manufacturerProfile,
      { requires: profile.requires, deferKill: true },
      {
        executors: defaultPersonaExecutors(device, signal),
        owner: sessionId,
        signal,
      },
    ),
};
