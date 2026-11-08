import { describe, expect, test } from "bun:test";
import { canDiscoverIosLocally } from "../../src/devices/iosLocalDiscovery";

describe("canDiscoverIosLocally", () => {
  test("macOS never probes simctl", async () => {
    let probes = 0;
    const simctl = { isAvailable: async () => (probes += 1) > 0 };
    expect(await canDiscoverIosLocally(simctl, undefined, "darwin")).toBe(true);
    expect(probes).toBe(0);
  });

  test("elsewhere a failed probe means no local iOS discovery", async () => {
    const simctl = {
      isAvailable: async (): Promise<boolean> => {
        throw new Error("xcrun: not found");
      },
    };
    expect(await canDiscoverIosLocally(simctl, undefined, "linux")).toBe(false);
  });

  test("an aborted caller propagates instead of reporting unavailable", async () => {
    const controller = new AbortController();
    controller.abort();
    const simctl = { isAvailable: async () => true };
    await expect(canDiscoverIosLocally(simctl, controller.signal, "linux")).rejects.toThrow();
  });
});
