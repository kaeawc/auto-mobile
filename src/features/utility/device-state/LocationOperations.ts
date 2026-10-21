import type { BootedDevice, ExecResult } from "../../../models";
import type { DeviceTraits } from "../../../utils/android-cmdline-tools/deviceTraits";
import { ActionableError } from "../../../models/ActionableError";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import {
  consolePortFromSerial,
  type EmulatorConsoleClient,
} from "../../../utils/android-cmdline-tools/EmulatorConsoleClient";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { isIosSimulatorDevice } from "../../action/IosSimulatorPermissions";
import type { EmulatorConsoleClientFactory } from "../../action/Telephony";
import {
  routeDistanceMeters,
  type LocationRouteRegistry,
  type LocationWaypoint,
  type EndedLocationRoute,
} from "../LocationRoutePlayer";
import { LocationWriteAdmissionError } from "./LocationWriteAdmissionError";
import {
  IosRunnerLocationError,
  sendRunnerLocation,
  type IosRunnerLocationClient,
} from "./IosRunnerLocation";

export type { IosRunnerLocationClient } from "./IosRunnerLocation";
export { LocationWriteAdmissionError } from "./LocationWriteAdmissionError";

export type SetDeviceLocationInput =
  | { mode: "static"; latitude: number; longitude: number }
  | {
      mode: "route";
      waypoints: LocationWaypoint[];
      speedMetersPerSecond?: number;
      durationMs?: number;
      loop?: boolean;
      updateIntervalMs?: number;
    }
  | { mode: "stop" };

export interface DeviceLocationState {
  supported: boolean;
  mode?: "static" | "route" | "stop";
  latitude?: number;
  longitude?: number;
  method?: "android_emulator_console" | "ios_simctl" | "ios_ctrl_proxy";
  stopped?: boolean;
  previousRoute?: EndedLocationRoute;
  waypointCount?: number;
  totalDistanceMeters?: number;
  expectedDurationMs?: number;
  loop?: boolean;
  updateIntervalMs?: number;
  /** A successful command is an applied fix, not a device location read-back. */
  verified?: boolean;
  error?: string;
}

function waypointCoordinateError(point: LocationWaypoint): string | undefined {
  if (!Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
    return "location.waypoints latitude must be finite and in [-90, 90]";
  }
  if (!Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
    return "location.waypoints longitude must be finite and in [-180, 180]";
  }
  if (point.altitude !== undefined && !Number.isFinite(point.altitude)) {
    return "location.waypoints altitude must be finite";
  }
  return undefined;
}

function routeWaypointError(waypoints: LocationWaypoint[]): string | undefined {
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return "location.waypoints must contain at least two points";
  }
  for (const point of waypoints) {
    const invalid = waypointCoordinateError(point);
    if (invalid) {
      return invalid;
    }
  }
  for (let index = 1; index < waypoints.length; index++) {
    const legDistance = routeDistanceMeters(waypoints.slice(index - 1, index + 1));
    if (legDistance === 0) {
      return "location.waypoints must contain distinct consecutive points";
    }
    if (Math.abs(legDistance - Math.PI * 6_371_000) < 0.001) {
      return "location.waypoints cannot contain antipodal consecutive points";
    }
  }
  return undefined;
}

function routeTimingError(
  input: Extract<SetDeviceLocationInput, { mode: "route" }>,
): string | undefined {
  if ((input.speedMetersPerSecond === undefined) === (input.durationMs === undefined)) {
    return "location.route requires exactly one of speedMetersPerSecond or durationMs";
  }
  if (
    input.speedMetersPerSecond !== undefined &&
    (!Number.isFinite(input.speedMetersPerSecond) || input.speedMetersPerSecond <= 0)
  ) {
    return "location.speedMetersPerSecond must be finite and positive";
  }
  if (
    input.durationMs !== undefined &&
    (!Number.isFinite(input.durationMs) || input.durationMs <= 0)
  ) {
    return "location.durationMs must be finite and positive";
  }
  const interval = input.updateIntervalMs ?? 1000;
  if (!Number.isInteger(interval) || interval < 200 || interval > 60000) {
    return "location.updateIntervalMs must be an integer in [200, 60000]";
  }
  return undefined;
}

export function locationInputError(input: SetDeviceLocationInput | undefined): string | undefined {
  if (!input || input.mode === "stop") {
    return undefined;
  }
  if (input.mode === "route") {
    return routeWaypointError(input.waypoints) ?? routeTimingError(input);
  }
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) {
    return "location.latitude must be a finite number in [-90, 90]";
  }
  if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
    return "location.longitude must be a finite number in [-180, 180]";
  }
  return undefined;
}

function routeDurationMs(
  input: Extract<SetDeviceLocationInput, { mode: "route" }>,
  distance: number,
): number {
  const duration = input.durationMs ?? (distance / input.speedMetersPerSecond!) * 1000;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ActionableError("location route duration must be finite and positive");
  }
  return duration;
}

interface LocationSimulatorClient {
  executeCommandArgs?(
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult>;
}

interface LocationOperationsDependencies {
  device: () => BootedDevice;
  adbFactory: () => AdbClientFactory;
  simctl: () => LocationSimulatorClient | null;
  routeRegistry: () => LocationRouteRegistry;
  consoleFactory: () => EmulatorConsoleClientFactory;
  deviceTraits: () => DeviceTraits;
  canWriteLocation: () => boolean;
  onLocationApplied: () => (() => void) | undefined;
  /** Physical iOS seam (#14091); defaults to the device's CtrlProxy runner client. */
  runnerLocation?: () => IosRunnerLocationClient | undefined;
}

const PHYSICAL_IOS_RUNNER_MISSING =
  "Location simulation on a physical iOS device is not available from this entry point; " +
  "use the MCP server or daemon, which connect the CtrlProxy runner.";

export class LocationOperations {
  constructor(private readonly dependencies: LocationOperationsDependencies) {}

  /** Throws when the emulator flag cannot be read; callers report that as a probe failure. */
  private async isAndroidEmulator(): Promise<boolean> {
    const device = this.dependencies.device();
    const adb = this.dependencies.adbFactory().create(device);
    const traits = await this.dependencies.deviceTraits().read(adb, device.deviceId);
    return traits.isEmulator === true;
  }

  /** Throws an unsupported failure when this entry point wired no runner (#14091). */
  private runnerLocation(): IosRunnerLocationClient {
    const runner = this.dependencies.runnerLocation?.();
    if (!runner) {
      throw new IosRunnerLocationError(
        { success: false, unsupported: true, totalTimeMs: 0 },
        PHYSICAL_IOS_RUNNER_MISSING,
      );
    }
    return runner;
  }

  private isPhysicalIos(): boolean {
    const device = this.dependencies.device();
    return device.platform === "ios" && !isIosSimulatorDevice(device);
  }

  /** Physical iOS route fixes go through the runner on the same host timer as simctl (#14091). */
  private physicalIosRouteEmitter() {
    const runner = this.runnerLocation();
    return {
      emit: async (
        point: LocationWaypoint,
        options: { signal: AbortSignal; timeoutMs: number },
      ) => {
        this.assertLocationWriteAdmitted();
        await sendRunnerLocation(
          runner,
          { latitude: point.latitude, longitude: point.longitude, altitude: point.altitude },
          options,
        );
      },
      method: "ios_ctrl_proxy" as const,
      onStarted: this.dependencies.onLocationApplied(),
    };
  }

  /** Physical iOS static fix through the runner (#14091); release clears it like simctl's. */
  private async writePhysicalIosStaticLocation(
    input: Extract<SetDeviceLocationInput, { mode: "static" }>,
  ): Promise<DeviceLocationState> {
    const device = this.dependencies.device();
    let previousRoute: EndedLocationRoute | undefined;
    try {
      ({ previousRoute } = await this.dependencies
        .routeRegistry()
        .stopAndSettle(device.deviceId, "replaced"));
      this.assertLocationWriteAdmitted();
      await sendRunnerLocation(this.runnerLocation(), {
        latitude: input.latitude,
        longitude: input.longitude,
      });
      this.dependencies.onLocationApplied()?.();
      return {
        supported: true,
        mode: "static",
        latitude: input.latitude,
        longitude: input.longitude,
        method: "ios_ctrl_proxy",
        previousRoute,
      };
    } catch (error) {
      if (error instanceof LocationWriteAdmissionError) {
        throw error;
      }
      logger.warn(
        `Failed to set physical iOS location for ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return {
        supported: !(error instanceof IosRunnerLocationError && error.unsupported),
        method: "ios_ctrl_proxy",
        error: `Failed to set physical iOS location: ${errorMessage(error)}`,
        previousRoute,
      };
    }
  }

  async writeLocation(input: SetDeviceLocationInput): Promise<DeviceLocationState> {
    if (input.mode === "stop") {
      const stopped = await this.dependencies
        .routeRegistry()
        .stopAndSettle(this.dependencies.device().deviceId);
      return {
        supported: true,
        mode: "stop",
        ...stopped,
      };
    }
    const invalid = locationInputError(input);
    if (invalid) {
      return { supported: true, error: invalid };
    }
    if (input.mode === "route") {
      return this.physicalIosRunnerMissing() ?? this.startLocationRoute(input);
    }
    return this.writeStaticLocation(input);
  }

  /** A route on physical iOS needs the injected runner; report it unsupported up front. */
  private physicalIosRunnerMissing(): DeviceLocationState | undefined {
    if (!this.isPhysicalIos() || this.dependencies.runnerLocation?.()) {
      return undefined;
    }
    return { supported: false, method: "ios_ctrl_proxy", error: PHYSICAL_IOS_RUNNER_MISSING };
  }

  private assertLocationWriteAdmitted(): void {
    if (!this.dependencies.canWriteLocation()) {
      throw new LocationWriteAdmissionError(
        "Cannot change location: session is released, releasing, rebound, or replaced.",
      );
    }
  }

  private async writeStaticLocation(
    input: Extract<SetDeviceLocationInput, { mode: "static" }>,
  ): Promise<DeviceLocationState> {
    if (this.dependencies.device().platform === "ios") {
      if (!isIosSimulatorDevice(this.dependencies.device())) {
        return this.writePhysicalIosStaticLocation(input);
      }
      const simctl = this.dependencies.simctl() ?? new SimCtlClient(this.dependencies.device());
      let previousRoute: EndedLocationRoute | undefined;
      try {
        if (!simctl.executeCommandArgs) {
          throw new Error("Injected simctl client does not support argv commands");
        }
        ({ previousRoute } = await this.dependencies
          .routeRegistry()
          .stopAndSettle(this.dependencies.device().deviceId, "replaced"));
        this.assertLocationWriteAdmitted();
        await simctl.executeCommandArgs([
          "location",
          this.dependencies.device().deviceId,
          "set",
          `${input.latitude},${input.longitude}`,
        ]);
        this.dependencies.onLocationApplied()?.();
        return {
          supported: true,
          mode: "static",
          latitude: input.latitude,
          longitude: input.longitude,
          method: "ios_simctl",
          previousRoute,
        };
      } catch (error) {
        if (error instanceof LocationWriteAdmissionError) {
          throw error;
        }
        logger.warn(
          `Failed to set iOS Simulator location for ${this.dependencies.device().deviceId}: ${errorMessage(error)}`,
          error,
        );
        return {
          supported: true,
          method: "ios_simctl",
          error: `Failed to set iOS Simulator location: ${errorMessage(error)}`,
          previousRoute,
        };
      }
    }
    const port = consolePortFromSerial(this.dependencies.device().deviceId);
    if (port === null) {
      return {
        supported: false,
        error:
          "Location simulation is unsupported on physical Android devices. Use an Android emulator.",
      };
    }
    let previousRoute: EndedLocationRoute | undefined;
    try {
      if (!(await this.isAndroidEmulator())) {
        return {
          supported: false,
          error: "Location simulation requires an Android emulator (ro.kernel.qemu=1).",
        };
      }
      ({ previousRoute } = await this.dependencies
        .routeRegistry()
        .stopAndSettle(this.dependencies.device().deviceId, "replaced"));
      const consoleClient: EmulatorConsoleClient = this.dependencies.consoleFactory()(port);
      this.assertLocationWriteAdmitted();
      await consoleClient.geoFix(input.longitude, input.latitude);
      return {
        supported: true,
        mode: "static",
        latitude: input.latitude,
        longitude: input.longitude,
        method: "android_emulator_console",
        previousRoute,
      };
    } catch (error) {
      if (error instanceof LocationWriteAdmissionError) {
        throw error;
      }
      logger.warn(
        `Failed to set Android emulator location for ${this.dependencies.device().deviceId}: ${errorMessage(error)}`,
        error,
      );
      return {
        supported: true,
        method: "android_emulator_console",
        error: `Failed to set Android emulator location: ${errorMessage(error)}`,
        previousRoute,
      };
    }
  }

  private async startLocationRoute(
    input: Extract<SetDeviceLocationInput, { mode: "route" }>,
  ): Promise<DeviceLocationState> {
    const distance = routeDistanceMeters(input.waypoints);
    const duration = routeDurationMs(input, distance);
    const interval = input.updateIntervalMs ?? 1000;
    const loop = input.loop ?? false;
    let emit: (
      point: LocationWaypoint,
      options: { signal: AbortSignal; timeoutMs: number },
    ) => Promise<void>;
    let method: DeviceLocationState["method"];
    let onStarted: (() => void) | undefined;
    if (this.isPhysicalIos()) {
      ({ emit, method, onStarted } = this.physicalIosRouteEmitter());
    } else if (this.dependencies.device().platform === "ios") {
      const simctl = this.dependencies.simctl() ?? new SimCtlClient(this.dependencies.device());
      if (!simctl.executeCommandArgs) {
        throw new ActionableError("simctl client does not support argv commands");
      }
      emit = async (point, options) => {
        this.assertLocationWriteAdmitted();
        await simctl.executeCommandArgs!(
          [
            "location",
            this.dependencies.device().deviceId,
            "set",
            `${point.latitude},${point.longitude}`,
          ],
          options.timeoutMs,
          options.signal,
        );
      };
      method = "ios_simctl";
      onStarted = this.dependencies.onLocationApplied();
    } else {
      const port = consolePortFromSerial(this.dependencies.device().deviceId);
      if (port === null) {
        return {
          supported: false,
          error:
            "Location simulation is unsupported on physical Android devices. Use an Android emulator.",
        };
      }
      try {
        if (!(await this.isAndroidEmulator())) {
          return {
            supported: false,
            error: "Location simulation requires an Android emulator (ro.kernel.qemu=1).",
          };
        }
      } catch (error) {
        logger.warn(
          `Failed to probe Android emulator for location route: ${errorMessage(error)}`,
          error,
        );
        return {
          supported: true,
          error: `Failed to probe Android emulator: ${errorMessage(error)}`,
        };
      }
      const client = this.dependencies.consoleFactory()(port);
      emit = async (point, options) => {
        this.assertLocationWriteAdmitted();
        await client.geoFix(point.longitude, point.latitude, point.altitude, options.signal);
      };
      method = "android_emulator_console";
    }
    const { previousRoute } = await this.dependencies
      .routeRegistry()
      .stopAndSettle(this.dependencies.device().deviceId, "replaced");
    // Setup drain is bounded; re-check ownership immediately before starting playback.
    this.assertLocationWriteAdmitted();
    this.dependencies
      .routeRegistry()
      .start(this.dependencies.device().deviceId, input.waypoints, duration, interval, loop, emit);
    // Mark at start: a release can precede the first scheduled simulator fix.
    // Android's console has no unset command, so Android never acquires a marker.
    onStarted?.();
    return {
      supported: true,
      mode: "route",
      waypointCount: input.waypoints.length,
      totalDistanceMeters: distance,
      expectedDurationMs: duration,
      loop,
      updateIntervalMs: interval,
      method,
      ...(previousRoute ? { previousRoute } : {}),
    };
  }
}
