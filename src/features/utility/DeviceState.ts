import {
  LocationOperations,
  type DeviceLocationState,
  type SetDeviceLocationInput,
} from "./device-state/LocationOperations";
import { ConnectivityOperations } from "./device-state/ConnectivityOperations";
import type {
  DeviceConnectivityState,
  SetDeviceConnectivityInput,
} from "./device-state/ConnectivityState";
import type {
  NetworkConditionState,
  SetNetworkConditionInput,
} from "./device-state/NetworkConditionState";
import { NetworkConditionOperations } from "./device-state/NetworkConditionOperations";
import { DoNotDisturbOperations } from "./device-state/DoNotDisturbOperations";
import type { DoNotDisturbState } from "./device-state/DoNotDisturbState";
import { BiometricOperations } from "./device-state/BiometricOperations";
import type { BiometricEnrollment, BiometricEnrollmentState } from "./device-state/BiometricState";
import { ClockOperations } from "./device-state/ClockOperations";
import {
  DEFAULT_DEVICE_STATE_FIELDS,
  EMPTY_STATE_SELECTION_ERROR,
  setDeviceStateInputIsEmpty,
  setDeviceStateInputError,
  validateClockCombinedInputs,
  type DeviceStateResult,
  type SetDeviceStateInput,
  type DeviceStateField,
  type SelectedDeviceStates,
  type SelectedDeviceState,
  type IosSimulatorClient,
  type DeviceStateDependencies,
  type RequestedDeviceStates,
} from "./device-state/DeviceStateTypes";
import {
  validateDeviceClockInput,
  type DeviceClockRestoreSlot,
  type PreparedDeviceClock,
  type DeviceClockState,
  type SetDeviceClockInput,
} from "./DeviceClock";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../models";
import { writeDeviceCameraPoster } from "./DeviceCameraPoster";
import type { QrPosterWriter } from "../../utils/qr/QrPosterWriter";
import { ActionableError } from "../../models/ActionableError";
import { defaultLocationRouteRegistry, LocationRouteRegistry } from "./LocationRoutePlayer";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  ExecNetworkFilterBridge,
  type NetworkFilterBridge,
} from "../networkFilter/NetworkFilterBridge";
import type { IosAppNetworkRuleCommandContext } from "../networkFilter/IosAppNetworkRuleClient";
import {
  defaultEmulatorConsoleClientFactory,
  type EmulatorConsoleClientFactory,
} from "../action/Telephony";

export { doNotDisturbModeSchema } from "./device-state/DoNotDisturbState";
export type { DoNotDisturbState } from "./device-state/DoNotDisturbState";
export { biometricEnrollmentSchema } from "./device-state/BiometricState";
export type { BiometricEnrollment, BiometricEnrollmentState } from "./device-state/BiometricState";
export {
  DEVICE_STATE_READABLE_FIELDS,
  DEVICE_STATE_WRITABLE_FIELDS,
  EMPTY_STATE_SELECTION_ERROR,
} from "./device-state/DeviceStateTypes";
export type {
  DeviceStateResult,
  SetDeviceStateInput,
  DeviceStateField,
  DeviceStateDependencies,
} from "./device-state/DeviceStateTypes";
export type {
  DeviceLocationState,
  SetDeviceLocationInput,
} from "./device-state/LocationOperations";
export type { DeviceConnectivityState } from "./device-state/ConnectivityState";
export { ANDROID_CONNECTIVITY_READ_COMMAND } from "./device-state/ConnectivityState";

export {
  networkConditionProfileSchema,
  NETWORK_CONDITION_PROFILES,
  MAX_NETWORK_CONDITION_TTL_SECONDS,
  IOS_APP_NETWORK_CONDITION_LIMITATIONS,
  iosAppNetworkRuleOutcome,
  parseEmulatorNetworkStatus,
  classifyNetworkConditionRequest,
  networkConditionInputIsRequest,
  networkConditionInputError,
  networkConditionInputDegrades,
} from "./device-state/NetworkConditionState";
export type {
  NetworkConditionProfile,
  NetworkConditionState,
  SetNetworkConditionInput,
} from "./device-state/NetworkConditionState";

export type { DeviceClockState, SetDeviceClockInput } from "./DeviceClock";

export {
  emulatorConsoleReportsFailure,
  emulatorConsoleFailureReason,
} from "../../utils/android-cmdline-tools/emulatorConsoleReply";

export class DeviceState {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private simctl: IosSimulatorClient | null;

  private timer: Timer;
  private consoleFactory: EmulatorConsoleClientFactory;
  private routeRegistry: LocationRouteRegistry;
  private readonly canWriteLocation: () => boolean;
  private readonly onLocationApplied?: () => void;
  private readonly cameraPosterQrWriter?: QrPosterWriter;
  private readonly cameraPosterFileExists?: (path: string) => boolean;
  private injectedNetworkFilterBridge?: NetworkFilterBridge;
  private readonly iosAppNetworkRule?: () => IosAppNetworkRuleCommandContext | undefined;

  private readonly networkCondition = new NetworkConditionOperations({
    device: () => this.device,
    adbFactory: () => this.adbFactory,
    timer: () => this.timer,
    networkFilterBridge: () => this.networkFilterBridge,
    iosAppNetworkRule: () => this.iosAppNetworkRule?.(),
  });

  private readonly location = new LocationOperations({
    device: () => this.device,
    adbFactory: () => this.adbFactory,
    simctl: () => this.simctl,
    routeRegistry: () => this.routeRegistry,
    consoleFactory: () => this.consoleFactory,
    canWriteLocation: () => this.canWriteLocation(),
    onLocationApplied: () => this.onLocationApplied,
  });

  private readonly connectivity = new ConnectivityOperations({
    device: () => this.device,
    adbFactory: () => this.adbFactory,
  });

  private readonly clock: ClockOperations;

  private readonly doNotDisturb = new DoNotDisturbOperations({
    device: () => this.device,
    adbFactory: () => this.adbFactory,
  });

  private readonly biometric = new BiometricOperations({
    device: () => this.device,
    simctl: () => this.simctl,
  });

  constructor(device: BootedDevice, dependencies: DeviceStateDependencies = {}) {
    this.device = device;
    this.clock = new ClockOperations(
      {
        device: () => this.device,
        adbFactory: () => this.adbFactory,
        timer: () => this.timer,
      },
      dependencies.clockRestoreRegistry,
    );
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.clock.initializeAdapter(dependencies.clockAdapter);
    this.timer = dependencies.timer ?? defaultTimer;
    this.clock.initializeMutation(dependencies.clockMutation);
    this.clock.initializeCacheInvalidation(dependencies.invalidateClockCaches);
    this.cameraPosterQrWriter = dependencies.cameraPosterQrWriter;
    this.cameraPosterFileExists = dependencies.cameraPosterFileExists;
    this.simctl = dependencies.simctl ?? null;
    this.consoleFactory = dependencies.consoleFactory ?? defaultEmulatorConsoleClientFactory;
    this.routeRegistry = dependencies.routeRegistry ?? defaultLocationRouteRegistry;
    this.canWriteLocation = dependencies.canWriteLocation ?? (() => true);
    this.onLocationApplied = dependencies.onLocationApplied;
    this.injectedNetworkFilterBridge = dependencies.networkFilterBridge;
    this.iosAppNetworkRule = dependencies.iosAppNetworkRule;
  }

  /** Created on first iOS Simulator network read so other paths never touch it. */
  private get networkFilterBridge(): NetworkFilterBridge {
    this.injectedNetworkFilterBridge ??= new ExecNetworkFilterBridge();
    return this.injectedNetworkFilterBridge;
  }

  async getState(
    include: readonly DeviceStateField[] = DEFAULT_DEVICE_STATE_FIELDS,
  ): Promise<DeviceStateResult> {
    // An empty selection would otherwise read nothing and report success.
    if (include.length === 0) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: EMPTY_STATE_SELECTION_ERROR,
      };
    }
    const selected = await this.readSelectedStates(include);
    const requestedStates = Object.values(selected).filter(
      (state): state is SelectedDeviceState => state !== undefined,
    );
    // Every read path uses supported:false only for a static platform limitation;
    // supported reads carry errors for genuine probe failures.
    const unsupported = Object.entries(selected)
      .filter(([, state]) => state !== undefined && !state.supported)
      .map(([field]) => field as DeviceStateField);
    const failedState = requestedStates.find((state) => state.supported && state.error);

    return {
      success: !failedState,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      ...(this.device.displays ? { displays: this.device.displays } : {}),
      ...selected,
      ...(unsupported.length > 0 ? { unsupported } : {}),
      ...(failedState?.error ? { error: failedState.error } : {}),
    };
  }

  /**
   * Read exactly the selected fields, in report order. Kept separate from
   * `getState` so the selection branching does not compound with the
   * success/error aggregation in one function.
   */
  private async readSelectedStates(
    include: readonly DeviceStateField[],
  ): Promise<SelectedDeviceStates> {
    return {
      ...(include.includes("clock") ? { clock: await this.clock.read() } : {}),
      ...(include.includes("doNotDisturb") ? { doNotDisturb: await this.readDoNotDisturb() } : {}),
      ...(include.includes("connectivity") ? { connectivity: await this.readConnectivity() } : {}),
      ...(include.includes("biometrics")
        ? { biometrics: await this.getBiometricEnrollmentState() }
        : {}),
      ...(include.includes("networkCondition")
        ? { networkCondition: await this.readNetworkCondition() }
        : {}),
    };
  }

  async setState(input: SetDeviceStateInput): Promise<DeviceStateResult> {
    if (input.clock !== undefined) {
      validateDeviceClockInput(input.clock);
      validateClockCombinedInputs(input);
    }
    if (setDeviceStateInputIsEmpty(input)) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: "At least one device state field must be provided",
      };
    }

    const inputError = setDeviceStateInputError(input);
    if (inputError) {
      if (input.clock || input.location?.mode === "route" || input.location?.mode === "stop") {
        throw new ActionableError(inputError);
      }
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: inputError,
      };
    }

    const states = input.clock
      ? await this.writeClockCombinedStates(input)
      : await this.writeRequestedStates(input);
    const requestedStates = Object.values(states).filter(
      (state): state is NonNullable<RequestedDeviceStates[keyof RequestedDeviceStates]> =>
        state !== undefined,
    );
    const error = requestedStates.find((state) => state.error)?.error;

    return {
      success: requestedStates.every(
        (state) => state.supported && !state.error && state.verified !== false,
      ),
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      ...states,
      ...(error ? { error } : {}),
    };
  }

  private writeClockCombinedStates(input: SetDeviceStateInput): Promise<RequestedDeviceStates> {
    return this.clock.writeClockCombinedStates(input, (...args) =>
      this.writeRequestedStates(...args),
    );
  }

  /** Write exactly the mutation fields supplied by the caller. */
  private async writeRequestedStates(
    input: SetDeviceStateInput,
    preparedClock?: PreparedDeviceClock,
    failedClock?: DeviceClockState,
    slot?: DeviceClockRestoreSlot,
  ): Promise<RequestedDeviceStates> {
    return {
      ...(input.doNotDisturb
        ? { doNotDisturb: await this.writeDoNotDisturb(input.doNotDisturb) }
        : {}),
      ...(input.biometrics
        ? { biometrics: await this.setBiometricEnrollmentState(input.biometrics.enrollment) }
        : {}),
      ...(input.connectivity
        ? { connectivity: await this.writeConnectivity(input.connectivity) }
        : {}),
      ...(input.networkCondition
        ? { networkCondition: await this.writeNetworkCondition(input.networkCondition) }
        : {}),
      ...(input.location ? { location: await this.writeLocation(input.location) } : {}),
      ...(input.clock
        ? { clock: failedClock ?? (await this.writeClock(input.clock, preparedClock, slot)) }
        : {}),
      ...(input.cameraPoster
        ? {
            cameraPoster: await writeDeviceCameraPoster(this.device, input.cameraPoster, {
              adbFactory: this.adbFactory,
              qrWriter: this.cameraPosterQrWriter,
              fileExists: this.cameraPosterFileExists,
            }),
          }
        : {}),
    };
  }

  private writeClock(
    input: SetDeviceClockInput,
    prepared?: PreparedDeviceClock,
    slot?: DeviceClockRestoreSlot,
  ): Promise<DeviceClockState> {
    return this.clock.writeClock(input, prepared, slot);
  }

  private writeLocation(input: SetDeviceLocationInput): Promise<DeviceLocationState> {
    return this.location.writeLocation(input);
  }

  getBiometricEnrollmentState(): Promise<BiometricEnrollmentState> {
    return this.biometric.getBiometricEnrollmentState();
  }

  setBiometricEnrollmentState(enrollment: BiometricEnrollment): Promise<BiometricEnrollmentState> {
    return this.biometric.setBiometricEnrollmentState(enrollment);
  }

  private readDoNotDisturb(): Promise<DoNotDisturbState> {
    return this.doNotDisturb.readDoNotDisturb();
  }

  /** Platform dispatch for reading the device-level connectivity toggles. */
  private readConnectivity(): Promise<DeviceConnectivityState> {
    return this.connectivity.readConnectivity();
  }

  /** Platform dispatch for writing device-level connectivity toggles. */
  private writeConnectivity(input: SetDeviceConnectivityInput): Promise<DeviceConnectivityState> {
    return this.connectivity.writeConnectivity(input);
  }

  private writeDoNotDisturb(
    input: SetDeviceStateInput["doNotDisturb"],
  ): Promise<DoNotDisturbState> {
    return this.doNotDisturb.writeDoNotDisturb(input);
  }

  /** Platform dispatch for reading the device-wide network condition. */
  private readNetworkCondition(): Promise<NetworkConditionState> {
    return this.networkCondition.read();
  }

  /** Platform dispatch for writing the device-wide network condition. */
  private writeNetworkCondition(input: SetNetworkConditionInput): Promise<NetworkConditionState> {
    return this.networkCondition.write(input);
  }
}
