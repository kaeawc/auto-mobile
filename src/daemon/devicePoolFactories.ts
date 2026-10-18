import { DevicePoolRefresh, type DevicePoolRefreshPort } from "./devicePoolRefresh";
import {
  AdbServerResetQuarantine,
  type AdbServerResetQuarantinePoolPort,
} from "./adbServerResetQuarantine";
import {
  EmulatorProcessLifecycle,
  type EmulatorProcessLifecyclePoolPort,
} from "./emulatorProcessLifecycle";
import { MissingDeviceLiveness, type MissingDeviceLivenessPoolPort } from "./missingDeviceLiveness";
import { DeviceRuntimeIdentity, type DeviceRuntimeIdentityPoolPort } from "./deviceRuntimeIdentity";
import {
  DeviceShutdownReservations,
  type DeviceShutdownReservationsPoolPort,
} from "./deviceShutdownReservations";
import type { DevicePoolDependencies } from "./devicePool";

/** Default-or-injected construction of the collaborators `DevicePool` composes. */
export function createAdbServerResetQuarantine(
  port: AdbServerResetQuarantinePoolPort,
  factory?: DevicePoolDependencies["adbServerResetQuarantineFactory"],
): AdbServerResetQuarantine {
  return factory ? factory(port) : new AdbServerResetQuarantine(port);
}

export function createEmulatorProcessLifecycle(
  port: EmulatorProcessLifecyclePoolPort,
  factory?: DevicePoolDependencies["emulatorProcessLifecycleFactory"],
): EmulatorProcessLifecycle {
  return factory ? factory(port) : new EmulatorProcessLifecycle(port);
}

export function createMissingDeviceLiveness(
  port: MissingDeviceLivenessPoolPort,
  factory?: DevicePoolDependencies["missingDeviceLivenessFactory"],
): MissingDeviceLiveness {
  return factory ? factory(port) : new MissingDeviceLiveness(port);
}

export function resolveMissingDeviceMisses(shared?: Map<string, number>): Map<string, number> {
  return shared ?? new Map();
}

export function createDevicePoolRefresh(
  port: DevicePoolRefreshPort,
  factory?: DevicePoolDependencies["devicePoolRefreshFactory"],
): DevicePoolRefresh {
  return factory ? factory(port) : new DevicePoolRefresh(port);
}

export function createDeviceRuntimeIdentity(
  port: DeviceRuntimeIdentityPoolPort,
  factory?: DevicePoolDependencies["runtimeIdentityFactory"],
): DeviceRuntimeIdentity {
  return factory ? factory(port) : new DeviceRuntimeIdentity(port);
}

export function createDeviceShutdownReservations(
  port: DeviceShutdownReservationsPoolPort,
  factory?: DevicePoolDependencies["deviceShutdownReservationsFactory"],
): DeviceShutdownReservations {
  return factory ? factory(port) : new DeviceShutdownReservations(port);
}
