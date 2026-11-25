import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CiIosBootRecovery } from "../../src/devices/deviceBootRecovery";
import { ActionableError, type DeviceInfo } from "../../src/models";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";

// Verbatim simctl stderr captured for #14116 (see test/fixtures/ios-simctl/README.md).
function captured(name: string): string {
  return readFileSync(join(import.meta.dir, "../fixtures/ios-simctl/failures", name), "utf8");
}

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

  // #11181: no capacity is freed by erasing the simulator that could not get a slot.
  it("does not shut down or erase an owned simulator refused for capacity", async () => {
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
    const refusal = new BootCapacityExhaustedError(
      { platform: "ios", limit: 1, booted: 1, retryAfterMs: 5_000 },
      "no simulator capacity",
    );

    await expect(
      recovery.run(target, async () => {
        bootAttempts++;
        throw refusal;
      }),
    ).rejects.toBe(refusal);

    expect(recovered).toEqual([]);
    expect(bootAttempts).toBe(1);
  });

  function recordingRecovery(recovered: string[]): CiIosBootRecovery {
    return new CiIosBootRecovery({
      ownedSimulatorName: target.name,
      shutdown: async () => {
        recovered.push("shutdown");
      },
      erase: async () => {
        recovered.push("erase");
      },
    });
  }

  /** A boot failure the way the boot path surfaces it: a wrapper whose cause is the exec failure. */
  function wrappedBootFailure(exitCode: number, stderr: string): ActionableError {
    const execFailure = Object.assign(new Error(`Command failed with exit code ${exitCode}`), {
      code: exitCode,
      stderr,
    });
    return new ActionableError("Simulator CI-UDID failed to become ready", { cause: execFailure });
  }

  // #14116: erasing cannot fix a device simctl does not know or a host out of resources, so
  // recovery stops at the first failure instead of shutting down, erasing and booting again.
  it.each([
    ["an unknown device", wrappedBootFailure(148, captured("boot-invalid-device.stderr.txt"))],
    [
      "host resource exhaustion",
      wrappedBootFailure(
        1,
        "The current system settings are not sufficient to allow booting additional simulators: maxFiles",
      ),
    ],
  ])("does not shut down or erase the owned simulator for %s", async (_name, failure) => {
    const recovered: string[] = [];
    let bootAttempts = 0;

    await expect(
      recordingRecovery(recovered).run(target, async () => {
        bootAttempts++;
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(recovered).toEqual([]);
    expect(bootAttempts).toBe(1);
  });

  // #14116: a launchd_sim bind failure is a runtime boot timeout, not broken device data, so
  // the owned simulator is shut down and booted again without erasing it.
  it("retries a launchd_sim bind failure after shutdown without erasing", async () => {
    const recovered: string[] = [];
    let bootAttempts = 0;
    const failure = wrappedBootFailure(1, "launchd_sim could not bind to session");

    await expect(
      recordingRecovery(recovered).run(target, async () => {
        bootAttempts++;
        if (bootAttempts === 1) {
          throw failure;
        }
        return "booted";
      }),
    ).resolves.toBe("booted");

    expect(recovered).toEqual(["shutdown"]);
    expect(bootAttempts).toBe(2);
  });

  it("still erases the owned simulator when its data is missing on disk", async () => {
    const recovered: string[] = [];
    let bootAttempts = 0;
    const failure = wrappedBootFailure(2, captured("boot-data-missing-on-disk.stderr.txt"));

    await expect(
      recordingRecovery(recovered).run(target, async () => {
        bootAttempts++;
        if (bootAttempts === 1) {
          throw failure;
        }
        return "booted";
      }),
    ).resolves.toBe("booted");

    expect(recovered).toEqual(["shutdown", "erase"]);
    expect(bootAttempts).toBe(2);
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
