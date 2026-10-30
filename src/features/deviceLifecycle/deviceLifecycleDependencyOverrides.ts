import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
} from "../../devices/virtualDeviceLifecycleCoordinator";
import type { DeviceToolsDependencies } from "./deviceLifecycleCore";
export function provisionDeviceDependencyOverrides(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
): Pick<
  DeviceToolsDependencies,
  | "exactDeviceProvisionerFactory"
  | "checkBootCapacity"
  | "provisionAndroidIdentityBackoff"
  | "manufacturerProfileApplier"
> {
  return {
    manufacturerProfileApplier:
      deps.manufacturerProfileApplier ?? currentDeps.manufacturerProfileApplier,
    exactDeviceProvisionerFactory:
      deps.exactDeviceProvisionerFactory ?? currentDeps.exactDeviceProvisionerFactory,
    checkBootCapacity: deps.checkBootCapacity ?? currentDeps.checkBootCapacity,
    provisionAndroidIdentityBackoff:
      deps.provisionAndroidIdentityBackoff ?? currentDeps.provisionAndroidIdentityBackoff,
  };
}

export function resourceNotificationDependencyOverrides(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
): Pick<
  DeviceToolsDependencies,
  | "appResourceDependencies"
  | "notifyResourcesChanged"
  | "notifyDeviceInventoryResourcesChanged"
  | "syncInstalledAppResourceRegistry"
> {
  return {
    appResourceDependencies: deps.appResourceDependencies ?? currentDeps.appResourceDependencies,
    notifyResourcesChanged: deps.notifyResourcesChanged ?? currentDeps.notifyResourcesChanged,
    notifyDeviceInventoryResourcesChanged:
      deps.notifyDeviceInventoryResourcesChanged ??
      currentDeps.notifyDeviceInventoryResourcesChanged,
    syncInstalledAppResourceRegistry:
      deps.syncInstalledAppResourceRegistry ?? currentDeps.syncInstalledAppResourceRegistry,
  };
}

export function resolveDeviceToolsLifecycleCoordinator(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
): VirtualDeviceLifecycleCoordinator {
  if (deps.lifecycleCoordinator) {
    return deps.lifecycleCoordinator;
  }
  return deps.timer
    ? new InMemoryVirtualDeviceLifecycleCoordinator(deps.timer)
    : currentDeps.lifecycleCoordinator;
}

function discoveryDependencyOverrides(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
) {
  return {
    androidAdbFactory: deps.androidAdbFactory ?? currentDeps.androidAdbFactory,
    cameraPosterQrWriter: deps.cameraPosterQrWriter ?? currentDeps.cameraPosterQrWriter,
    env: deps.env ?? currentDeps.env,
    deviceResourceObserverFactory:
      deps.deviceResourceObserverFactory ?? currentDeps.deviceResourceObserverFactory,
    deviceResourceControllerFactory:
      deps.deviceResourceControllerFactory ?? currentDeps.deviceResourceControllerFactory,
    deviceResourceReconcilerFactory:
      deps.deviceResourceReconcilerFactory ?? currentDeps.deviceResourceReconcilerFactory,
    deviceManagerFactory: deps.deviceManagerFactory ?? currentDeps.deviceManagerFactory,
    avdManagerFactory: deps.avdManagerFactory ?? currentDeps.avdManagerFactory,
    deviceMatcherFactory: deps.deviceMatcherFactory ?? currentDeps.deviceMatcherFactory,
    displayInventory: deps.displayInventory ?? currentDeps.displayInventory,
  };
}

function readinessDependencyOverrides(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
) {
  return {
    ...resourceNotificationDependencyOverrides(deps, currentDeps),
    ensureCtrlProxyReady: deps.ensureCtrlProxyReady ?? currentDeps.ensureCtrlProxyReady,
    watchSimulatorLifecycleFactory:
      deps.watchSimulatorLifecycleFactory ?? currentDeps.watchSimulatorLifecycleFactory,
    deviceCreationGateFactory:
      deps.deviceCreationGateFactory ?? currentDeps.deviceCreationGateFactory,
    deviceProvisionerFactory: deps.deviceProvisionerFactory ?? currentDeps.deviceProvisionerFactory,
    bootCapacityReporters: deps.bootCapacityReporters ?? currentDeps.bootCapacityReporters,
    ...provisionDeviceDependencyOverrides(deps, currentDeps),
  };
}

function executionDependencyOverrides(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
) {
  return {
    clearInstalledAppsForDevice:
      deps.clearInstalledAppsForDevice ?? currentDeps.clearInstalledAppsForDevice,
    stopPerformanceMonitoring:
      deps.stopPerformanceMonitoring ?? currentDeps.stopPerformanceMonitoring,
    stopAndroidObservers: deps.stopAndroidObservers ?? currentDeps.stopAndroidObservers,
    idGenerator: deps.idGenerator ?? currentDeps.idGenerator,
    timer: deps.timer ?? currentDeps.timer,
    daemonState: deps.daemonState ?? currentDeps.daemonState,
    lifecycleCoordinator: resolveDeviceToolsLifecycleCoordinator(deps, currentDeps),
  };
}

/** Merge dependency overrides while retaining the process stopper's lazy lookup. */
export function mergeDeviceToolsDependencies(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
): DeviceToolsDependencies {
  return {
    ...discoveryDependencyOverrides(deps, currentDeps),
    ...readinessDependencyOverrides(deps, currentDeps),
    ...executionDependencyOverrides(deps, currentDeps),
    get androidEmulatorProcessStopper() {
      return deps.androidEmulatorProcessStopper ?? currentDeps.androidEmulatorProcessStopper;
    },
    resolveRunningAndroidAvdName:
      deps.resolveRunningAndroidAvdName ?? currentDeps.resolveRunningAndroidAvdName,
  };
}
