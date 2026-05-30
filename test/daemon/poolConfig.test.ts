import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isDevicePoolAutolockEnabled, getDevicePoolTimeoutMs } from "../../src/daemon/poolConfig";

const ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
  "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("poolConfig autolock", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("isDevicePoolAutolockEnabled defaults to false", () => {
    expect(isDevicePoolAutolockEnabled()).toBe(false);
  });

  it("isDevicePoolAutolockEnabled is true only for '1'", () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    expect(isDevicePoolAutolockEnabled()).toBe(true);

    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "true";
    expect(isDevicePoolAutolockEnabled()).toBe(false);

    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "0";
    expect(isDevicePoolAutolockEnabled()).toBe(false);
  });

  it("isDevicePoolAutolockEnabled honors the AUTO_MOBILE_ alias", () => {
    process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK = "1";
    expect(isDevicePoolAutolockEnabled()).toBe(true);
  });

  it("getDevicePoolTimeoutMs defaults to 60 seconds", () => {
    expect(getDevicePoolTimeoutMs()).toBe(60_000);
  });

  it("getDevicePoolTimeoutMs converts seconds to milliseconds", () => {
    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "120";
    expect(getDevicePoolTimeoutMs()).toBe(120_000);
  });

  it("getDevicePoolTimeoutMs ignores invalid or non-positive values", () => {
    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "not-a-number";
    expect(getDevicePoolTimeoutMs()).toBe(60_000);

    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "0";
    expect(getDevicePoolTimeoutMs()).toBe(60_000);

    process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "-5";
    expect(getDevicePoolTimeoutMs()).toBe(60_000);
  });
});
