import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AdbDeviceState } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const result = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

class SnapshotAdb extends FakeAdbExecutor {
  snapshotCalls: Array<{ at: number; timeoutMs: number }> = [];
  commandBudgets: Array<{ command: string; at: number; timeoutMs: number | undefined }> = [];
  snapshotAdvanceMs = 0;
  snapshotFailureCall: number | undefined;
  statesByCall: AdbDeviceState[][] | undefined;
  slowPackageManagerMs: number[] = [];

  constructor(
    private readonly timer: FakeTimer,
    private readonly states: AdbDeviceState[],
  ) {
    super();
    this.setCommandResponse("emu avd name", result("Pixel_9_Pro\n"));
    this.setCommandResponse("get-state", result("device\n"));
    this.setCommandResponse("shell pm list packages", result("package:android\n"));
    this.setCommandResponse("shell getprop sys.boot_completed", result("1\n"));
    this.setCommandResponse("shell getprop init.svc.bootanim", result("stopped\n"));
    this.setCommandResponse("shell getprop ro.product.model", result("sdk_gphone64_arm64\n"));
  }

  async getReadinessDeviceSnapshot(options: { timeoutMs: number }): Promise<{
    states: AdbDeviceState[];
    devices: BootedDevice[];
  }> {
    this.snapshotCalls.push({ at: this.timer.now(), timeoutMs: options.timeoutMs });
    this.timer.advanceTime(this.snapshotAdvanceMs);
    if (this.snapshotCalls.length === this.snapshotFailureCall) {
      throw new Error("adb devices timed out");
    }
    const states = this.statesByCall?.[this.snapshotCalls.length - 1] ?? this.states;
    return {
      states,
      devices: states
        .filter((state) => state.state === "device")
        .map(({ deviceId }) => ({ name: deviceId, platform: "android", deviceId })),
    };
  }

  override async getBootedAndroidDevices(): Promise<BootedDevice[]> {
    throw new Error("readiness must reuse the snapshot");
  }

  override async getDeviceStates(): Promise<AdbDeviceState[]> {
    throw new Error("offline detection must reuse the snapshot");
  }

  override async executeCommand(command: string, timeoutMs?: number): Promise<ExecResult> {
    this.commandBudgets.push({ command, at: this.timer.now(), timeoutMs });
    if (command === "shell pm list packages" && this.slowPackageManagerMs.length > 0) {
      const elapsedMs = this.slowPackageManagerMs.shift() ?? 0;
      this.timer.advanceTime(Math.min(elapsedMs, timeoutMs ?? elapsedMs));
      if (timeoutMs !== undefined && elapsedMs > timeoutMs) {
        throw new Error("package manager probe timed out");
      }
    }
    return super.executeCommand(command, timeoutMs);
  }
}

function clientWith(adb: SnapshotAdb, timer: FakeTimer): AndroidEmulatorClient {
  return new AndroidEmulatorClient(async () => result(), null, timer, { create: () => adb });
}

describe("emulator readiness ADB work budget", () => {
  test("a known target costs the same number of commands with one or many attached emulators", async () => {
    const counts: number[] = [];
    for (const count of [1, 40]) {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const states = Array.from({ length: count }, (_, index) => ({
        deviceId: `emulator-${5554 + index * 2}`,
        state: "device",
      }));
      const adb = new SnapshotAdb(timer, states);

      const device = await clientWith(adb, timer).waitForEmulatorReady(
        "Pixel_9_Pro",
        5_000,
        null,
        "emulator-5554",
      );

      expect(device.deviceId).toBe("emulator-5554");
      expect(adb.snapshotCalls).toHaveLength(1);
      counts.push(adb.commandBudgets.length);
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThan(15);
  });

  test("an unknown serial probes a fixed number of names per iteration", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const states = Array.from({ length: 40 }, (_, index) => ({
      deviceId: `emulator-${5554 + index * 2}`,
      state: "device",
    }));
    const adb = new SnapshotAdb(timer, states);

    await clientWith(adb, timer).waitForEmulatorReady("Pixel_9_Pro", 5_000);

    expect(adb.snapshotCalls).toHaveLength(1);
    expect(adb.commandBudgets.filter((call) => call.command === "emu avd name")).toHaveLength(4);
    expect(adb.commandBudgets.length).toBeLessThan(40);
  });

  test("every ADB timeout fits the remaining deadline after a slow snapshot", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new SnapshotAdb(timer, [{ deviceId: "emulator-5554", state: "device" }]);
    adb.snapshotAdvanceMs = 700;

    await clientWith(adb, timer).waitForEmulatorReady("Pixel_9_Pro", 1_000, null, "emulator-5554");

    expect(adb.commandBudgets.length).toBeGreaterThan(0);
    for (const call of [...adb.snapshotCalls, ...adb.commandBudgets]) {
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(1_000 - call.at);
      expect(call.timeoutMs).toBeLessThanOrEqual(10_000);
    }
  });

  test("a timed-out probe gets a fresh cap and a three-second retry reaches ready", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new SnapshotAdb(timer, [{ deviceId: "emulator-5554", state: "device" }]);
    adb.slowPackageManagerMs = [11_000, 3_000];

    const device = await clientWith(adb, timer).waitForEmulatorReady(
      "Pixel_9_Pro",
      25_000,
      null,
      "emulator-5554",
    );

    expect(device.deviceId).toBe("emulator-5554");
    expect(
      adb.commandBudgets
        .filter((call) => call.command === "shell pm list packages")
        .map((call) => call.timeoutMs),
    ).toEqual([10_000, 10_000]);
    expect(adb.snapshotCalls.every((call) => call.timeoutMs <= 10_000)).toBe(true);
  });

  test("a failed snapshot resets the offline fail-fast clock", async () => {
    const previousPollingInterval = process.env.EMULATOR_POLLING_INTERVAL_MS;
    process.env.EMULATOR_POLLING_INTERVAL_MS = "5000";
    try {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const adb = new SnapshotAdb(timer, [{ deviceId: "emulator-5554", state: "offline" }]);
      adb.snapshotFailureCall = 2;

      await expect(
        clientWith(adb, timer).waitForEmulatorReady(
          "Pixel_9_Pro",
          20_000,
          null,
          "emulator-5554",
          undefined,
          { freshProvision: true },
        ),
      ).rejects.toThrow();

      expect(adb.snapshotCalls.length).toBeGreaterThanOrEqual(3);
      expect(
        adb.getExecutedCommands().filter((command) => command.includes("reconnect offline")),
      ).toHaveLength(0);
    } finally {
      if (previousPollingInterval === undefined) {
        delete process.env.EMULATOR_POLLING_INTERVAL_MS;
      } else {
        process.env.EMULATOR_POLLING_INTERVAL_MS = previousPollingInterval;
      }
    }
  });

  test("does not begin target probes after discovery reaches the deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new SnapshotAdb(timer, [{ deviceId: "emulator-5554", state: "device" }]);
    adb.snapshotAdvanceMs = 100;

    await expect(
      clientWith(adb, timer).waitForEmulatorReady("Pixel_9_Pro", 100, null, "emulator-5554"),
    ).rejects.toThrow();

    expect(adb.snapshotCalls).toHaveLength(1);
    expect(adb.commandBudgets).toHaveLength(0);
  });

  test("an offline target remains offline in the final readiness error", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new SnapshotAdb(timer, [{ deviceId: "emulator-5554", state: "offline" }]);

    await expect(
      clientWith(adb, timer).waitForEmulatorReady("Pixel_9_Pro", 100, null, "emulator-5554"),
    ).rejects.toThrow("target=emulator-5554; state=offline");
    expect(adb.snapshotCalls.length).toBeGreaterThan(0);
  });

  test("resolves a newly started emulator by AVD name when its serial is unknown", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const discovery = new SnapshotAdb(
      timer,
      Array.from({ length: 5 }, (_, index) => ({
        deviceId: `emulator-${5554 + index * 2}`,
        state: "device",
      })),
    );
    const other = new FakeAdbExecutor();
    other.setCommandResponse("emu avd name", result("Other_AVD\n"));
    const target = new FakeAdbExecutor();
    target.setCommandResponse("emu avd name", result("Pixel_9_Pro\n"));
    target.setCommandResponse("get-state", result("device\n"));
    target.setCommandResponse("shell pm list packages", result("package:android\n"));
    target.setCommandResponse("shell getprop sys.boot_completed", result("1\n"));
    target.setCommandResponse("shell getprop init.svc.bootanim", result("stopped\n"));
    const client = new AndroidEmulatorClient(async () => result(), null, timer, {
      create: (device) =>
        device?.deviceId === "emulator-5562" ? target : device ? other : discovery,
    });

    const device = await client.waitForEmulatorReady("Pixel_9_Pro", 5_000);

    expect(device.deviceId).toBe("emulator-5562");
    expect(discovery.snapshotCalls).toHaveLength(2);
    expect(other.wasCommandExecuted("emu avd name")).toBe(true);
    expect(target.wasCommandExecuted("emu avd name")).toBe(true);
  });

  test("probes each serial once per cycle when another emulator joins", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const initialStates = Array.from({ length: 9 }, (_, index) => ({
      deviceId: `emulator-${5554 + index * 2}`,
      state: "device",
    }));
    const joinedStates = [{ deviceId: "emulator-5572", state: "device" }, ...initialStates];
    const discovery = new SnapshotAdb(timer, initialStates);
    discovery.statesByCall = [initialStates, joinedStates, joinedStates];
    const clients = new Map<string, FakeAdbExecutor>();
    for (const state of joinedStates) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "emu avd name",
        result(state.deviceId === "emulator-5570" ? "Pixel_9_Pro\n" : "Other_AVD\n"),
      );
      adb.setCommandResponse("get-state", result("device\n"));
      adb.setCommandResponse("shell pm list packages", result("package:android\n"));
      adb.setCommandResponse("shell getprop sys.boot_completed", result("1\n"));
      adb.setCommandResponse("shell getprop init.svc.bootanim", result("stopped\n"));
      clients.set(state.deviceId, adb);
    }
    const client = new AndroidEmulatorClient(async () => result(), null, timer, {
      create: (device) => (device ? clients.get(device.deviceId)! : discovery),
    });

    const device = await client.waitForEmulatorReady("Pixel_9_Pro", 5_000);

    expect(device.deviceId).toBe("emulator-5570");
    expect(discovery.snapshotCalls).toHaveLength(3);
    expect(
      clients
        .get("emulator-5560")
        ?.getExecutedCommands()
        .filter((command) => command === "emu avd name"),
    ).toHaveLength(1);
    expect(clients.get("emulator-5572")?.wasCommandExecuted("emu avd name")).toBe(true);
  });

  test("unresolved names cannot starve an unprobed target later in the snapshot", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const states = Array.from({ length: 10 }, (_, index) => ({
      deviceId: `emulator-${5554 + index * 2}`,
      state: "device",
    }));
    const discovery = new SnapshotAdb(timer, states);
    const clients = new Map<string, FakeAdbExecutor>();
    for (const [index, state] of states.entries()) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "emu avd name",
        result(index < 4 ? "" : index === 8 ? "Pixel_9_Pro\n" : "Other_AVD\n"),
      );
      clients.set(state.deviceId, adb);
    }
    const target = clients.get(states[8]!.deviceId)!;
    target.setCommandResponse("get-state", result("device\n"));
    target.setCommandResponse("shell pm list packages", result("package:android\n"));
    target.setCommandResponse("shell getprop sys.boot_completed", result("1\n"));
    target.setCommandResponse("shell getprop init.svc.bootanim", result("stopped\n"));
    const client = new AndroidEmulatorClient(async () => result(), null, timer, {
      create: (device) => (device ? clients.get(device.deviceId)! : discovery),
    });

    const device = await client.waitForEmulatorReady("Pixel_9_Pro", 5_000);

    expect(device.deviceId).toBe(states[8]!.deviceId);
    expect(discovery.snapshotCalls.length).toBeLessThanOrEqual(Math.ceil(states.length / 4) + 1);
  });

  test("retries an empty AVD name on the next iteration", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const discovery = new SnapshotAdb(timer, [
      { deviceId: "emulator-5554", state: "device" },
      ...Array.from({ length: 5 }, (_, index) => ({
        deviceId: `emulator-${5556 + index * 2}`,
        state: "device",
      })),
    ]);
    const target = new FakeAdbExecutor();
    target.setCommandResponseSequence("emu avd name", [result(""), result("Pixel_9_Pro\n")]);
    target.setCommandResponse("get-state", result("device\n"));
    target.setCommandResponse("shell pm list packages", result("package:android\n"));
    target.setCommandResponse("shell getprop sys.boot_completed", result("1\n"));
    target.setCommandResponse("shell getprop init.svc.bootanim", result("stopped\n"));
    const other = new FakeAdbExecutor();
    other.setCommandResponse("emu avd name", result("Other_AVD\n"));
    const client = new AndroidEmulatorClient(async () => result(), null, timer, {
      create: (device) =>
        device?.deviceId === "emulator-5554" ? target : device ? other : discovery,
    });

    const device = await client.waitForEmulatorReady("Pixel_9_Pro", 5_000);

    expect(device.deviceId).toBe("emulator-5554");
    expect(discovery.snapshotCalls).toHaveLength(2);
    expect(
      target.getExecutedCommands().filter((command) => command === "emu avd name"),
    ).toHaveLength(2);
  });
});
