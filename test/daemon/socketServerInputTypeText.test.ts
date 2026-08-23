import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { InputText } from "../../src/features/action/InputText";
import type { BootedDevice, ExecResult } from "../../src/models";
import type {
  AdbExecuteOptions,
  AdbExecutor,
} from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AdbCommandTimeoutError } from "../../src/utils/android-cmdline-tools/AdbClient";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { executionTracker } from "../../src/server/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  iosDevice,
  createFakeDeviceManager,
  createFakeSession,
  createFakeDaemonState,
  sendRequest,
  sendRequestAfterConnect,
} from "./helpers/inputSocketHarness";

/**
 * An adb executor that behaves the way a real `adb` subprocess does under a deadline:
 * a command matching `stallPattern` runs until its own `timeoutMs` kills it, and runs
 * FOREVER when it was handed no timeout at all.
 *
 * That second half is what makes the append-timeout tests mutation-sensitive. Dropping
 * the threaded budget does not merely change an assertion — it reproduces the original
 * bug, an adb call nothing ever cancels.
 */
class ScriptedAdbExecutor {
  readonly commands: Array<{ command: string; timeoutMs?: number }> = [];

  constructor(
    private readonly timer: FakeTimer,
    private readonly stallPattern?: string,
    private readonly apiLevel: string = "31",
  ) {}

  async executeCommand(command: string, timeoutMs?: number): Promise<ExecResult> {
    this.commands.push({ command, timeoutMs });

    if (this.stallPattern !== undefined && command.includes(this.stallPattern)) {
      return this.stalledSubprocess(command, timeoutMs);
    }

    const stdout = command.includes("ro.build.version.sdk") ? `${this.apiLevel}\n` : "";
    return {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (search: string) => stdout.includes(search),
    } as unknown as ExecResult;
  }

  async execute(args: string[], options: AdbExecuteOptions = {}): Promise<ExecResult> {
    await options.beforeDispatch?.(options.timeoutMs);
    return this.executeCommand(args.join(" "), options.timeoutMs);
  }

  /**
   * How a real adb subprocess behaves under a deadline: it dies at its own
   * `timeoutMs`, and runs FOREVER when it was handed none — which is exactly why
   * dropping the threaded budget reproduces the original wedge instead of merely
   * flipping an assertion.
   */
  stalledSubprocess<T>(label: string, timeoutMs?: number): Promise<T> {
    return new Promise<T>((_resolve, reject) => {
      if (timeoutMs === undefined) {
        return;
      }
      this.timer.setTimeout(
        () =>
          reject(
            new AdbCommandTimeoutError(`adb command timed out after ${timeoutMs}ms: ${label}`),
          ),
        timeoutMs,
      );
    });
  }

  /** Only the `shell input ...` commands, i.e. what actually reached the device's input system. */
  inputCommands(): string[] {
    return this.commands
      .map((call) => call.command)
      .filter((command) => command.startsWith("shell input "));
  }
}

/**
 * The production-`AdbClient` shape: an own `getAndroidApiLevel` method, which
 * `readAndroidDeviceApiLevel` prefers over the raw getprop fallback. The real
 * daemon always takes this branch, so the wedge tests must be able to drive it —
 * bounding only the fallback (as the first fix did) leaves production unbounded.
 */
class ProductionShapedAdbExecutor extends ScriptedAdbExecutor {
  /** The budget each probe call received; `undefined` entries are the bug. */
  readonly probeCalls: Array<number | undefined> = [];

  constructor(
    timer: FakeTimer,
    private readonly options: { stallProbe?: boolean; probeApiLevel?: number } = {},
  ) {
    super(timer);
  }

  async getAndroidApiLevel(timeoutMs?: number): Promise<number | null> {
    this.probeCalls.push(timeoutMs);
    if (this.options.stallProbe) {
      return this.stalledSubprocess<number | null>("getAndroidApiLevel", timeoutMs);
    }
    return this.options.probeApiLevel ?? 31;
  }
}

/** The real append path, bound to a fake adb so no subprocess is ever spawned. */
function createAppendTextInput(
  device: BootedDevice,
  adb: ScriptedAdbExecutor,
  timer: FakeTimer,
): InputText {
  const factory = { create: () => adb as unknown as AdbExecutor };
  return new InputText(device, factory, undefined, timer);
}

/** Let every already-queued microtask run before the fake clock moves. */
async function flushMicrotasks(iterations: number = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Fail loudly instead of hanging when a response never arrives. The failure mode
 * these tests guard is a wedge, so the guard has to be real time — a fake clock the
 * wedged code is no longer driving cannot rescue it.
 */
function withWedgeGuard<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const handle = defaultTimer.setTimeout(() => reject(new Error(message)), 2_000);
      void promise.finally(() => defaultTimer.clearTimeout(handle));
    }),
  ]);
}

describe("UnixSocketServer input/typeText", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let originalAndroidGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let originalIosGetInstance: typeof IOSCtrlProxyClient.getInstance;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-type-text-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
    originalAndroidGetInstance = AndroidCtrlProxyClient.getInstance;
    originalIosGetInstance = IOSCtrlProxyClient.getInstance;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
    AndroidCtrlProxyClient.getInstance = originalAndroidGetInstance;
    IOSCtrlProxyClient.getInstance = originalIosGetInstance;
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
  });

  test("routes Android text input through existing platform input infrastructure", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    const createMcpClient = mock(async () => {
      throw new Error("input/typeText should not create an MCP client");
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    server.mcpClientFactory = createMcpClient;
    await server.start();

    const response = await sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "hello, Jason!",
      },
      1234,
    );

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/typeText",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      textLength: 13,
      submitted: false,
    });
    expect(requestSetText).toHaveBeenCalledWith("hello, Jason!", { timeoutMs: 1234 });
    expect(requestImeAction).not.toHaveBeenCalled();
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  test("tracks direct input until a session-loss drain can safely finish", async () => {
    const operationStarted = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    const requestSetText = mock(async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      return { success: true, totalTimeMs: 1 };
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction: mock(async () => ({ success: true, totalTimeMs: 1 })),
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const sessionId = "direct-input-session";
    const sessions = new Map([
      [sessionId, createFakeSession(sessionId, androidDevice.deviceId, "android")],
    ]);
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessions),
      fakeTimer,
    );
    await server.start();

    const response = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: androidDevice.deviceId,
      text: "still running",
    });
    await operationStarted.promise;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);

    expect(await executionTracker.cancelDeviceSessionExecutions(sessionId, "test recovery")).toBe(
      1,
    );
    let drained = false;
    const drain = executionTracker
      .waitForDeviceSessionExecutionsToEnd(sessionId, 1_000)
      .then((result) => {
        drained = result;
        return result;
      });
    await flushMicrotasks();
    expect(drained).toBe(false);

    releaseOperation.resolve();
    expect(await drain).toBe(true);
    expect((await response).success).toBe(false);
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(false);
  });

  // Issue #3351: requestSetText is ACTION_SET_TEXT, which REPLACES the focused
  // field. A client mirroring a keyboard one keystroke at a time must never
  // reach it, or typing "abc" leaves the field saying "c" and anything already
  // there is destroyed on the first key.
  test("append mode types with real key events and never reaches requestSetText", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    const adb = new ScriptedAdbExecutor(fakeTimer);
    server.appendTextFactory = (device) => createAppendTextInput(device, adb, fakeTimer);
    await server.start();

    const response = await sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "a",
        mode: "append",
      },
      1234,
    );

    expect(response.success).toBe(true);
    // The append actually happened, through a real key event...
    expect(adb.inputCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
    // ...with no clear and no ACTION_SET_TEXT, so whatever the field already held
    // survives the keystroke.
    expect(adb.commands.some((call) => call.command.includes("KEYCODE_DEL"))).toBe(false);
    expect(requestSetText).not.toHaveBeenCalled();
    // Every device round trip is bounded by the request's own budget.
    for (const call of adb.commands) {
      expect(call.timeoutMs).toBeDefined();
      expect(call.timeoutMs).toBeLessThanOrEqual(1234);
    }
  });

  test("failed multi-character append reports the landed prefix on the error envelope", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    server.appendTextFactory = () => ({
      appendText: async () => ({
        success: false,
        error: "append key event failed: adb rejected KEYCODE_B",
        charsSent: 1,
      }),
    });
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "ab",
      mode: "append",
    });

    expect(response).toMatchObject({
      success: false,
      error: "append key event failed: adb rejected KEYCODE_B",
      charsSent: 1,
    });
    expect(response.result).toBeUndefined();
  });

  test("append reports full progress when submit fails after all text lands", async () => {
    const requestImeAction = mock(async () => ({
      success: false,
      error: "enter key unavailable",
      totalTimeMs: 1,
    }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    server.appendTextFactory = () => ({
      appendText: async () => ({ success: true, charsSent: 2 }),
    });
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "ab",
      mode: "append",
      submit: true,
    });

    expect(response).toMatchObject({
      success: false,
      error: "enter key unavailable",
      charsSent: 2,
    });
    expect(requestImeAction).toHaveBeenCalledWith("done", 30_000);
  });

  test("append reports full progress when submit throws after all text lands", async () => {
    const requestImeAction = mock(async () => {
      throw new Error("CtrlProxy send failed");
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    server.appendTextFactory = () => ({
      appendText: async () => ({ success: true, charsSent: 2 }),
    });
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "ab",
      mode: "append",
      submit: true,
    });

    expect(response).toMatchObject({
      success: false,
      error: "CtrlProxy send failed",
      charsSent: 2,
    });
    expect(requestImeAction).toHaveBeenCalledWith("done", 30_000);
  });

  test("append preserves full progress when submit reaches the shared deadline", async () => {
    const requestImeAction = mock(
      () =>
        new Promise((resolve) => {
          fakeTimer.setTimeout(
            () => resolve({ success: false, error: "enter key unavailable", totalTimeMs: 1 }),
            100,
          );
        }),
    );
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    server.appendTextFactory = () => ({
      appendText: async () => ({ success: true, charsSent: 2 }),
    });
    await server.start();

    const responsePromise = sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "ab",
        mode: "append",
        submit: true,
      },
      100,
    );

    await flushMicrotasks();
    expect(requestImeAction).toHaveBeenCalledWith("done", 100);
    fakeTimer.advanceTime(100);
    await flushMicrotasks();

    const response = await withWedgeGuard(
      responsePromise,
      "the timed-out submit did not release the per-device queue",
    );
    expect(response.success).toBe(false);
    expect(response.error).toContain("input/typeText exceeded 100ms");
    expect(response.charsSent).toBe(2);
  });

  // The review's Critical + P1 finding, which share one root cause: the append path
  // used to receive no timeout at all. `runInputOperationWithTimeout` detects the
  // socket deadline but then AWAITS the in-flight operation before releasing the
  // per-device queue, so an unbounded adb subprocess wedged the response AND every
  // later input for that device — indefinitely.
  test("a stalled adb key event fails inside the budget and frees the device queue", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    // Models a real adb subprocess: it runs until its own timeout kills it, and
    // runs FOREVER when it was handed no timeout.
    const adb = new ScriptedAdbExecutor(fakeTimer, "input keyevent");
    server.appendTextFactory = (device) => createAppendTextInput(device, adb, fakeTimer);
    await server.start();

    const stalledPromise = sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "a",
        mode: "append",
      },
      100,
    );

    await flushMicrotasks();
    fakeTimer.advanceTime(100);
    await flushMicrotasks();

    const stalled = await withWedgeGuard(stalledPromise, "the stalled append never answered");
    expect(stalled.success).toBe(false);
    expect(String(stalled.error)).toContain("input/typeText exceeded 100ms");

    // And the queue is free: a following input on the SAME device runs rather than
    // queueing behind a subprocess nobody is waiting on any more.
    const next = await withWedgeGuard(
      sendRequest(
        socketPath,
        "input/typeText",
        {
          platform: "android",
          deviceId: "emulator-5554",
          text: "next",
        },
        30_000,
      ),
      "the per-device queue stayed wedged behind the stalled append",
    );
    expect(next.success).toBe(true);
    expect(requestSetText).toHaveBeenCalledWith("next", { timeoutMs: 30_000 });
  });

  test("a timed-out later append key omits an unsafe retry boundary", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    const adb = new ScriptedAdbExecutor(fakeTimer, "KEYCODE_B");
    server.appendTextFactory = (device) => createAppendTextInput(device, adb, fakeTimer);
    await server.start();

    const responsePromise = sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "ab",
        mode: "append",
      },
      100,
    );

    await flushMicrotasks();
    fakeTimer.advanceTime(100);
    await flushMicrotasks();

    const response = await withWedgeGuard(
      responsePromise,
      "the timed-out append did not release the per-device queue",
    );
    expect(response.success).toBe(false);
    expect(response.charsSent).toBeUndefined();
    expect(adb.inputCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
    ]);
  });

  // The first wedge fix bounded only the getprop FALLBACK. Production AdbClient
  // exposes getAndroidApiLevel, so readAndroidDeviceApiLevel takes the extended
  // branch — which still received no budget, reproducing the identical wedge on
  // the path real hardware actually takes. This sibling drives that exact shape.
  test("a stalled PRODUCTION api-level probe fails inside the budget and frees the queue", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    const adb = new ProductionShapedAdbExecutor(fakeTimer, { stallProbe: true });
    server.appendTextFactory = (device) => createAppendTextInput(device, adb, fakeTimer);
    await server.start();

    // Uppercase "A" needs the `input keycombination` capability, so it takes the
    // API-level probe path (a lowercase append skips the probe — issue #3351).
    const stalledPromise = sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "A",
        mode: "append",
      },
      100,
    );

    await flushMicrotasks();
    fakeTimer.advanceTime(100);
    await flushMicrotasks();

    const stalled = await withWedgeGuard(
      stalledPromise,
      "the stalled production probe never answered",
    );
    expect(stalled.success).toBe(false);
    expect(String(stalled.error)).toContain("input/typeText exceeded 100ms");
    // The production branch received the budget — an undefined here IS the bug.
    expect(adb.probeCalls.length).toBeGreaterThan(0);
    for (const budget of adb.probeCalls) {
      expect(budget).toBeDefined();
      expect(budget).toBeLessThanOrEqual(100);
    }

    // And the queue is free for the next same-device input.
    const next = await withWedgeGuard(
      sendRequest(
        socketPath,
        "input/typeText",
        {
          platform: "android",
          deviceId: "emulator-5554",
          text: "next",
        },
        30_000,
      ),
      "the per-device queue stayed wedged behind the stalled production probe",
    );
    expect(next.success).toBe(true);
    expect(requestSetText).toHaveBeenCalledWith("next", { timeoutMs: 30_000 });
  });

  // Interactive latency (#1099): one input/typeText arrives PER KEYSTROKE, so a
  // per-request InputText would re-pay the API-level probe on every key press.
  // The server caches the helper per device; the probe must run exactly once.
  test("consecutive append requests for one device probe the API level once", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(
      createFakeDeviceManager([{ ...androidDevice, transportId: "1" }]),
    );
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    const adb = new ProductionShapedAdbExecutor(fakeTimer);
    let factoryCalls = 0;
    server.appendTextFactory = (device) => {
      factoryCalls += 1;
      return createAppendTextInput(device, adb, fakeTimer);
    };
    await server.start();

    // Uppercase characters need the capability, so each append takes the probe
    // path; the per-device cache must still collapse them to ONE probe. (Lowercase
    // would skip the probe entirely — issue #3351 — which is a different test.)
    for (const char of ["A", "B", "C"]) {
      const response = await sendRequest(
        socketPath,
        "input/typeText",
        {
          platform: "android",
          deviceId: "emulator-5554",
          text: char,
          mode: "append",
        },
        1234,
      );
      expect(response.success).toBe(true);
    }

    // One helper, one probe, three keystrokes' worth of key events.
    expect(factoryCalls).toBe(1);
    expect(adb.probeCalls.length).toBe(1);
    expect(adb.inputCommands()).toEqual([
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_A",
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_B",
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_C",
    ]);
  });

  test("evicts the cached append helper after the direct device queue is idle", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(
      createFakeDeviceManager([{ ...androidDevice, transportId: "1" }]),
    );
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    const adb = new ProductionShapedAdbExecutor(fakeTimer);
    let factoryCalls = 0;
    server.appendTextFactory = (device) => {
      factoryCalls += 1;
      return createAppendTextInput(device, adb, fakeTimer);
    };
    await server.start();

    const append = (text: string) =>
      sendRequest(socketPath, "input/typeText", {
        platform: "android",
        deviceId: "emulator-5554",
        text,
        mode: "append",
      });

    expect((await append("A")).success).toBe(true);
    expect(factoryCalls).toBe(1);

    await fakeTimer.advanceTimeAsync(5 * 60 * 1000);

    expect((await append("B")).success).toBe(true);
    expect(factoryCalls).toBe(2);
  });

  test("evicts the cached append helper after a session MCP forward succeeds it in the device queue", async () => {
    PlatformDeviceManagerFactory.setInstance(
      createFakeDeviceManager([{ ...androidDevice, transportId: "1" }]),
    );
    const sessions = new Map([
      ["session-a", createFakeSession("session-a", androidDevice.deviceId, "android")],
    ]);
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessions),
      fakeTimer,
    );
    let factoryCalls = 0;
    let releaseAppend: () => void = () => {};
    let signalAppendStarted: () => void = () => {};
    const appendStarted = new Promise<void>((resolve) => {
      signalAppendStarted = resolve;
    });
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    server.appendTextFactory = () => {
      factoryCalls += 1;
      return {
        appendText: async () => {
          signalAppendStarted();
          await appendReleased;
          return { success: true, charsSent: 1 };
        },
      };
    };
    server.mcpClientFactory = async () =>
      ({
        callTool: async () => ({ content: [] }),
        listTools: async () => ({ tools: [] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      }) as any;
    await server.start();

    const append = (text: string) =>
      sendRequest(socketPath, "input/typeText", {
        platform: "android",
        deviceId: androidDevice.deviceId,
        text,
        mode: "append",
      });

    const firstAppend = append("A");
    await appendStarted;
    const queuedMcpForward = sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: {
        sessionUuid: "session-a",
        deviceId: androidDevice.deviceId,
      },
    });
    await flushMicrotasks();
    releaseAppend();

    expect((await firstAppend).success).toBe(true);
    expect((await queuedMcpForward).success).toBe(true);

    // The helper was built exactly once and is still cached: the queued session
    // MCP forward has NOT evicted it yet. Asserting this before advancing time
    // proves the later rebuild is caused by the idle-window eviction rather than
    // the helper never being cached or being evicted immediately.
    expect(factoryCalls).toBe(1);

    await fakeTimer.advanceTimeAsync(5 * 60 * 1000);

    expect((await append("B")).success).toBe(true);
    expect(factoryCalls).toBe(2);
  });

  // Issue #3351: an emulator replaced under a reused serial (emulator-5554) must not
  // inherit the previous device's cached API-level capability. The daemon's
  // disconnect monitor calls evictDeviceInputCache on a confirmed disconnect; after
  // it, the next append rebuilds the helper and re-probes from scratch.
  test("evicting the input cache forces the next append for that device to re-probe", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    const adb = new ProductionShapedAdbExecutor(fakeTimer);
    let factoryCalls = 0;
    server.appendTextFactory = (device) => {
      factoryCalls += 1;
      return createAppendTextInput(device, adb, fakeTimer);
    };
    await server.start();

    // Uppercase "A" takes the probe path (lowercase would skip it — issue #3351),
    // so the eviction's effect on re-probing is observable.
    const append = () =>
      sendRequest(
        socketPath,
        "input/typeText",
        {
          platform: "android",
          deviceId: "emulator-5554",
          text: "A",
          mode: "append",
        },
        1234,
      );

    expect((await append()).success).toBe(true);
    expect(factoryCalls).toBe(1);
    expect(adb.probeCalls.length).toBe(1);

    // The old emulator-5554 disconnects; the daemon evicts its cached helper.
    server.evictDeviceInputCache("emulator-5554");

    // The replacement (same serial) must rebuild the helper and probe again — its
    // API level is not assumed from the device that used to hold this serial.
    expect((await append()).success).toBe(true);
    expect(factoryCalls).toBe(2);
    expect(adb.probeCalls.length).toBe(2);
  });

  test("re-probes append input when direct discovery reports a new connection incarnation", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    let discoveredDevice = {
      ...androidDevice,
      transportId: "1",
    } as BootedDevice;
    let bypassedAndroidDeviceListCache = false;
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevicesDetailed: async (
        _platform,
        options?: { bypassAndroidDeviceListCache?: boolean },
      ) => {
        bypassedAndroidDeviceListCache ||= options?.bypassAndroidDeviceListCache === true;
        return {
          devices: [discoveredDevice],
          succeededPlatforms: new Set(["android"]),
        };
      },
    } as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    const adb = new ProductionShapedAdbExecutor(fakeTimer);
    let factoryCalls = 0;
    server.appendTextFactory = (device) => {
      factoryCalls++;
      return createAppendTextInput(device, adb, fakeTimer);
    };
    await server.start();

    const append = () =>
      sendRequest(
        socketPath,
        "input/typeText",
        {
          platform: "android",
          deviceId: "emulator-5554",
          text: "A",
          mode: "append",
        },
        1234,
      );

    expect((await append()).success).toBe(true);
    discoveredDevice = {
      ...androidDevice,
      transportId: "2",
    } as BootedDevice;
    expect((await append()).success).toBe(true);

    expect(factoryCalls).toBe(2);
    expect(adb.probeCalls.length).toBe(2);
    expect(bypassedAndroidDeviceListCache).toBe(true);
  });

  test("revalidates append transport identity after waiting behind same-device input", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    let discoveredDevice = { ...androidDevice, transportId: "1" } as BootedDevice;
    let discoveryCalls = 0;
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevicesDetailed: async () => {
        discoveryCalls++;
        return {
          devices: [discoveredDevice],
          succeededPlatforms: new Set(["android"]),
        };
      },
    } as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    let releaseFirstAppend: (() => void) | undefined;
    const firstAppendReleased = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    let signalFirstAppendStarted: (() => void) | undefined;
    const firstAppendStarted = new Promise<void>((resolve) => {
      signalFirstAppendStarted = resolve;
    });
    const createdForTransportIds: Array<string | undefined> = [];
    server.appendTextFactory = (device) => {
      createdForTransportIds.push(device.transportId);
      return {
        appendText: async () => {
          if (createdForTransportIds.length === 1) {
            signalFirstAppendStarted?.();
            await firstAppendReleased;
          }
          return { success: true };
        },
      } as InputText;
    };
    await server.start();

    const append = () =>
      sendRequest(
        socketPath,
        "input/typeText",
        {
          platform: "android",
          deviceId: "emulator-5554",
          text: "A",
          mode: "append",
        },
        1234,
      );

    const first = append();
    await firstAppendStarted;
    const second = append();
    await flushMicrotasks();
    expect(discoveryCalls).toBe(3);

    // The second request was resolved before the replacement, then waited in
    // the same-device queue. Its queued revalidation must see the new transport.
    discoveredDevice = { ...androidDevice, transportId: "2" } as BootedDevice;
    releaseFirstAppend?.();

    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
    expect(createdForTransportIds).toEqual(["1", "2"]);
    expect(discoveryCalls).toBe(4);
  });

  test("does not reuse append input when direct discovery omits transport identity", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    const adb = new ProductionShapedAdbExecutor(fakeTimer);
    let factoryCalls = 0;
    server.appendTextFactory = (device) => {
      factoryCalls++;
      return createAppendTextInput(device, adb, fakeTimer);
    };
    await server.start();

    const append = () =>
      sendRequest(
        socketPath,
        "input/typeText",
        {
          platform: "android",
          deviceId: "emulator-5554",
          text: "A",
          mode: "append",
        },
        1234,
      );

    expect((await append()).success).toBe(true);
    expect((await append()).success).toBe(true);

    expect(factoryCalls).toBe(2);
    expect(adb.probeCalls.length).toBe(2);
  });

  // The client forwards every printable ASCII character, but uppercase and shifted
  // symbols need `input keycombination` (API 31+) and the client cannot see the API
  // level. The daemon therefore has to REPORT the failure; a silent success that
  // typed nothing is the one outcome that loses the keystroke twice.
  test("append reports a failure for uppercase on a device below API 31", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    const adb = new ScriptedAdbExecutor(fakeTimer, undefined, "30");
    server.appendTextFactory = (device) => createAppendTextInput(device, adb, fakeTimer);
    await server.start();

    const response = await sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "A",
        mode: "append",
      },
      1234,
    );

    expect(response.success).toBe(false);
    expect(String(response.error)).toContain('append cannot type "A"');
    expect(response.charsSent).toBe(0);
    // Not silently repaired by the replace path, which would wipe the field.
    expect(requestSetText).not.toHaveBeenCalled();
    expect(adb.inputCommands()).toEqual([]);
  });

  test("routes iOS text input through existing platform input infrastructure", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "ios",
      deviceId: "ios-sim-1",
      text: "hi there",
      submit: true,
    });

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      action: "input/typeText",
      platform: "ios",
      deviceId: "ios-sim-1",
      success: true,
      textLength: 8,
      submitted: true,
    });
    expect(requestSetText).toHaveBeenCalledWith("hi there", { timeoutMs: 30_000 });
    expect(requestImeAction).toHaveBeenCalledWith("done", 30_000);
  });

  test("accepts iOS append mode and uses the CtrlProxy append primitive", async () => {
    const requestAppendText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestAppendText,
      requestSetText,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    for (const text of ["a", "b", "c"]) {
      const response = await sendRequest(socketPath, "input/typeText", {
        platform: "ios",
        deviceId: "ios-sim-1",
        text,
        mode: "append",
      });

      expect(response.success).toBe(true);
    }

    expect(requestAppendText).toHaveBeenCalledTimes(3);
    expect(requestAppendText.mock.calls.map(([text]) => text)).toEqual(["a", "b", "c"]);
    expect(requestSetText).not.toHaveBeenCalled();
  });

  test("forwards an iOS frame context to the CtrlProxy append primitive", async () => {
    const requestAppendText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestAppendText,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    (server as unknown as { requireCurrentFrameContext: () => void }).requireCurrentFrameContext =
      () => {};
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "ios",
      deviceId: "ios-sim-1",
      text: "a",
      mode: "append",
      frameContext: "ios:7",
    });

    expect(response.success).toBe(true);
    expect(requestAppendText).toHaveBeenCalledWith("a", 30_000, undefined, "ios:7");
  });

  test("uses the socket autolock device when deviceId is omitted", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const session = createFakeSession("session-1", "emulator-5554", "android");
    const autolockSessions = new Map([[session.sessionId, session]]);
    const mcpAutolockSessions = new Map<string, string>();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(autolockSessions, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    const response = await sendRequestAfterConnect(
      socketPath,
      {
        id: randomUUID(),
        type: "mcp_request",
        method: "input/typeText",
        params: {
          platform: "android",
          text: "from session",
        },
      },
      () => {
        const socketSessionId = [
          ...(server as unknown as { sessions: Map<string, unknown> }).sessions.keys(),
        ][0];
        mcpAutolockSessions.set(socketSessionId, session.sessionId);
      },
    );

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      platform: "android",
      deviceId: "emulator-5554",
      textLength: 12,
    });
    expect(requestSetText).toHaveBeenCalledWith("from session", { timeoutMs: 30_000 });
    expect(requestImeAction).not.toHaveBeenCalled();
  });

  test("forwards an Android frame context to CtrlProxy text input", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction: mock(async () => ({ success: true, totalTimeMs: 1 })),
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    (server as unknown as { requireCurrentFrameContext: () => void }).requireCurrentFrameContext =
      () => {};
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "context-bound",
      frameContext: "frame-1",
    });

    expect(response.success).toBe(true);
    expect(requestSetText).toHaveBeenCalledWith("context-bound", {
      timeoutMs: 30_000,
      frameContext: "frame-1",
    });
  });

  test("rejects stale context after append capability discovery and before key events", async () => {
    const adb = new ProductionShapedAdbExecutor(fakeTimer, { probeApiLevel: 31 });
    const validateFrameContext = mock(async () => ({
      success: false,
      error: "Stale frame context; observe a fresh frame before retrying",
    }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      validateFrameContext,
      requestImeAction: mock(async () => ({ success: true, totalTimeMs: 1 })),
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    server.appendTextFactory = (device) => createAppendTextInput(device, adb, fakeTimer);
    (server as unknown as { requireCurrentFrameContext: () => void }).requireCurrentFrameContext =
      () => {};
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "A",
      mode: "append",
      frameContext: "epoch:2",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Stale frame context");
    expect(validateFrameContext).toHaveBeenCalledWith("epoch:2", 30_000);
    expect(adb.probeCalls).toEqual([30_000]);
    expect(adb.inputCommands()).toEqual([]);
  });

  test("does not emit append key events when validation exhausts the shared deadline", async () => {
    const adb = new ScriptedAdbExecutor(fakeTimer);
    const validateFrameContext = mock(async () => {
      fakeTimer.advanceTime(30_000);
      return { success: true };
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      validateFrameContext,
      requestImeAction: mock(async () => ({ success: true, totalTimeMs: 1 })),
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    server.appendTextFactory = (device) => createAppendTextInput(device, adb, fakeTimer);
    (server as unknown as { requireCurrentFrameContext: () => void }).requireCurrentFrameContext =
      () => {};
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "a",
      mode: "append",
      frameContext: "epoch:3",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("input/typeText exceeded 30000ms");
    expect(validateFrameContext).toHaveBeenCalledWith("epoch:3", 30_000);
    expect(adb.inputCommands()).toEqual([]);
  });

  test("validates a multi-character append once before the first key event", async () => {
    const adb = new ScriptedAdbExecutor(fakeTimer);
    let validationCount = 0;
    const validateFrameContext = mock(async () => {
      validationCount += 1;
      return { success: true };
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      validateFrameContext,
      requestImeAction: mock(async () => ({ success: true, totalTimeMs: 1 })),
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    server.appendTextFactory = (device) => createAppendTextInput(device, adb, fakeTimer);
    (server as unknown as { requireCurrentFrameContext: () => void }).requireCurrentFrameContext =
      () => {};
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "ab",
      mode: "append",
      frameContext: "epoch:4",
    });

    expect(response).toMatchObject({
      success: true,
      result: { success: true, textLength: 2 },
    });
    expect(validationCount).toBe(1);
    expect(adb.inputCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
    ]);
  });

  test("serializes concurrent typeText calls for the same device", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requestSetText = mock(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        fakeTimer.setTimeout(resolve, 40);
      });
      inFlight -= 1;
      return { success: true, totalTimeMs: 1 };
    });
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const firstPromise = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "first",
    });
    const secondPromise = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "second",
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    fakeTimer.advanceTime(40);
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    fakeTimer.advanceTime(40);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(requestSetText).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("fails typeText when execution exceeds the socket timeout budget", async () => {
    const requestSetText = mock(async () => {
      await new Promise<void>((resolve) => {
        fakeTimer.setTimeout(resolve, 100);
      });
      return { success: true, totalTimeMs: 1 };
    });
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const responsePromise = sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "slow",
      },
      1,
    );

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    fakeTimer.advanceTime(1);
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    fakeTimer.advanceTime(99);

    const response = await responsePromise;

    expect(response.success).toBe(false);
    expect(response.error).toContain("input/typeText exceeded 1ms");
    expect(response.error).toContain("operation exceeded remaining budget 1ms");
    expect(requestSetText).toHaveBeenCalledWith("slow", { timeoutMs: 1 });
    expect(requestImeAction).not.toHaveBeenCalled();
  });

  test("keeps same-device typeText serialized until a timed-out operation settles", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requestSetText = mock(async (text: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (text === "first") {
        await new Promise<void>((resolve) => {
          fakeTimer.setTimeout(resolve, 100);
        });
      }
      inFlight -= 1;
      return { success: true, totalTimeMs: 1 };
    });
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const firstPromise = sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "first",
      },
      1,
    );

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    fakeTimer.advanceTime(1);

    const secondPromise = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "second",
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(requestSetText).toHaveBeenCalledTimes(1);
    expect(inFlight).toBe(1);

    fakeTimer.advanceTime(99);
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.success).toBe(false);
    expect(second.success).toBe(true);
    expect(requestSetText).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("fails when submit action fails after text input succeeds", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({
      success: false,
      error: "return key unavailable",
      totalTimeMs: 1,
    }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "ios",
      deviceId: "ios-sim-1",
      text: "hi there",
      submit: true,
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("return key unavailable");
    expect(response.charsSent).toBeUndefined();
    expect(requestSetText).toHaveBeenCalledWith("hi there", { timeoutMs: 30_000 });
    expect(requestImeAction).toHaveBeenCalledWith("done", 30_000);
  });

  test("charges the submit IME action against the remaining shared budget", async () => {
    const requestSetText = mock(async () => {
      await new Promise<void>((resolve) => {
        fakeTimer.setTimeout(resolve, 40);
      });
      return { success: true, totalTimeMs: 1 };
    });
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const responsePromise = sendRequest(
      socketPath,
      "input/typeText",
      {
        platform: "android",
        deviceId: "emulator-5554",
        text: "hello",
        submit: true,
      },
      100,
    );

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    fakeTimer.advanceTime(40);
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const response = await responsePromise;

    expect(response.success).toBe(true);
    // set-text consumed 40ms of the 100ms budget, so the IME action gets the
    // remaining 60ms rather than a fresh full timeout.
    expect(requestSetText).toHaveBeenCalledWith("hello", { timeoutMs: 100 });
    expect(requestImeAction).toHaveBeenCalledWith("done", 60);
  });

  test("rejects missing, empty, and non-string text with actionable errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();

    const missing = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
    });
    const empty = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "",
    });
    const nonString = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: 123,
    });
    const nonBooleanSubmit = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "hello",
      submit: "true",
    });
    // `mode` is now a supported param, but only the value "append" (#3351):
    // the other InputText modes are replace-shaped and have no meaning here.
    const unsupportedMode = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "hello",
      mode: "eventAll",
    });
    const unsupportedImeAction = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "hello",
      imeAction: "done",
    });
    const unsupportedDismissKeyboard = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "hello",
      dismissKeyboard: true,
    });

    expect(missing.success).toBe(false);
    expect(missing.error).toBe("input/typeText requires non-empty string text param");
    expect(empty.success).toBe(false);
    expect(empty.error).toBe("input/typeText requires non-empty string text param");
    expect(nonString.success).toBe(false);
    expect(nonString.error).toBe("input/typeText requires non-empty string text param");
    expect(nonBooleanSubmit.success).toBe(false);
    expect(nonBooleanSubmit.error).toBe("input/typeText submit must be a boolean when provided");
    expect(unsupportedMode.success).toBe(false);
    expect(unsupportedMode.error).toBe('input/typeText mode must be "append" when provided');
    expect(unsupportedImeAction.success).toBe(false);
    expect(unsupportedImeAction.error).toBe("input/typeText unsupported params: imeAction");
    expect(unsupportedDismissKeyboard.success).toBe(false);
    expect(unsupportedDismissKeyboard.error).toBe(
      "input/typeText unsupported params: dismissKeyboard",
    );
  });
});
