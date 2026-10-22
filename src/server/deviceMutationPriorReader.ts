import type { BootedDevice } from "../models";
import { DEVICE_SETTING_KEYS, type DeviceSettingValues } from "../models/DeviceSettingDefaults";
import type { MutationValue } from "../daemon/sessionBroker/mutations/types";
import { Clipboard } from "../features/action/Clipboard";
import { DefaultDeviceSettingsAccess } from "../features/utility/DefaultDeviceSettingsAccess";
import type { DeviceSettingsAccess } from "../features/utility/DeviceSettingDefaults";
import type { ToolMutation } from "./deviceMutationAdapters";
import { DeviceState } from "../features/utility/DeviceState";
import type {
  DeviceStateField,
  DeviceStateResult,
  DeviceClockState,
  NetworkConditionState,
} from "../features/utility/DeviceState";
import type { ScreenLockState } from "../features/utility/screenLock/ScreenLockTypes";
import type { BiometricEnrollmentState } from "../features/utility/device-state/BiometricState";
import { observableMutationValue as present } from "../daemon/sessionBroker/mutations/types";
import { Rotate } from "../features/action/Rotate";
import { TalkBackToggle } from "../features/accessibility/TalkBackToggle";
import { VoiceOverToggle } from "../features/accessibility/VoiceOverToggle";
import { awaitWhileRequestIsLive } from "../utils/toolUtils";
import { type AndroidCtrlProxy } from "../features/observe/android/AndroidCtrlProxyClient";
import { DataMutationPriorReader } from "./deviceMutationDataPriorReader";

function stateField(entry: ToolMutation): DeviceStateField | undefined {
  const settingFields: Readonly<Record<string, DeviceStateField>> = {
    doNotDisturb: "doNotDisturb",
    screenLock: "screenLock",
    airplaneMode: "connectivity",
    wifiEnabled: "connectivity",
    bluetoothEnabled: "connectivity",
    locationEnabled: "connectivity",
  };
  const kindFields: Readonly<Record<string, DeviceStateField>> = {
    clock: "clock",
    "network-condition": "networkCondition",
  };
  if (entry.key.startsWith("sdk:")) {
    return undefined;
  }
  return entry.kind === "device-setting" ? settingFields[entry.key] : kindFields[entry.kind];
}

function statePrior(entry: ToolMutation, state: DeviceStateResult | undefined): MutationValue {
  const field = stateField(entry);
  if (!field || !state) {
    return { state: "unobservable" };
  }
  const observed = state[field];
  if (!observed?.supported || observed.error) {
    return { state: "unobservable" };
  }
  const readers: Partial<Record<DeviceStateField, () => MutationValue>> = {
    doNotDisturb: () => present(state.doNotDisturb?.mode),
    connectivity: () => present(state.connectivity && Reflect.get(state.connectivity, entry.key)),
    clock: () => clockPrior(state.clock),
    screenLock: () => screenLockPrior(state.screenLock),
    networkCondition: () => networkPrior(entry.key, state.networkCondition),
  };
  return readers[field]?.() ?? { state: "unobservable" };
}

function clockPrior(clock: DeviceClockState | undefined): MutationValue {
  return clock?.instant && clock.automaticTime !== undefined
    ? present({ instant: clock.instant, automaticTime: clock.automaticTime })
    : { state: "unobservable" };
}

function screenLockPrior(lock: ScreenLockState | undefined): MutationValue {
  return lock?.secure === false && lock.type === "none"
    ? present({ type: "none", secure: false })
    : { state: "unobservable" };
}

function networkPrior(key: string, network: NetworkConditionState | undefined): MutationValue {
  if (!network) {
    return { state: "unobservable" };
  }
  if (key === "device") {
    return present(network.values ?? network.observedValues ?? network.profile);
  }
  const identity: unknown = JSON.parse(key);
  const appId = Array.isArray(identity) ? identity[1] : undefined;
  const rule = network.rules?.find((rule) => rule.appId === appId);
  return rule ? present(rule) : network.rules ? { state: "absent" } : { state: "unobservable" };
}

function biometricPrior(biometrics: BiometricEnrollmentState | undefined): MutationValue {
  return biometrics?.supported && biometrics.verified && biometrics.enrollment && !biometrics.error
    ? { state: "present", value: biometrics.enrollment }
    : { state: "unobservable" };
}

export interface MutationPriorReader {
  read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]>;
}

export interface MutationObservationReaders {
  screenReaderFor(device: BootedDevice): { getEnabled(): Promise<boolean | null> };
  keyboardProfilesFor?: (device: BootedDevice) => Pick<AndroidCtrlProxy, "listKeyboardProfiles">;
  dataReader?: MutationPriorReader;
}

export class DefaultMutationPriorReader implements MutationPriorReader {
  private readonly observationReaders: MutationObservationReaders;
  private readonly dataReader: MutationPriorReader;

  constructor(
    private readonly settingsAccess: Pick<
      DeviceSettingsAccess,
      "read"
    > = new DefaultDeviceSettingsAccess(),
    private readonly clipboardFor: (device: BootedDevice) => Pick<Clipboard, "execute"> = (
      device,
    ) => new Clipboard(device),
    private readonly biometricsFor: (
      device: BootedDevice,
    ) => Pick<DeviceState, "getBiometricEnrollmentState"> = (device) => new DeviceState(device),
    private readonly stateFor: (device: BootedDevice) => Pick<DeviceState, "getState"> = (device) =>
      new DeviceState(device),
    private readonly rotationFor: (device: BootedDevice) => Pick<Rotate, "getRestoreState"> = (
      device,
    ) => new Rotate(device),
    observationReaders: Partial<MutationObservationReaders> = {},
  ) {
    this.dataReader = observationReaders.dataReader ?? new DataMutationPriorReader();
    this.observationReaders = {
      screenReaderFor:
        observationReaders.screenReaderFor ??
        ((device) =>
          device.platform === "android"
            ? { getEnabled: () => new TalkBackToggle(device).detectTalkBackEnabled() }
            : new VoiceOverToggle(device)),
      keyboardProfilesFor: observationReaders.keyboardProfilesFor,
    };
  }

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    signal?.throwIfAborted();
    const keys = DEVICE_SETTING_KEYS.filter((key) =>
      mutations.some((entry) => entry.kind === "device-setting" && entry.key === key),
    );
    const settings: DeviceSettingValues =
      keys.length > 0 ? await this.settingsAccess.read(device, keys, signal) : {};
    const clipboard = mutations.some((entry) => entry.kind === "clipboard")
      ? await this.clipboardFor(device).execute("get", undefined, { signal })
      : undefined;
    const biometrics = mutations.some(
      (entry) => entry.kind === "biometric-enrollment" && entry.key === "device",
    )
      ? await this.biometricsFor(device).getBiometricEnrollmentState(signal)
      : undefined;
    const fields = [...new Set(mutations.map(stateField).filter((field) => field !== undefined))];
    const state =
      fields.length > 0 ? await this.stateFor(device).getState(fields, signal) : undefined;
    const rotation =
      device.platform === "android" &&
      mutations.some((entry) => entry.kind === "rotation" && entry.key === "device")
        ? await this.rotationFor(device).getRestoreState(signal)
        : undefined;
    const screenReader = mutations.some(
      (entry) => entry.kind === "screen-reader" && entry.key === "device",
    )
      ? await awaitWhileRequestIsLive(
          this.observationReaders.screenReaderFor(device).getEnabled(),
          signal,
        )
      : undefined;
    const keyboardProfile = await this.readKeyboardProfile(device, mutations, signal);
    const dataPriors = await this.dataReader.read(device, mutations, signal);
    signal?.throwIfAborted();
    const priorsByKey: Readonly<Record<string, Readonly<Record<string, MutationValue>>>> = {
      device: {
        "biometric-enrollment": biometricPrior(biometrics),
        rotation: present(rotation),
        "screen-reader":
          typeof screenReader === "boolean"
            ? present({ platform: device.platform, previousEnabled: screenReader })
            : { state: "unobservable" },
      },
      profile: { keyboard: keyboardProfile },
    };
    return mutations.map((entry, index): MutationValue => {
      const setting = DEVICE_SETTING_KEYS.find(
        (key) => entry.kind === "device-setting" && entry.key === key,
      );
      if (setting && settings[setting] !== undefined) {
        const value = settings[setting];
        return value === null ? { state: "absent" } : { state: "present", value };
      }
      if (entry.kind === "clipboard" && clipboard?.success && clipboard.text !== undefined) {
        return { state: "present", value: clipboard.text };
      }
      if (stateField(entry)) {
        return statePrior(entry, state);
      }
      return priorsByKey[entry.key]?.[entry.kind] ?? dataPriors[index] ?? { state: "unobservable" };
    });
  }

  private async readKeyboardProfile(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<MutationValue> {
    if (
      device.platform !== "android" ||
      !mutations.some((entry) => entry.kind === "keyboard" && entry.key === "profile")
    ) {
      return { state: "unobservable" };
    }
    const client = this.observationReaders.keyboardProfilesFor?.(device);
    if (!client) {
      return { state: "unobservable" };
    }
    const catalog = await awaitWhileRequestIsLive(client.listKeyboardProfiles(), signal);
    return catalog.success && catalog.activeProfileId?.trim()
      ? present({ profileId: catalog.activeProfileId })
      : { state: "unobservable" };
  }
}
