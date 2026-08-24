import { describe, expect, it } from "bun:test";
import {
  CiIosBootRecovery,
  isGitHubActionsCi,
  NoopDeviceBootRecovery,
  normalizeCiIosBootRequest,
  shouldUseCiIosBootRecovery,
} from "../../src/utils/deviceBootRecovery";
import type { DeviceInfo } from "../../src/models";

const owned: DeviceInfo = {
  name: "AutoMobile CI iPhone (com.apple.CoreSimulator.SimRuntime.iOS-26-3)",
  platform: "ios",
  deviceId: "CI-UDID",
  isRunning: false,
};

describe("CI iOS boot recovery", () => {
  it("activates only under both GitHub Actions CI markers", () => {
    expect(isGitHubActionsCi({ CI: "true" })).toBe(false);
    expect(isGitHubActionsCi({ CI: "true", GITHUB_ACTIONS: "true" })).toBe(true);
  });

  it("does not replace an explicitly targeted CI simulator", () => {
    const environment = { CI: "true", GITHUB_ACTIONS: "true" };
    expect(shouldUseCiIosBootRecovery({ platform: "ios" }, environment)).toBe(true);
    expect(shouldUseCiIosBootRecovery({ platform: "ios", name: "My Simulator" }, environment)).toBe(
      false,
    );
    expect(
      shouldUseCiIosBootRecovery({ platform: "ios", deviceId: "personal-udid" }, environment),
    ).toBe(false);
  });

  it("matches the resolved CI-owned runtime name without changing provisioning SDK bounds", () => {
    expect(
      normalizeCiIosBootRequest(
        {
          platform: "ios",
          minOsVersion: "26.3",
          maxOsVersion: "26.3",
        },
        owned.name,
      ),
    ).toEqual({
      platform: "ios",
      name: owned.name,
      minOsVersion: "26.3",
      maxOsVersion: "26.3",
      matchNamedDeviceIgnoringOsVersion: true,
    });
  });

  it("leaves ordinary product boot as a single no-op attempt", async () => {
    let attempts = 0;

    await expect(
      new NoopDeviceBootRecovery().run(owned, async () => {
        attempts++;
        throw new Error("bootstatus timed out");
      }),
    ).rejects.toThrow("bootstatus timed out");

    expect(attempts).toBe(1);
  });

  it("shuts down and erases only its owned simulator before the final retry", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const recovery = new CiIosBootRecovery({
      ownedSimulatorName: owned.name,
      shutdown: async (target) => {
        calls.push(`shutdown:${target.deviceId}`);
      },
      erase: async (udid) => {
        calls.push(`erase:${udid}`);
      },
    });

    const result = await recovery.run(owned, async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("bootstatus timed out");
      }
      return "booted";
    });

    expect(result).toBe("booted");
    expect(calls).toEqual(["shutdown:CI-UDID", "erase:CI-UDID"]);
  });

  it("does not erase a simulator outside the CI-owned target", async () => {
    const calls: string[] = [];
    const recovery = new CiIosBootRecovery({
      ownedSimulatorName: owned.name,
      shutdown: async (target) => {
        calls.push(`shutdown:${target.deviceId}`);
      },
      erase: async (udid) => {
        calls.push(`erase:${udid}`);
      },
    });
    const unowned = { ...owned, name: "Personal iPhone" };
    let attempts = 0;

    await expect(
      recovery.run(unowned, async () => {
        attempts++;
        throw new Error("bootstatus timed out");
      }),
    ).rejects.toThrow("bootstatus timed out");

    expect(attempts).toBe(1);
    expect(calls).toEqual([]);
  });
});
