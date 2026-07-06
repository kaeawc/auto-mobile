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
});
