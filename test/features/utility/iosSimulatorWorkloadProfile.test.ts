import { describe, expect, test } from "bun:test";
import {
  IOS_SIMULATOR_WORKLOAD_PROFILE_SCHEMA_VERSION,
  resolveIosSimulatorWorkloadProfile,
} from "../../../src/features/utility/iosSimulatorWorkloadProfile";

describe("iOS Simulator workload profiles", () => {
  test("resolves a versioned profile with a stable identity", () => {
    const resolved = resolveIosSimulatorWorkloadProfile({ profileId: "automation" });

    expect(resolved).toMatchObject({
      schemaVersion: IOS_SIMULATOR_WORKLOAD_PROFILE_SCHEMA_VERSION,
      profileId: "automation",
      suspendedServices: [
        "background-analytics",
        "background-search",
        "cloud-sync",
        "device-connectivity",
        "intelligence-services",
        "personal-information-sync",
        "photo-analysis",
        "store-services",
        "web-association",
        "widget-updates",
      ],
    });
    expect(resolved.identity).toMatch(/^ios-simulator-workload-v1-[a-f0-9]{16}$/);
  });

  test("keeps services required by declared capabilities, including shared services", () => {
    const resolved = resolveIosSimulatorWorkloadProfile({
      profileId: "automation",
      requiredCapabilities: ["push-notifications", "storekit", "universal-links"],
    });

    expect(resolved.suspendedServices).not.toContain("store-services");
    expect(resolved.suspendedServices).not.toContain("web-association");
    expect(resolved.retainedServices).toEqual(["store-services", "web-association"]);
  });

  test("deduplicates and orders requirements so equivalent input has the same identity", () => {
    const first = resolveIosSimulatorWorkloadProfile({
      profileId: "automation",
      requiredCapabilities: ["universal-links", "push-notifications", "push-notifications"],
    });
    const second = resolveIosSimulatorWorkloadProfile({
      profileId: "automation",
      requiredCapabilities: ["push-notifications", "universal-links"],
    });

    expect(first).toEqual(second);
  });

  test("rejects an unknown profile, capability, or service identifier", () => {
    expect(() => resolveIosSimulatorWorkloadProfile({ profileId: "fast" as "automation" })).toThrow(
      'Unknown iOS Simulator workload profile "fast".',
    );
    expect(() =>
      resolveIosSimulatorWorkloadProfile({
        profileId: "automation",
        requiredCapabilities: ["unknown" as "push-notifications"],
      }),
    ).toThrow('Unknown iOS Simulator workload capability "unknown".');
    expect(() =>
      resolveIosSimulatorWorkloadProfile({
        profileId: "automation",
        retainedServices: ["unknown" as "store-services"],
      }),
    ).toThrow('Unknown iOS Simulator managed service "unknown".');
  });
});
