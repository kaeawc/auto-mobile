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

  it("stops recovery when cancellation arrives during shutdown", async () => {
    const controller = new AbortController();
    let markShutdownStarted!: () => void;
    let releaseShutdown!: () => void;
    const shutdownStarted = new Promise<void>((resolve) => {
      markShutdownStarted = resolve;
    });
    const pendingShutdown = new Promise<void>((resolve) => {
      releaseShutdown = () => {
        resolve();
      };
    });
    let bootAttempts = 0;
    const recovered: string[] = [];
    const recovery = new CiIosBootRecovery({
      ownedSimulatorName: target.name,
      shutdown: async () => {
        markShutdownStarted();
        await pendingShutdown;
      },
      erase: async () => {
        recovered.push("erase");
      },
    });

    const boot = recovery.run(
      target,
      async () => {
        bootAttempts++;
        throw new Error("boot failed");
      },
      controller.signal,
    );
    await shutdownStarted;
    controller.abort();

    await expect(boot).rejects.toThrow(
      "startDevice cancelled while recovering the CI iOS simulator",
    );
    expect(recovered).toEqual([]);
    expect(bootAttempts).toBe(1);

    releaseShutdown();
    await Promise.resolve();
    expect(recovered).toEqual([]);
  });

  it("reports cancellation rather than the first failure during the recovery retry", async () => {
    const controller = new AbortController();
    let markRetryStarted!: () => void;
    let rejectRetry!: (error: unknown) => void;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    const pendingRetry = new Promise<string>((_resolve, reject) => {
      rejectRetry = reject;
    });
    const recovered: string[] = [];
    let bootAttempts = 0;
    const recovery = new CiIosBootRecovery({
      ownedSimulatorName: target.name,
      shutdown: async () => {
        recovered.push("shutdown");
      },
      erase: async () => {
        recovered.push("erase");
      },
    });

    const boot = recovery.run(
      target,
      async () => {
        bootAttempts++;
        if (bootAttempts === 1) {
          throw new Error("first boot failed");
        }
        markRetryStarted();
        return pendingRetry;
      },
      controller.signal,
    );
    await retryStarted;
    controller.abort();
    rejectRetry(controller.signal.reason);

    await expect(boot).rejects.toThrow(
      "startDevice cancelled while recovering the CI iOS simulator",
    );
    expect(recovered).toEqual(["shutdown", "erase"]);
    expect(bootAttempts).toBe(2);
  });
});
