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
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";

/**
 * REWRITE-5: await a promise that MUST reject, returning its Error. Replaces the
 * `try { await p; expect(true).toBe(false); } catch (e) { expect(e.message)... }`
 * sentinel, whose "should not reach here" assertion is itself thrown INSIDE the
 * try and then swallowed by the same catch — so on a non-throwing regression the
 * catch re-checks the assertion-error message and fails with a misleading
 * "expected 'corrupt'" instead of "the call did not reject". This fails loudly.
 */
async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the operation to reject, but it resolved");
}

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

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

const mockExecAsync = async (_file: string, _args: string[]): Promise<ExecResult> => {
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

  // PARAM-8: pin the observable outcome across every branch, including the
  // case-sensitivity boundary. The qcow2: and generic-disk-error branches match
  // case-insensitively (/i), but the QEMU-abnormal-exit branch uses plain
  // String.includes("qcow2")/("corrupt") — so an UPPERCASE "QCOW2 METADATA
  // ERROR" in QEMU context is NOT detected. The contrast between the lowercase
  // and uppercase QEMU rows is the proof of that inconsistency.
  type Row = { name: string; output: string; isCorrupt: boolean; messageContains?: string };
  const rows: Row[] = [
    {
      name: "qcow2: corruption (lowercase) via the case-insensitive branch",
      output: "qcow2: Image is corrupt; cannot be opened read/write\nWARNING | QEMU main loop exits abnormally with code 1",
      isCorrupt: true,
      messageContains: "Disk image is corrupt",
    },
    {
      name: "qcow2: corruption still matches when the header is UPPERCASE (branch is /i)",
      output: "QCOW2: Image is CORRUPT; cannot be opened read/write",
      isCorrupt: true,
      messageContains: "Disk image is corrupt",
    },
    {
      name: "generic 'cannot open disk image'",
      output: "cannot open disk image /path/to/some.img",
      isCorrupt: true,
      messageContains: "Disk image error",
    },
    {
      name: "corrupt disk image variant",
      output: "disk image userdata-qemu.img is corrupt",
      isCorrupt: true,
      messageContains: "Disk image error",
    },
    {
      name: "QEMU abnormal exit with lowercase qcow2 context",
      output: "some stuff\nqcow2 header invalid\nWARNING | QEMU main loop exits abnormally with code 1",
      isCorrupt: true,
      messageContains: "QEMU exited abnormally",
    },
    {
      name: "QEMU abnormal exit with lowercase 'qcow2 metadata error' IS detected",
      output: "qcow2 metadata error\nWARNING | QEMU main loop exits abnormally with code 1",
      isCorrupt: true,
      messageContains: "QEMU exited abnormally",
    },
    {
      // ★ Case boundary: identical to the row above except the marker is
      // UPPERCASE. The QEMU branch's case-sensitive includes() misses it, so it
      // is NOT flagged corrupt — the documented inconsistency with the /i branches.
      name: "QEMU abnormal exit with UPPERCASE 'QCOW2 METADATA ERROR' is NOT detected (case-sensitive branch)",
      output: "QCOW2 METADATA ERROR\nWARNING | QEMU main loop exits abnormally with code 1",
      isCorrupt: false,
    },
    {
      name: "normal boot output",
      output: "INFO | emuDirName: Pixel_9_Pro\nHax is enabled\nDetected GPU type: host",
      isCorrupt: false,
    },
    {
      name: "empty output",
      output: "",
      isCorrupt: false,
    },
    {
      name: "QEMU abnormal exit without any corruption context",
      output: "WARNING | QEMU main loop exits abnormally with code 1",
      isCorrupt: false,
    },
  ];

  for (const row of rows) {
    test(`detectCorruptImage: ${row.name}`, () => {
      const result = client.detectCorruptImage(row.output);

      expect(result.isCorrupt).toBe(row.isCorrupt);
      if (row.isCorrupt) {
        expect(result.message).toContain(row.messageContains as string);
        expect(result.suggestion).toBeDefined();
      } else {
        expect(result.message).toBeUndefined();
      }
    });
  }
});

describe("AndroidEmulatorClient startEmulator corrupt image integration", () => {
  let fakeTimer: FakeTimer;
  let fakeAdb: FakeAdbExecutor;
  let fakeFactory: TestAdbClientFactory;
  let fakeAvdConfigReader: FakeAvdConfigReader;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    fakeAdb = new FakeAdbExecutor();
    fakeFactory = new TestAdbClientFactory(fakeAdb);
    fakeAvdConfigReader = new FakeAvdConfigReader();
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
        fakeChild.emit("close", 1);
      });
      return fakeChild;
    }) as any;

    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args.join(" ").includes("-list-avds")) {
        return createExecResult("Pixel_9_Pro\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, spawnFn, fakeTimer, fakeFactory, fakeAvdConfigReader);
    skipEmulatorPathDetection(client);

    const error = await expectRejection(client.startEmulator("Pixel_9_Pro"));
    expect(fakeAvdConfigReader.readConfigCalls).toEqual([
      "Pixel_9_Pro", // listAvds() enrichment
      "Pixel_9_Pro", // validateAvdMemory()
    ]);
    expect(error.message).toContain("corrupt");
    expect(error.message).toContain("Suggestion");
    expect(error.message).toContain("userdata");
  });

  test("rejects with sandbox guidance when mprotect/HVF failure is reported", async () => {
    const fakeChild = createFakeChildProcess();
    const spawnFn = ((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        fakeChild.stderr!.emit("data", Buffer.from("qemu_mprotect__osdep: mprotect failed: Permission denied\nhvf is not enabled on this aarch64 host\n"));
        fakeChild.emit("exit", 1);
        fakeChild.emit("close", 1);
      });
      return fakeChild;
    }) as any;
    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> =>
      args.join(" ").includes("-list-avds") ? createExecResult("Pixel_9_Pro\n") : createExecResult("");

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, spawnFn, fakeTimer, fakeFactory, fakeAvdConfigReader);
    skipEmulatorPathDetection(client);

    const error = await expectRejection(client.startEmulator("Pixel_9_Pro"));
    expect(error.message).toContain("hypervisor");
    expect(error.message).toContain("sandbox");
    expect(error.message).toContain("Suggestion");
  });

  test("retains a late sandbox error for the readiness waiter", async () => {
    const fakeChild = createFakeChildProcess();
    const spawnFn = ((_cmd: string, _args: string[]) => fakeChild) as any;
    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> =>
      args.join(" ").includes("-list-avds") ? createExecResult("Pixel_9_Pro\n") : createExecResult("");

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, spawnFn, fakeTimer, fakeFactory, fakeAvdConfigReader);
    skipEmulatorPathDetection(client);

    const process = await client.startEmulator("Pixel_9_Pro");
    expect(process).toBe(fakeChild);
    fakeChild.stderr!.emit("data", Buffer.from("qemu_mprotect__osdep: mprotect failed: Permission denied\n"));

    const error = await expectRejection(client.waitForEmulatorReady("Pixel_9_Pro", 60_000, fakeChild));
    expect(error.message).toContain("hypervisor");
    expect(error.message).toContain("sandbox");
  });

  test("returns null (not a fabricated handle) when the spawn exits with 'Running multiple emulators with the same AVD'", async () => {
    const fakeChild = createFakeChildProcess();

    const spawnFn = ((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        // This AVD is already owned by another emulator process; the spawned
        // process exits non-zero with this signature. We hold no handle for the
        // already-running instance, so startEmulator must resolve null (#3938),
        // not a fabricated `{} as ChildProcess`.
        fakeChild.stderr!.emit("data", Buffer.from("ERROR | Running multiple emulators with the same AVD is an experimental feature.\n"));
        fakeChild.emit("exit", 1);
        fakeChild.emit("close", 1);
      });
      return fakeChild;
    }) as any;

    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args.join(" ").includes("-list-avds")) {
        return createExecResult("Pixel_9_Pro\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, spawnFn, fakeTimer, fakeFactory, fakeAvdConfigReader);
    skipEmulatorPathDetection(client);

    const result = await client.startEmulator("Pixel_9_Pro");
    expect(result).toBeNull();
  });

  test("rejects with exit code when emulator exits non-zero without known error pattern", async () => {
    const fakeChild = createFakeChildProcess();

    const spawnFn = ((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        fakeChild.stderr!.emit("data", Buffer.from("some random error\n"));
        fakeChild.emit("exit", 1);
        fakeChild.emit("close", 1);
      });
      return fakeChild;
    }) as any;

    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args.join(" ").includes("-list-avds")) {
        return createExecResult("Pixel_9_Pro\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, spawnFn, fakeTimer, fakeFactory, fakeAvdConfigReader);
    skipEmulatorPathDetection(client);

    const error = await expectRejection(client.startEmulator("Pixel_9_Pro"));
    expect(error.message).toContain("exited with code: 1");
  });

  test("uses spawned process output deviceId to target readiness when AVD name is unavailable", async () => {
    const fakeChild = createFakeChildProcess();
    const spawnFn = ((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        fakeChild.stdout!.emit("data", Buffer.from("emulator-5558: INFO: console port 5558\nDetected GPU type: host\n"));
      });
      return fakeChild;
    }) as any;

    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args.join(" ").includes("-list-avds")) {
        return createExecResult("Pixel_9_Pro\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    fakeAdb.setDevices([
      { name: "Unknown (emulator-5554)", platform: "android", deviceId: "emulator-5554", source: "local" },
    ]);
    fakeAdb.setCommandResponse("emu avd name", createExecResult(""));
    fakeAdb.setCommandResponse("get-state", createExecResult("device\n"));
    fakeAdb.setCommandResponse("shell pm list packages", createExecResult("package:android\n"));
    fakeAdb.setCommandResponse("shell getprop sys.boot_completed", createExecResult("1\n"));
    fakeAdb.setCommandResponse("shell getprop init.svc.bootanim", createExecResult("stopped\n"));
    const client = new AndroidEmulatorClient(execAsync, spawnFn, fakeTimer, fakeFactory, fakeAvdConfigReader);
    skipEmulatorPathDetection(client);

    const child = await client.startEmulator("Pixel_9_Pro");
    fakeAdb.setDevices([
      { name: "Unknown (emulator-5554)", platform: "android", deviceId: "emulator-5554", source: "local" },
      { name: "Unknown (emulator-5558)", platform: "android", deviceId: "emulator-5558", source: "local" },
    ]);

    const readyDevice = await client.waitForEmulatorReady("Pixel_9_Pro", 5_000, child);

    expect(readyDevice.deviceId).toBe("emulator-5558");
    expect(fakeAdb.getExecutedCommands().some(command => command.includes("get-state"))).toBe(true);
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

  test("throws immediately when child process exits with corrupt image during readiness wait", async () => {
    const fakeChild = createFakeChildProcess();

    // Mock exec to return no running emulators (simulating the device never appearing)
    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args.join(" ").includes("adb devices")) {
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

    const error = await expectRejection(client.waitForEmulatorReady("Pixel_9_Pro", 60000, fakeChild));
    expect(error.message).toContain("corrupt");
    expect(error.message).toContain("Suggestion");
  });

  test("throws with exit code when child process exits non-zero without known pattern", async () => {
    const fakeChild = createFakeChildProcess();

    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args.join(" ").includes("adb devices")) {
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

    const error = await expectRejection(client.waitForEmulatorReady("Pixel_9_Pro", 60000, fakeChild));
    expect(error.message).toContain("exited with code 1");
  });

  test("works normally without child process (backward compatible)", async () => {
    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args.join(" ").includes("adb devices")) {
        return createExecResult("List of devices attached\n\n");
      }
      return createExecResult("");
    };

    fakeTimer.enableAutoAdvance();
    const client = new AndroidEmulatorClient(execAsync, null, fakeTimer, fakeFactory);
    skipEmulatorPathDetection(client);

    // Without child process, should just timeout normally
    const error = await expectRejection(client.waitForEmulatorReady("Pixel_9_Pro", 100));
    expect(error.message).toContain("failed to become ready within 100ms");
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
    const controller = new AbortController();

    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, fakeFactory);
    skipEmulatorPathDetection(client);

    const result = await client.waitForEmulatorReady(
      "Pixel_9_Pro",
      5_000,
      undefined,
      undefined,
      controller.signal,
    );

    expect(result.deviceId).toBe("emulator-5554");
    expect(fakeAdb.wasCommandExecuted("shell getprop sys.boot_completed")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("shell getprop init.svc.bootanim")).toBe(true);
    const readinessCommands = fakeAdb.getCommandCalls().filter(({ command }) =>
      ["get-state", "shell pm list packages", "shell getprop sys.boot_completed", "shell getprop init.svc.bootanim"].includes(command),
    );
    expect(readinessCommands).toHaveLength(8);
    for (const command of readinessCommands) {
      expect(command.timeoutMs).toBeGreaterThan(0);
      expect(command.timeoutMs).toBeLessThanOrEqual(5_000);
      expect(command.signal).toBe(controller.signal);
    }
    expect(
      fakeAdb.getExecutedCommands()
        .filter(command => command.includes("shell getprop sys.boot_completed")),
    ).toHaveLength(2);
  });

  test("targets the selected emulator deviceId during already-running readiness waits", async () => {
    fakeTimer.enableAutoAdvance();
    const scopedFactory = new DeviceScopedAdbClientFactory([
      { name: "Unknown (emulator-5554)", platform: "android", deviceId: "emulator-5554", source: "local" },
      { name: "Unknown (emulator-5556)", platform: "android", deviceId: "emulator-5556", source: "local" },
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
        { name: "am-api32-ga-arm64", platform: "android", deviceId: "emulator-5556", source: "local" },
      ],
      new Map([
        ["emulator-5556", "am-api32-ga-arm64"],
      ]),
    );
    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, scopedFactory);
    skipEmulatorPathDetection(client);

    const error = await expectRejection(
      client.waitForEmulatorReady("am-api33-ga-arm64", 100, null, "emulator-5556")
    );
    expect(error.message).toContain("failed to become ready within 100ms");
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5556:get-state"))).toBe(false);
  });

  test("keeps explicit targetDeviceId authoritative when an unknown request name later resolves", async () => {
    fakeTimer.enableAutoAdvance();
    const scopedFactory = new DeviceScopedAdbClientFactory(
      [
        { name: "am-api32-ga-arm64", platform: "android", deviceId: "emulator-5556", source: "local" },
      ],
      new Map([
        ["emulator-5556", "am-api32-ga-arm64"],
      ]),
    );
    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, scopedFactory);
    skipEmulatorPathDetection(client);

    const result = await client.waitForEmulatorReady(
      "Unknown (emulator-5556)",
      5_000,
      null,
      "emulator-5556",
    );

    expect(result.deviceId).toBe("emulator-5556");
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5556:get-state"))).toBe(true);
  });

  test("keeps explicit physical deviceId authoritative when model name later resolves", async () => {
    fakeTimer.enableAutoAdvance();
    const scopedFactory = new DeviceScopedAdbClientFactory([
      { name: "Pixel 8", platform: "android", deviceId: "R58M123456A" },
    ]);
    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, scopedFactory);
    skipEmulatorPathDetection(client);

    const result = await client.waitForEmulatorReady(
      "R58M123456A",
      5_000,
      null,
      "R58M123456A",
    );

    expect(result.deviceId).toBe("R58M123456A");
    expect(scopedFactory.commandLog.some(command => command.startsWith("R58M123456A:get-state"))).toBe(true);
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

  test("does not use a single new unknown emulator as identity without process-output correlation", async () => {
    fakeTimer.enableAutoAdvance();
    const fakeChild = createFakeChildProcess();
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

    await expect(
      client.waitForEmulatorReady("am-api33-ga-arm64", 100, fakeChild),
    ).rejects.toThrow("failed to become ready within 100ms");

    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5558:get-state"))).toBe(false);
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5554:get-state"))).toBe(false);
  });

  test("does not readiness-check multiple new unknown emulators", async () => {
    fakeTimer.enableAutoAdvance();
    const fakeChild = createFakeChildProcess();
    const scopedFactory = new DeviceScopedAdbClientFactory([
      [
        { name: "Unknown (emulator-5554)", platform: "android", deviceId: "emulator-5554", source: "local" },
        { name: "Unknown (emulator-5558)", platform: "android", deviceId: "emulator-5558", source: "local" },
        { name: "Unknown (emulator-5560)", platform: "android", deviceId: "emulator-5560", source: "local" },
      ],
    ]);
    const client = new AndroidEmulatorClient(mockExecAsync, null, fakeTimer, scopedFactory);
    skipEmulatorPathDetection(client);

    await expect(
      client.waitForEmulatorReady("am-api33-ga-arm64", 100, fakeChild),
    ).rejects.toThrow("failed to become ready within 100ms");

    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5558:get-state"))).toBe(false);
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5560:get-state"))).toBe(false);
  });

  test("does not readiness-check a newly launched emulator whose resolved AVD name conflicts", async () => {
    fakeTimer.enableAutoAdvance();
    const fakeChild = createFakeChildProcess();
    setImmediate(() => {
      fakeChild.stdout!.emit("data", Buffer.from("emulator-5558: INFO: console port 5558\n"));
    });
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

    await expect(
      client.waitForEmulatorReady("am-api33-ga-arm64", 100, fakeChild),
    ).rejects.toThrow("failed to become ready within 100ms");
    expect(scopedFactory.commandLog.some(command => command.startsWith("emulator-5558:get-state"))).toBe(false);
  });
});
