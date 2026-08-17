import { describe, expect, it } from "bun:test";
import { CiIosBootRecovery } from "../../src/utils/deviceBootRecovery";
import type { DeviceInfo } from "../../src/models";

describe("CiIosBootRecovery", () => {
  const target: DeviceInfo = {
    name: "AutoMobile CI iPhone",
    platform: "ios",
    deviceId: "CI-UDID",
    isRunning: false,
  };

  it("does not recover an owned simulator after cancellation", async () => {
    const controller = new AbortController();
    const recovered: string[] = [];
    const recovery = new CiIosBootRecovery({
      ownedSimulatorName: target.name,
      shutdown: async () => {
        recovered.push("shutdown");
      },
      erase: async () => {
        recovered.push("erase");
      },
    });
    controller.abort();

    await expect(
      recovery.run(
        target,
        async () => {
          throw new Error("cancelled boot");
        },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled boot");

    expect(recovered).toEqual([]);
  });
});
