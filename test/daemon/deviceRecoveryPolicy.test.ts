import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS,
  parseDeviceRecoveryPolicy,
} from "../../src/daemon/poolConfig";

describe("device recovery policy", () => {
  test("defaults to disabled recovery with the existing two-attempt budget", () => {
    expect(parseDeviceRecoveryPolicy({})).toEqual({
      policy: {
        onLoss: false,
        maxAttempts: DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS,
      },
      warnings: [],
    });
  });

  test("accepts only strict binary and base-ten integer values", () => {
    expect(parseDeviceRecoveryPolicy({
      AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS: "1",
      AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS: "3",
    })).toEqual({
      policy: {
        onLoss: true,
        maxAttempts: 3,
      },
      warnings: [],
    });
  });

  test.each([
    {
      name: "padded enablement value",
      env: { AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS: " 1 " },
    },
    {
      name: "boolean word",
      env: { AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS: "true" },
    },
    {
      name: "fractional attempt budget",
      env: { AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS: "1.5" },
    },
    {
      name: "zero attempt budget",
      env: { AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS: "0" },
    },
    {
      name: "unbounded attempt budget",
      env: { AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS: "999" },
    },
  ])("falls back safely and reports a warning for $name", ({ env }) => {
    const result = parseDeviceRecoveryPolicy(env);

    expect(result.policy).toEqual({
      onLoss: false,
      maxAttempts: DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS,
    });
    expect(result.warnings).toHaveLength(1);
  });

  test("honors the legacy Android recovery setting during migration", () => {
    expect(parseDeviceRecoveryPolicy({
      AUTOMOBILE_ANDROID_REBOOT_ON_DEATH: "1",
    }).policy).toEqual({
      onLoss: true,
      maxAttempts: DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS,
    });
  });
});
