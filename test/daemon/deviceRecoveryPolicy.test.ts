import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS,
  isAndroidEmulatorSessionContinuityEnabled,
  parseDeviceRecoveryPolicy,
} from "../../src/daemon/poolConfig";

describe("device recovery policy", () => {
  test("keeps broad recovery disabled while session continuity defaults on", () => {
    expect(parseDeviceRecoveryPolicy({})).toEqual({
      policy: {
        onLoss: false,
        maxAttempts: DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS,
      },
      warnings: [],
    });
    expect(isAndroidEmulatorSessionContinuityEnabled({})).toBe(true);
  });

  test("accepts only strict binary and base-ten integer values", () => {
    expect(
      parseDeviceRecoveryPolicy({
        AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS: "1",
        AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS: "3",
      }),
    ).toEqual({
      policy: {
        onLoss: true,
        maxAttempts: 3,
      },
      warnings: [],
    });
  });

  test("keeps zero as an explicit opt-out", () => {
    const env = { AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS: "0" };
    expect(parseDeviceRecoveryPolicy(env).policy).toEqual({
      onLoss: false,
      maxAttempts: DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS,
    });
    expect(isAndroidEmulatorSessionContinuityEnabled(env)).toBe(false);
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
    expect(
      parseDeviceRecoveryPolicy({
        AUTOMOBILE_ANDROID_REBOOT_ON_DEATH: "1",
      }).policy,
    ).toEqual({
      onLoss: true,
      maxAttempts: DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS,
    });
  });
});
