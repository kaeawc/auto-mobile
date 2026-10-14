import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";

/** Capture and restore the factory's raw singleton and injection state. */
export function snapshotPlatformDeviceManagerFactory(): () => void {
  const instance = Reflect.get(PlatformDeviceManagerFactory, "instance");
  const injectedManager = Reflect.get(PlatformDeviceManagerFactory, "injectedManager");
  const injectedAdbFactory = Reflect.get(PlatformDeviceManagerFactory, "injectedAdbFactory");

  return () => {
    Reflect.set(PlatformDeviceManagerFactory, "instance", instance);
    Reflect.set(PlatformDeviceManagerFactory, "injectedManager", injectedManager);
    Reflect.set(PlatformDeviceManagerFactory, "injectedAdbFactory", injectedAdbFactory);
  };
}
