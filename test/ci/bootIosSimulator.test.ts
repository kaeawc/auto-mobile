import { describe, expect, it } from "bun:test";
import { bootCiIosSimulator, isGitHubActionsCi, type CiIosBootDependencies } from "../../src/ci/bootIosSimulator";
import type { DeviceInfo } from "../../src/models";

const target: DeviceInfo = { name: "AutoMobile CI iPhone", platform: "ios", deviceId: "CI-UDID", isRunning: false };

function fake(overrides: Partial<CiIosBootDependencies> = {}): CiIosBootDependencies {
  return {
    isCi: () => true,
    findOwnedSimulator: async () => target,
    createOwnedSimulator: async () => target,
    boot: async () => ({ deviceId: "CI-UDID", name: target.name }),
    shutdown: async () => {},
    erase: async () => {},
    ...overrides,
  };
}

describe("CI iOS simulator boot", () => {
  it("does not expose the erase recovery outside CI", async () => {
    await expect(bootCiIosSimulator({}, fake({ isCi: () => false }))).rejects.toThrow("restricted to CI");
  });

  it("requires the GitHub Actions CI markers, not merely CI=true", () => {
    expect(isGitHubActionsCi({ CI: "true" })).toBe(false);
    expect(isGitHubActionsCi({ CI: "true", GITHUB_ACTIONS: "true" })).toBe(true);
  });

  it("erases only the owned target before the final retry", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const result = await bootCiIosSimulator({ maxAttempts: 2 }, fake({
      boot: async () => {
        attempts++;
        if (attempts === 1) { throw new Error("wedged"); }
        return { deviceId: "CI-UDID", name: target.name };
      },
      shutdown: async device => { calls.push(`shutdown:${device.deviceId}`); },
      erase: async device => { calls.push(`erase:${device.deviceId}`); },
    }));
    expect(result.deviceId).toBe("CI-UDID");
    expect(calls).toEqual(["shutdown:CI-UDID", "erase:CI-UDID"]);
  });

  it("continues to the final boot attempt when cleanup commands fail", async () => {
    let attempts = 0;
    const result = await bootCiIosSimulator({ maxAttempts: 2 }, fake({
      boot: async () => {
        attempts++;
        if (attempts === 1) { throw new Error("wedged"); }
        return { deviceId: "CI-UDID", name: target.name };
      },
      shutdown: async () => { throw new Error("already shutdown"); },
      erase: async () => { throw new Error("erase transient failure"); },
    }));
    expect(result.deviceId).toBe("CI-UDID");
    expect(attempts).toBe(2);
  });
});
