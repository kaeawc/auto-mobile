import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { ExecResult, BootedDevice } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { Readable } from "stream";

class TestAdbClientFactory implements AdbClientFactory {
  constructor(private readonly fakeExecutor: FakeAdbExecutor) {}

  create(_device?: BootedDevice | null): AdbExecutor {
    return this.fakeExecutor;
  }
}

class DeviceScopedAdbExecutor extends FakeAdbExecutor {
  constructor(
    private readonly device: BootedDevice | null,
    private readonly factory: DeviceScopedAdbClientFactory,
  ) {
    super();
  }

  async getBootedAndroidDevices(): Promise<BootedDevice[]> {
    return this.factory.nextDevices();
  }

  async executeCommand(command: string): Promise<ExecResult> {
    this.factory.commandLog.push(`${this.device?.deviceId ?? "global"}:${command}`);
    if (command === "emu avd name") {
      return createExecResult(this.factory.getAvdName(this.device?.deviceId));
    }
    if (command === "shell getprop ro.product.model") {
      return createExecResult("");
    }
    if (command === "get-state") {
      return createExecResult("device\n");
    }
    if (command === "shell pm list packages") {
      return createExecResult("package:android\n");
    }
    if (command === "shell getprop sys.boot_completed") {
      return createExecResult("1\n");
    }
    if (command === "shell getprop init.svc.bootanim") {
      return createExecResult("stopped\n");
    }
    return createExecResult("");
  }
}

class DeviceScopedAdbClientFactory implements AdbClientFactory {
  readonly commandLog: string[] = [];
  private readonly deviceScans: BootedDevice[][];
  private scanIndex = 0;

  constructor(
    devices: BootedDevice[] | BootedDevice[][],
    private readonly avdNamesByDeviceId = new Map<string, string>(),
  ) {
    const firstScan = devices[0];
    this.deviceScans = Array.isArray(firstScan)
      ? devices as BootedDevice[][]
      : [devices as BootedDevice[]];
  }

  create(device?: BootedDevice | null): AdbExecutor {
    return new DeviceScopedAdbExecutor(device ?? null, this);
  }

  nextDevices(): BootedDevice[] {
    const devices = this.deviceScans[Math.min(this.scanIndex, this.deviceScans.length - 1)] ?? [];
    this.scanIndex += 1;
    return devices;
  }

  getAvdName(deviceId: string | undefined): string {
    return deviceId ? this.avdNamesByDeviceId.get(deviceId) ?? "" : "";
  }
}

class FailingDeviceScanExecutor extends FakeAdbExecutor {
  async getBootedAndroidDevices(): Promise<BootedDevice[]> {
    throw new Error("adb discovery failed");
  }
}

type CorrelatedTestChildProcess = ChildProcess & EventEmitter & {
  autoMobileEmulatorLaunch?: {
    bootedDeviceIdsBeforeLaunch: readonly string[];
  };
};

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

const mockExecAsync = async (_command: string): Promise<ExecResult> => {
  return createExecResult("", "");
};

/** Prevent ensureEmulatorPath from running real filesystem/shell detection */
function skipEmulatorPathDetection(client: AndroidEmulatorClient): void {
  (client as any).ensureEmulatorPath = async () => "emulator";
}

describe("AndroidEmulatorClient detectCorruptImage", () => {
  let client: AndroidEmulatorClient;

  beforeEach(() => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new FakeAdbExecutor();
    const fakeFactory = new TestAdbClientFactory(fakeAdb);
    client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, fakeFactory);
  });

  test("detects qcow2 corrupt image", () => {
    const output = `qcow2: Image is corrupt; cannot be opened read/write
WARNING | QEMU main loop exits abnormally with code 1`;

    const result = client.detectCorruptImage(output);
    expect(result.isCorrupt).toBe(true);
    expect(result.message).toContain("corrupt");
    expect(result.suggestion).toContain("userdata");
  });

  test("detects generic disk image open failure", () => {
    const output = "cannot open disk image /path/to/some.img";

    const result = client.detectCorruptImage(output);
    expect(result.isCorrupt).toBe(true);
    expect(result.message).toContain("Disk image error");
  });

  test("detects corrupt disk image variant", () => {
    const output = "disk image userdata-qemu.img is corrupt";

    const result = client.detectCorruptImage(output);
    expect(result.isCorrupt).toBe(true);
    expect(result.message).toContain("Disk image error");
  });

  test("detects QEMU abnormal exit with corruption context", () => {
    const output = `some stuff
qcow2 header invalid
WARNING | QEMU main loop exits abnormally with code 1`;

    const result = client.detectCorruptImage(output);
    expect(result.isCorrupt).toBe(true);
    expect(result.message).toContain("QEMU exited abnormally");
  });

  test("returns false for normal output", () => {
    const output = `INFO | emuDirName: Pixel_9_Pro
Hax is enabled
Detected GPU type: host`;

    const result = client.detectCorruptImage(output);
    expect(result.isCorrupt).toBe(false);
    expect(result.message).toBeUndefined();
  });

  test("returns false for empty output", () => {
    const result = client.detectCorruptImage("");
    expect(result.isCorrupt).toBe(false);
  });

  test("returns false for QEMU abnormal exit without corruption context", () => {
    const output = "WARNING | QEMU main loop exits abnormally with code 1";

    const result = client.detectCorruptImage(output);
    expect(result.isCorrupt).toBe(false);
  });
});

describe("AndroidEmulatorClient startEmulator corrupt image integration", () => {
  let fakeTimer: FakeTimer;
  let fakeAdb: FakeAdbExecutor;
  let fakeFactory: TestAdbClientFactory;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    fakeAdb = new FakeAdbExecutor();
    fakeFactory = new TestAdbClientFactory(fakeAdb);
  });

  function createFakeChildProcess(): ChildProcess & EventEmitter {
    const emitter = new EventEmitter() as ChildProcess & EventEmitter;
    emitter.stdout = new Readable({ read() {} }) as any;
    emitter.stderr = new Readable({ read() {} }) as any;
    emitter.killed = false;
    emitter.pid = 1234;
    emitter.kill = () => { emitter.killed = true; return true; };
    return emitter;
  }

  test("rejects with actionable error when qcow2 corruption detected in stderr during startup", async () => {
    const fakeChild = createFakeChildProcess();

    const spawnFn = ((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        fakeChild.stderr!.emit("data", Buffer.from("qcow2: Image is corrupt; cannot be opened read/write\n"));
        fakeChild.stderr!.emit("data", Buffer.from("WARNING | QEMU main loop exits abnormally with code 1\n"));
        fakeChild.emit("exit", 1);
      });
      return fakeChild;
    }) as any;

    const execAsync = async (command: string): Promise<ExecResult> => {
      if (command.includes("-list-avds")) {
        return createExecResult("Pixel_9_Pro\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, spawnFn, fakeTimer, fakeFactory);
    skipEmulatorPathDetection(client);

    try {
      await client.startEmulator("Pixel_9_Pro");
      expect(true).toBe(false); // Should not reach here
    } catch (error: any) {
      expect(error.message).toContain("corrupt");
      expect(error.message).toContain("Suggestion");
      expect(error.message).toContain("userdata");
    }
  });

  test("rejects with exit code when emulator exits non-zero without known error pattern", async () => {
    const fakeChild = createFakeChildProcess();

    const spawnFn = ((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        fakeChild.stderr!.emit("data", Buffer.from("some random error\n"));
        fakeChild.emit("exit", 1);
      });
      return fakeChild;
    }) as any;

    const execAsync = async (command: string): Promise<ExecResult> => {
      if (command.includes("-list-avds")) {
        return createExecResult("Pixel_9_Pro\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, spawnFn, fakeTimer, fakeFactory);
    skipEmulatorPathDetection(client);

    try {
      await client.startEmulator("Pixel_9_Pro");
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toContain("exited with code: 1");
    }
  });

  test("attaches the pre-launch emulator device set to the spawned child process", async () => {
    const fakeChild = createFakeChildProcess();
    const spawnFn = ((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        fakeChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));
      });
      return fakeChild;
    }) as any;

    const execAsync = async (command: string): Promise<ExecResult> => {
      if (command.includes("-list-avds")) {
        return createExecResult("Pixel_9_Pro\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    fakeAdb.setDevices([
      { name: "Unknown (emulator-5554)", platform: "android", deviceId: "emulator-5554" },
    ]);
    const client = new AndroidEmulatorClient(execAsync, spawnFn, fakeTimer, fakeFactory);
    skipEmulatorPathDetection(client);

    const child = await client.startEmulator("Pixel_9_Pro");

    expect((child as CorrelatedTestChildProcess).autoMobileEmulatorLaunch).toEqual({
      bootedDeviceIdsBeforeLaunch: ["emulator-5554"],
    });
  });

  test("does not attach launch diff correlation when the pre-launch device scan fails", async () => {
    const fakeChild = createFakeChildProcess();
    const spawnFn = ((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        fakeChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));
      });
      return fakeChild;
    }) as any;

    const execAsync = async (command: string): Promise<ExecResult> => {
      if (command.includes("-list-avds")) {
        return createExecResult("Pixel_9_Pro\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(
      execAsync,
      spawnFn,
      fakeTimer,
      { create: () => new FailingDeviceScanExecutor() },
    );
    skipEmulatorPathDetection(client);

    const child = await client.startEmulator("Pixel_9_Pro");

    expect((child as CorrelatedTestChildProcess).autoMobileEmulatorLaunch).toBeUndefined();
  });
});

describe("AndroidEmulatorClient waitForEmulatorReady with child process monitoring", () => {
  let fakeTimer: FakeTimer;
  let fakeAdb: FakeAdbExecutor;
  let fakeFactory: TestAdbClientFactory;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    fakeAdb = new FakeAdbExecutor();
    fakeFactory = new TestAdbClientFactory(fakeAdb);
  });

  function createFakeChildProcess(): ChildProcess & EventEmitter {
    const emitter = new EventEmitter() as ChildProcess & EventEmitter;
    emitter.stdout = new Readable({ read() {} }) as any;
    emitter.stderr = new Readable({ read() {} }) as any;
    emitter.killed = false;
    emitter.pid = 1234;
    emitter.kill = () => { emitter.killed = true; return true; };
    return emitter;
  }

  function attachLaunchCorrelation(
    childProcess: ChildProcess & EventEmitter,
    bootedDeviceIdsBeforeLaunch: readonly string[],
  ): void {
    (childProcess as CorrelatedTestChildProcess).autoMobileEmulatorLaunch = {
      bootedDeviceIdsBeforeLaunch,
    };
  }

  test("throws immediately when child process exits with corrupt image during readiness wait", async () => {
    const fakeChild = createFakeChildProcess();

    // Mock exec to return no running emulators (simulating the device never appearing)
    const execAsync = async (command: string): Promise<ExecResult> => {
      if (command.includes("adb devices")) {
        return createExecResult("List of devices attached\n\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, null, fakeTimer, fakeFactory);
    skipEmulatorPathDetection(client);

    // Schedule exit event after waitForEmulatorReady registers its handlers
    setImmediate(() => {
      fakeChild.stderr!.emit("data", Buffer.from("qcow2: Image is corrupt; cannot be opened read/write\n"));
      fakeChild.emit("exit", 1);
    });

    try {
      await client.waitForEmulatorReady("Pixel_9_Pro", 60000, fakeChild);
      expect(true).toBe(false); // Should not reach here
    } catch (error: any) {
      expect(error.message).toContain("corrupt");
      expect(error.message).toContain("Suggestion");
    }
  });

  test("throws with exit code when child process exits non-zero without known pattern", async () => {
    const fakeChild = createFakeChildProcess();

    const execAsync = async (command: string): Promise<ExecResult> => {
      if (command.includes("adb devices")) {
        return createExecResult("List of devices attached\n\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, null, fakeTimer, fakeFactory);
    skipEmulatorPathDetection(client);

    setImmediate(() => {
      fakeChild.stderr!.emit("data", Buffer.from("unknown error\n"));
      fakeChild.emit("exit", 1);
    });

    try {
      await client.waitForEmulatorReady("Pixel_9_Pro", 60000, fakeChild);
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toContain("exited with code 1");
    }
  });

  test("works normally without child process (backward compatible)", async () => {
    const execAsync = async (command: string): Promise<ExecResult> => {
      if (command.includes("adb devices")) {
        return createExecResult("List of devices attached\n\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, null, fakeTimer, fakeFactory);
    skipEmulatorPathDetection(client);

    // Without child process, should just timeout normally
    try {
      await client.waitForEmulatorReady("Pixel_9_Pro", 100);
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toContain("failed to become ready within 100ms");
    }
  });

  test("waits for Android boot-complete signals before reporting readiness", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setDevices([{
      name: "Pixel_9_Pro",
      platform: "android",
      deviceId: "emulator-5554",
      source: "local",
    }]);
    fakeAdb.setCommandResponse("emu avd name", createExecResult("Pixel_9_Pro\n"));
    fakeAdb.setCommandResponse("get-state", createExecResult("device\n"));
    fakeAdb.setCommandResponse("shell pm list packages", createExecResult("package:android\n"));
    fakeAdb.setCommandResponseSequence("shell getprop sys.boot_completed", [
      createExecResult("0\n"),
      createExecResult("1\n"),
    ]);
    fakeAdb.setCommandResponse("shell getprop init.svc.bootanim", createExecResult("stopped\n"));

    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, fakeFactory);
    skipEmulatorPathDetection(client);

    const result = await client.waitForEmulatorReady("Pixel_9_Pro", 5_000);

    expect(result.deviceId).toBe("emulator-5554");
    expect(fakeAdb.wasCommandExecuted("shell getprop sys.boot_completed")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("shell getprop init.svc.bootanim")).toBe(true);
    expect(
      fakeAdb.getExecutedCommands()
        .filter(command => command.includes("shell getprop sys.boot_completed")),
    ).toHaveLength(2);
  });

  test("targets the selected emulator deviceId during already-running readiness waits", async () => {
    fakeTimer.enableAutoAdvance();
    const scopedFactory = new DeviceScopedAdbClientFactory([
      { name: "Unknown (emulator-5554)", platform: "android", deviceId: "emulator-5554" },
      { name: "Unknown (emulator-5556)", platform: "android", deviceId: "emulator-5556" },
    ]);
    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, scopedFactory);
    skipEmulatorPathDetection(client);

    const result = await client.waitForEmulatorReady(
      "Pixel_9_Pro",
      5_000,
      null,
      "emulator-5556",
    );

    expect(result.deviceId).toBe("emulator-5556");
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5556:get-state"))).toBe(true);
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5554:get-state"))).toBe(false);
  });

  test("does not readiness-check an explicit targetDeviceId whose resolved AVD name conflicts", async () => {
    fakeTimer.enableAutoAdvance();
    const scopedFactory = new DeviceScopedAdbClientFactory(
      [
        { name: "am-api32-ga-arm64", platform: "android", deviceId: "emulator-5556" },
      ],
      new Map([
        ["emulator-5556", "am-api32-ga-arm64"],
      ]),
    );
    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, scopedFactory);
    skipEmulatorPathDetection(client);

    try {
      await client.waitForEmulatorReady(
        "am-api33-ga-arm64",
        100,
        null,
        "emulator-5556",
      );
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toContain("failed to become ready within 100ms");
    }
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5556:get-state"))).toBe(false);
  });

  test("does not report a different local emulator ready during cold-boot name resolution", async () => {
    fakeTimer.enableAutoAdvance();
    const existingDevice: BootedDevice = {
      name: "am-api35-ga-arm64",
      platform: "android",
      deviceId: "emulator-5554",
      source: "local",
    };
    const launchedDevice: BootedDevice = {
      name: "am-api33-ga-arm64",
      platform: "android",
      deviceId: "emulator-5558",
      source: "local",
    };
    const scopedFactory = new DeviceScopedAdbClientFactory(
      [
        [existingDevice],
        [existingDevice, launchedDevice],
      ],
      new Map([
        ["emulator-5554", "am-api35-ga-arm64"],
        ["emulator-5558", "am-api33-ga-arm64"],
      ]),
    );
    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, scopedFactory);
    skipEmulatorPathDetection(client);

    const result = await client.waitForEmulatorReady("am-api33-ga-arm64", 5_000);

    expect(result.deviceId).toBe("emulator-5558");
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5558:get-state"))).toBe(true);
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5554:get-state"))).toBe(false);
  });

  test("targets the newly launched emulator from cold-boot device set diff when AVD name is unavailable", async () => {
    fakeTimer.enableAutoAdvance();
    const fakeChild = createFakeChildProcess();
    attachLaunchCorrelation(fakeChild, ["emulator-5554"]);
    const existingDevice: BootedDevice = {
      name: "Unknown (emulator-5554)",
      platform: "android",
      deviceId: "emulator-5554",
      source: "local",
    };
    const launchedDevice: BootedDevice = {
      name: "Unknown (emulator-5558)",
      platform: "android",
      deviceId: "emulator-5558",
      source: "local",
    };
    const scopedFactory = new DeviceScopedAdbClientFactory([
      [existingDevice],
      [existingDevice, launchedDevice],
    ]);
    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, scopedFactory);
    skipEmulatorPathDetection(client);

    const result = await client.waitForEmulatorReady("am-api33-ga-arm64", 5_000, fakeChild);

    expect(result.deviceId).toBe("emulator-5558");
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5558:get-state"))).toBe(true);
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5554:get-state"))).toBe(false);
  });

  test("does not readiness-check a newly launched emulator whose resolved AVD name conflicts", async () => {
    fakeTimer.enableAutoAdvance();
    const fakeChild = createFakeChildProcess();
    attachLaunchCorrelation(fakeChild, ["emulator-5554"]);
    const existingDevice: BootedDevice = {
      name: "am-api35-ga-arm64",
      platform: "android",
      deviceId: "emulator-5554",
      source: "local",
    };
    const mismatchedNewDevice: BootedDevice = {
      name: "am-api32-ga-arm64",
      platform: "android",
      deviceId: "emulator-5558",
      source: "local",
    };
    const scopedFactory = new DeviceScopedAdbClientFactory(
      [
        [existingDevice, mismatchedNewDevice],
      ],
      new Map([
        ["emulator-5554", "am-api35-ga-arm64"],
        ["emulator-5558", "am-api32-ga-arm64"],
      ]),
    );
    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, scopedFactory);
    skipEmulatorPathDetection(client);

    try {
      await client.waitForEmulatorReady("am-api33-ga-arm64", 100, fakeChild);
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.message).toContain("failed to become ready within 100ms");
    }
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5558:get-state"))).toBe(false);
  });
});
