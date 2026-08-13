import { beforeEach, describe, expect, test } from "bun:test";
import {
  AndroidEmulatorClient,
  resolveHeadlessMode,
} from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
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
 * `try { await p; expect(true).toBe(false); } catch (e) {...}` sentinel whose
 * failure assertion is swallowed by its own catch and re-checked against a
 * misleading message; this fails loudly and clearly when the promise resolves.
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

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

/** Prevent ensureEmulatorPath from running real filesystem/shell detection */
function skipEmulatorPathDetection(client: AndroidEmulatorClient): void {
  (client as any).ensureEmulatorPath = async () => "emulator";
}

describe("resolveHeadlessMode", () => {
  test("AUTOMOBILE_EMULATOR_HEADLESS=true forces headless on any platform", () => {
    expect(resolveHeadlessMode("darwin", { AUTOMOBILE_EMULATOR_HEADLESS: "true" }).headless).toBe(true);
    expect(resolveHeadlessMode("linux", { AUTOMOBILE_EMULATOR_HEADLESS: "true" }).headless).toBe(true);
    expect(resolveHeadlessMode("win32", { AUTOMOBILE_EMULATOR_HEADLESS: "true" }).headless).toBe(true);
  });

  test("AUTOMOBILE_EMULATOR_HEADLESS=false forces windowed even on a Linux host without a display", () => {
    const result = resolveHeadlessMode("linux", { AUTOMOBILE_EMULATOR_HEADLESS: "false" });
    expect(result.headless).toBe(false);
  });

  test("AUTOMOBILE_EMULATOR_HEADLESS=false forces windowed on macOS (opt back into the native window)", () => {
    const result = resolveHeadlessMode("darwin", { AUTOMOBILE_EMULATOR_HEADLESS: "false" });
    expect(result.headless).toBe(false);
  });

  test("Linux without DISPLAY or WAYLAND_DISPLAY defaults to headless", () => {
    const result = resolveHeadlessMode("linux", {});
    expect(result.headless).toBe(true);
    expect(result.reason.toLowerCase()).toContain("display");
  });

  test("Linux with DISPLAY set runs windowed", () => {
    const result = resolveHeadlessMode("linux", { DISPLAY: ":0" });
    expect(result.headless).toBe(false);
  });

  test("Linux with WAYLAND_DISPLAY set runs windowed", () => {
    const result = resolveHeadlessMode("linux", { WAYLAND_DISPLAY: "wayland-0" });
    expect(result.headless).toBe(false);
  });

  test("Linux with empty/whitespace DISPLAY is treated as no display", () => {
    expect(resolveHeadlessMode("linux", { DISPLAY: "" }).headless).toBe(true);
    expect(resolveHeadlessMode("linux", { DISPLAY: "   " }).headless).toBe(true);
  });

  test("macOS defaults to headless (the Qt/CoreAnimation window backing store segfaults on repaint)", () => {
    const result = resolveHeadlessMode("darwin", {});
    expect(result.headless).toBe(true);
    expect(result.reason.toLowerCase()).toContain("macos");
  });

  test("Windows without DISPLAY runs windowed", () => {
    expect(resolveHeadlessMode("win32", {}).headless).toBe(false);
  });
});

describe("AndroidEmulatorClient detectDisplayError", () => {
  let client: AndroidEmulatorClient;

  beforeEach(() => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new FakeAdbExecutor();
    const fakeFactory = new TestAdbClientFactory(fakeAdb);
    client = new AndroidEmulatorClient(async () => createExecResult("", ""), null, fakeTimer, fakeFactory);
  });

  test("detects 'could not connect to display'", () => {
    const output = "Warning: could not connect to display  (:0, )";
    const result = client.detectDisplayError(output);
    expect(result.isDisplayError).toBe(true);
    expect(result.suggestion).toContain("AUTOMOBILE_EMULATOR_HEADLESS");
  });

  test("detects Qt 'xcb' platform plugin failure", () => {
    const output = 'Info: Could not load the Qt platform plugin "xcb" in "" even though it was found.';
    const result = client.detectDisplayError(output);
    expect(result.isDisplayError).toBe(true);
    // REWRITE-4: pin the exact surfaced message, not merely that one exists.
    // toBeDefined() passes for any string, so it could not catch a message that
    // regressed to the opaque "exited with code: null" this branch exists to avoid.
    expect(result.message).toBe(
      "Emulator could not connect to a display (Qt 'xcb' platform plugin failed to load)"
    );
  });

  test("returns false for normal startup output", () => {
    const output = `INFO | emuDirName: Pixel_9_Pro
Hax is enabled
Detected GPU type: host`;
    const result = client.detectDisplayError(output);
    expect(result.isDisplayError).toBe(false);
  });

  test("returns false for empty output", () => {
    expect(client.detectDisplayError("").isDisplayError).toBe(false);
  });
});

describe("AndroidEmulatorClient startEmulator headless wiring", () => {
  let fakeTimer: FakeTimer;
  let fakeAdb: FakeAdbExecutor;
  let fakeFactory: TestAdbClientFactory;
  let fakeAvdConfigReader: FakeAvdConfigReader;
  const savedHeadless = process.env.AUTOMOBILE_EMULATOR_HEADLESS;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    fakeAdb = new FakeAdbExecutor();
    fakeFactory = new TestAdbClientFactory(fakeAdb);
    fakeAvdConfigReader = new FakeAvdConfigReader();
  });

  function restoreEnv() {
    if (savedHeadless === undefined) {
      delete process.env.AUTOMOBILE_EMULATOR_HEADLESS;
    } else {
      process.env.AUTOMOBILE_EMULATOR_HEADLESS = savedHeadless;
    }
  }

  function createFakeChildProcess(): ChildProcess & EventEmitter {
    const emitter = new EventEmitter() as ChildProcess & EventEmitter;
    emitter.stdout = new Readable({ read() {} }) as any;
    emitter.stderr = new Readable({ read() {} }) as any;
    emitter.killed = false;
    emitter.pid = 1234;
    emitter.kill = () => { emitter.killed = true; return true; };
    return emitter;
  }

  test("passes -no-window -no-audio when headless mode is enabled", async () => {
    process.env.AUTOMOBILE_EMULATOR_HEADLESS = "true";
    let capturedArgs: string[] = [];
    const fakeChild = createFakeChildProcess();

    const spawnFn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      process.nextTick(() => {
        fakeChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));
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

    try {
      await client.startEmulator("Pixel_9_Pro");
      expect(fakeAvdConfigReader.readConfigCalls).toEqual([
        "Pixel_9_Pro", // listAvds() enrichment
        "Pixel_9_Pro", // validateAvdMemory()
      ]);
      expect(capturedArgs).toContain("-no-window");
      expect(capturedArgs).toContain("-no-audio");
    } finally {
      restoreEnv();
    }
  });

  test("does not pass -no-window when explicitly disabled", async () => {
    process.env.AUTOMOBILE_EMULATOR_HEADLESS = "false";
    let capturedArgs: string[] = [];
    const fakeChild = createFakeChildProcess();

    const spawnFn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      process.nextTick(() => {
        fakeChild.stdout!.emit("data", Buffer.from("Detected GPU type: host\n"));
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

    try {
      await client.startEmulator("Pixel_9_Pro");
      expect(capturedArgs).not.toContain("-no-window");
    } finally {
      restoreEnv();
    }
  });

  test("rejects with actionable display error when emulator dies windowed on a headless host", async () => {
    process.env.AUTOMOBILE_EMULATOR_HEADLESS = "false"; // force windowed to exercise the failure path
    const fakeChild = createFakeChildProcess();

    const spawnFn = ((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        fakeChild.stderr!.emit("data", Buffer.from("Warning: could not connect to display  (:0, )\n"));
        fakeChild.stderr!.emit("data", Buffer.from('Info: Could not load the Qt platform plugin "xcb" in "" even though it was found.\n'));
        // Signal death surfaces as a null exit code from Node.
        fakeChild.emit("exit", null);
        fakeChild.emit("close", null);
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

    try {
      // REWRITE-5: expectRejection fails loudly if startEmulator resolves,
      // instead of a `expect(true).toBe(false)` sentinel that the catch swallows
      // and re-reports against a misleading assertion-error message.
      const error = await expectRejection(client.startEmulator("Pixel_9_Pro"));
      expect(error.message).toContain("display");
      expect(error.message).toContain("AUTOMOBILE_EMULATOR_HEADLESS");
      expect(error.message).not.toBe("Emulator process exited with code: null");
    } finally {
      restoreEnv();
    }
  });

  test("lists available AVD names when requested AVD does not exist", async () => {
    const execAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args.join(" ").includes("-list-avds")) {
        return createExecResult("Pixel_9_Pro\nMedium_Phone_API_35\n");
      }
      return createExecResult("");
    };

    const client = new AndroidEmulatorClient(execAsync, null, fakeTimer, fakeFactory, fakeAvdConfigReader);
    skipEmulatorPathDetection(client);

    await expect(client.startEmulator("Missing_Device")).rejects.toThrow(
      "AVD 'Missing_Device' not found. Available AVDs: Pixel_9_Pro, Medium_Phone_API_35"
    );
  });

});
