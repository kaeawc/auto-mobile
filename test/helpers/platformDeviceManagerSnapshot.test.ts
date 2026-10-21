import { afterEach, expect, test } from "bun:test";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { snapshotPlatformDeviceManagerFactory } from "./platformDeviceManagerSnapshot";

afterEach(() => PlatformDeviceManagerFactory.reset());

test("restores the raw factory state including captured null values", () => {
  PlatformDeviceManagerFactory.reset();
  const restore = snapshotPlatformDeviceManagerFactory();
  const fake = new FakeDeviceManager();
  PlatformDeviceManagerFactory.setInstance(fake);
  expect(Reflect.get(PlatformDeviceManagerFactory, "injectedManager")).toBe(fake);
  restore();
  expect(Reflect.get(PlatformDeviceManagerFactory, "instance")).toBeNull();
  expect(Reflect.get(PlatformDeviceManagerFactory, "injectedManager")).toBeNull();
  expect(Reflect.get(PlatformDeviceManagerFactory, "injectedAdbFactory")).toBeNull();
});
