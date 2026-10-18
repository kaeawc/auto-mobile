import { HierarchyCollector } from "../../src/features/observe/collectors/HierarchyCollector";
import { DeviceStateCollector } from "../../src/features/observe/collectors/DeviceStateCollector";
import type { BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeViewHierarchy } from "../fakes/FakeViewHierarchy";
import { FakeWindow } from "../fakes/FakeWindow";
import type { BackStack } from "../../src/features/observe/interfaces/BackStack";

/**
 * ObserveScreenDependencies requires the concrete collector classes, which carry
 * private state, so a plain fake is not assignable. These bridges build a real
 * collector (its constructor only stores options) and replace the public methods
 * with the fake's. Methods the fake does not implement throw, as calling a
 * missing method on the old cast fakes did.
 */
const unusedBackStack: BackStack = {
  execute: async () => {
    throw new TypeError("backStack is not available to this collector test seam");
  },
};

const seamDevice: BootedDevice = { deviceId: "collector-seam", name: "Seam", platform: "android" };

function missing(name: string): never {
  throw new TypeError(`${name} is not implemented by this collector test seam`);
}

export type HierarchyCollectorSeam = Pick<HierarchyCollector, "collect"> &
  Partial<
    Pick<HierarchyCollector, "collectRaw" | "extractScreenSize" | "reconcileScreenDimensions">
  >;

export function hierarchyCollectorFromSeam(seam: HierarchyCollectorSeam): HierarchyCollector {
  const adb = new FakeAdbExecutor();
  const real = new HierarchyCollector({
    device: seamDevice,
    viewHierarchy: new FakeViewHierarchy(),
    adb,
    adbFactory: new FakeAdbClientFactory(adb),
    timer: new FakeTimer(),
  });
  // Late-bound so tests may reassign a fake's method after the collector is built.
  type H = HierarchyCollector;
  return Object.assign(real, {
    collect: (...args: Parameters<H["collect"]>) => seam.collect(...args),
    collectRaw: (...args: Parameters<H["collectRaw"]>) =>
      seam.collectRaw ? seam.collectRaw(...args) : missing("collectRaw"),
    extractScreenSize: (...args: Parameters<H["extractScreenSize"]>) =>
      seam.extractScreenSize ? seam.extractScreenSize(...args) : missing("extractScreenSize"),
    reconcileScreenDimensions: (...args: Parameters<H["reconcileScreenDimensions"]>) =>
      seam.reconcileScreenDimensions
        ? seam.reconcileScreenDimensions(...args)
        : missing("reconcileScreenDimensions"),
  });
}

export type DeviceStateCollectorSeam = Partial<
  Pick<
    DeviceStateCollector,
    | "collectWakefulness"
    | "collectDeviceLock"
    | "collectBackStack"
    | "collectForegroundIdentity"
    | "collectForegroundSnapshot"
    | "collectFocusedSystemUiSurface"
    | "collectActiveWindow"
  >
>;

export function deviceStateCollectorFromSeam(seam: DeviceStateCollectorSeam): DeviceStateCollector {
  const real = new DeviceStateCollector({
    device: seamDevice,
    window: new FakeWindow(),
    backStack: unusedBackStack,
    adb: new FakeAdbExecutor(),
    timer: new FakeTimer(),
  });
  // Late-bound so tests may reassign a fake's method after the collector is built.
  type D = DeviceStateCollector;
  return Object.assign(real, {
    collectWakefulness: (...args: Parameters<D["collectWakefulness"]>) =>
      seam.collectWakefulness ? seam.collectWakefulness(...args) : missing("collectWakefulness"),
    collectDeviceLock: (...args: Parameters<D["collectDeviceLock"]>) =>
      seam.collectDeviceLock ? seam.collectDeviceLock(...args) : missing("collectDeviceLock"),
    collectBackStack: (...args: Parameters<D["collectBackStack"]>) =>
      seam.collectBackStack ? seam.collectBackStack(...args) : missing("collectBackStack"),
    collectForegroundIdentity: (...args: Parameters<D["collectForegroundIdentity"]>) =>
      seam.collectForegroundIdentity
        ? seam.collectForegroundIdentity(...args)
        : missing("collectForegroundIdentity"),
    collectForegroundSnapshot: (...args: Parameters<D["collectForegroundSnapshot"]>) =>
      seam.collectForegroundSnapshot
        ? seam.collectForegroundSnapshot(...args)
        : missing("collectForegroundSnapshot"),
    collectFocusedSystemUiSurface: (...args: Parameters<D["collectFocusedSystemUiSurface"]>) =>
      seam.collectFocusedSystemUiSurface
        ? seam.collectFocusedSystemUiSurface(...args)
        : missing("collectFocusedSystemUiSurface"),
    collectActiveWindow: (...args: Parameters<D["collectActiveWindow"]>) =>
      seam.collectActiveWindow ? seam.collectActiveWindow(...args) : missing("collectActiveWindow"),
  });
}
