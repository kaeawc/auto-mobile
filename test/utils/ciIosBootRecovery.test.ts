import { describe, expect, it } from "bun:test";
import {
  CiIosBootRecovery,
  createCiIosBootConfiguration,
  isGitHubActionsCi,
  NoopDeviceBootRecovery,
  normalizeCiIosBootRequest,
  shouldUseCiIosBootRecovery,
} from "../../src/utils/deviceBootRecovery";
import type { DeviceInfo } from "../../src/models";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../src/utils/execResult";
import { FakeTimer } from "../fakes/FakeTimer";

const owned: DeviceInfo = {
  name: "AutoMobile CI iPhone (26.3)",
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

  it("uses a max-only runtime bound when naming the CI-owned simulator", async () => {
    const calls: string[] = [];
    const simctl = new SimCtlClient(
      null,
      async (file, args) => {
        const command = `${file} ${args.join(" ")}`;
        calls.push(command);
        if (command === "xcrun simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (command === "xcrun simctl list devicetypes --json") {
          return createExecResult(
            JSON.stringify({
              devicetypes: [
                {
                  name: "iPhone 16",
                  identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
                  productFamily: "iPhone",
                  minRuntimeVersionString: "18.0",
                  maxRuntimeVersionString: "99.0",
                  minRuntimeVersion: 0,
                  maxRuntimeVersion: 0,
                },
              ],
            }),
            "",
          );
        }
        if (command === "xcrun simctl list runtimes iOS --json") {
          return createExecResult(
            JSON.stringify({
              runtimes: [
                {
                  version: "18.2.0",
                  identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
                  name: "iOS 18.2.0",
                  isAvailable: true,
                },
              ],
            }),
            "",
          );
        }
        if (command === "xcrun --sdk iphonesimulator --show-sdk-version") {
          return createExecResult("26.3\n", "");
        }
        return createExecResult("", "");
      },
      new FakeTimer(),
      "darwin",
    );

    const configuration = await createCiIosBootConfiguration(
      { platform: "ios", maxOsVersion: "18.2" },
      { CI: "true", GITHUB_ACTIONS: "true" },
      { simctl },
    );

    expect(configuration?.request.name).toBe("AutoMobile CI iPhone (18.2)");
    expect(calls).not.toContain("xcrun --sdk iphonesimulator --show-sdk-version");
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
