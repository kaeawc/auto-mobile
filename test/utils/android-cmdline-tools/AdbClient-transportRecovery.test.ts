import { describe, expect, test } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import {
  AdbDeviceTransportUnavailableError,
  findDeviceTransportUnavailable,
} from "../../../src/utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import { onAdbMissingDevice } from "../../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import { DeviceLostError } from "../../../src/models/DeviceLostError";
import { rememberDeviceLossAbort } from "../../../src/utils/deviceLossAbortRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { fixedBackoff } from "../../../src/utils/Backoff";
import { createExecResult } from "../../../src/utils/execResult";
import { wrapCommandError } from "../../../src/utils/CommandError";
import type { BootedDevice } from "../../../src/models";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const missing = () => new Error("adb: device 'emulator-5554' not found");
const rejected = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

// Captured post-dispatch wording: https://github.com/kaeawc/auto-mobile/issues/13822.
const postDispatchLoss = (stderr = "connection terminated: read failed", code = 1) =>
  new Error("Command failed: adb -s emulator-5554 shell am start", {
    cause: Object.assign(new Error("Command failed: adb"), { stderr: Buffer.from(stderr), code }),
  });

function harness(
  failures = Infinity,
  error = missing(),
  target: BootedDevice | null = device,
  autoAdvance = true,
) {
  const timer = new FakeTimer();
  if (autoAdvance) {
    timer.enableAutoAdvance();
  }
  let calls = 0;
  const client = new AdbClient(
    target,
    async () => {
      calls++;
      if (calls <= failures) {
        throw error;
      }
      return createExecResult("recovered", "");
    },
    { timer, retryExecutor: new DefaultRetryExecutor(timer) },
  );
  return { client, timer, calls: () => calls };
}

describe("ADB pre-dispatch transport recovery", () => {
  test.each([
    { noRetry: false, failures: 1 },
    { noRetry: false, failures: 2 },
    { noRetry: true, failures: 1 },
    { noRetry: true, failures: 2 },
  ])(
    "own serial recovers before notifying (noRetry=$noRetry failures=$failures)",
    async ({ noRetry, failures }) => {
      const h = harness(failures);
      const notifications: string[] = [];
      const stop = onAdbMissingDevice((event) => notifications.push(event.deviceId));
      try {
        expect((await h.client.executeCommand("shell input tap 1 2", { noRetry })).stdout).toBe(
          "recovered",
        );
        expect(h.calls()).toBe(failures + 1);
        expect(h.timer.getSleepHistory()).toEqual([250, 500].slice(0, failures));
        expect(notifications).toEqual([]);
      } finally {
        stop();
        h.timer.reset();
      }
    },
  );

  test.each([false, true])(
    "exhaustion stays typed and notifies once (noRetry=%s)",
    async (noRetry) => {
      const original = missing();
      const h = harness(Infinity, original);
      const notifications: string[] = [];
      const stop = onAdbMissingDevice((event) => notifications.push(event.deviceId));
      try {
        const error = await rejected(h.client.executeCommand("shell input tap 1 2", { noRetry }));
        expect(error).toBeInstanceOf(AdbDeviceTransportUnavailableError);
        expect(error).toMatchObject({
          code: "device_transport_unavailable",
          retryable: true,
          retryAfterMs: 1000,
          dispatched: false,
          deviceId: device.deviceId,
          cause: original,
        });
        expect(String(error)).toContain("adb: device 'emulator-5554' not found");
        expect(h.calls()).toBe(5);
        expect(h.timer.getSleepHistory()).toEqual([250, 500, 1000, 2000]);
        expect(notifications).toEqual([device.deviceId]);
      } finally {
        stop();
        h.timer.reset();
      }
    },
  );

  test.each([
    new Error("adb: device 'emulator-5556' not found"),
    new Error("no devices/emulators found"),
  ])("unattributed transport refusal never waits: %s", async (original) => {
    const h = harness(Infinity, original);
    expect(await rejected(h.client.executeCommand("shell getprop foo"))).toBe(original);
    expect(h.timer.getSleepHistory()).toEqual([]);
    expect(h.calls()).toBe(1);
  });

  test("a client without a device does not wait", async () => {
    const original = missing();
    const h = harness(Infinity, original, null);
    expect(await rejected(h.client.executeCommand("devices"))).toBe(original);
    expect(h.calls()).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("offline refusal recovers even for a non-idempotent command", async () => {
    const h = harness(1, new Error("error: device offline"));
    expect((await h.client.executeCommand("shell input tap 1 2")).stdout).toBe("recovered");
    expect(h.timer.getSleepHistory()).toEqual([250]);
  });

  test("injected backoff is bounded by the transport window", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const client = new AdbClient(
      device,
      async () => {
        throw missing();
      },
      { timer, transportBackoff: fixedBackoff(10000) },
    );
    expect(await rejected(client.executeCommand("shell input tap 1 2"))).toBeInstanceOf(
      AdbDeviceTransportUnavailableError,
    );
    expect(timer.now()).toBe(3750);
    expect(timer.getSleepHistory()).toEqual([3750]);
  });

  test("remaining command budget includes time spent in commands", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let calls = 0;
    const client = new AdbClient(
      device,
      async () => {
        calls++;
        timer.advanceTime(100);
        throw missing();
      },
      { timer },
    );
    expect(
      await rejected(client.executeCommand("shell input tap 1 2", { timeoutMs: 500 })),
    ).toBeInstanceOf(AdbDeviceTransportUnavailableError);
    expect(timer.now()).toBe(500);
    expect(timer.getSleepHistory()).toEqual([250, 50]);
    expect(calls).toBe(2);
  });

  test("wait consumes at most the remaining timeout budget", async () => {
    const h = harness();
    expect(
      await rejected(h.client.executeCommand("shell input tap 1 2", { timeoutMs: 300 })),
    ).toBeInstanceOf(AdbDeviceTransportUnavailableError);
    expect(h.timer.now()).toBe(300);
    expect(h.timer.getSleepHistory()).toEqual([250, 50]);
    expect(h.calls()).toBe(2);
  });

  test.each([false, true])(
    "abort during wait stops immediately, preserving device loss=%s",
    async (lost) => {
      const h = harness(Infinity, missing(), device, false);
      const controller = new AbortController();
      const reason = lost
        ? new DeviceLostError(device.deviceId, "confirmed loss")
        : new Error("cancel request");
      const result = rejected(
        h.client.executeCommand("shell input tap 1 2", { signal: controller.signal }),
      );
      for (let turn = 0; turn < 30; turn++) {
        await Promise.resolve();
      }
      expect(h.timer.getPendingTimeoutCount()).toBe(1);
      if (reason instanceof DeviceLostError) {
        rememberDeviceLossAbort(controller.signal, reason);
      }
      controller.abort(lost ? undefined : reason);
      const error = await result;
      if (lost) {
        expect(error).toBe(reason);
      } else {
        expect(String(error)).toContain("cancel request");
      }
      expect(h.calls()).toBe(1);
      expect(h.timer.now()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      h.timer.reset();
    },
  );

  test("a DeviceLostError from the next execution is terminal", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const lost = new DeviceLostError(device.deviceId, "device offline");
    let calls = 0;
    const client = new AdbClient(
      device,
      async () => {
        calls++;
        throw calls === 1 ? missing() : lost;
      },
      { timer },
    );
    expect(await rejected(client.executeCommand("shell getprop foo"))).toBe(lost);
    expect(calls).toBe(2);
    expect(timer.getSleepHistory()).toEqual([250]);
  });

  test("raw exec stderr survives in the typed message and cause", async () => {
    const original = Object.assign(new Error("Command failed: adb shell input tap 1 2"), {
      stderr: Buffer.from("adb: device 'emulator-5554' not found"),
    });
    const h = harness(Infinity, original);
    const error = await rejected(h.client.executeCommand("shell input tap 1 2"));
    expect(error).toBeInstanceOf(AdbDeviceTransportUnavailableError);
    expect(error).toMatchObject({
      cause: original,
      message: expect.stringContaining("adb: device 'emulator-5554' not found"),
    });
  });

  test("cause lookup is cycle safe and confirmed loss wins", () => {
    const typed = new AdbDeviceTransportUnavailableError(device.deviceId, missing());
    const wrapped = new Error("context", { cause: typed });
    expect(findDeviceTransportUnavailable(wrapped)).toBe(typed);
    typed.cause = new DeviceLostError(device.deviceId, "confirmed");
    expect(findDeviceTransportUnavailable(wrapped)).toBeUndefined();
    wrapped.cause = wrapped;
    expect(findDeviceTransportUnavailable(wrapped)).toBeUndefined();
  });
});

describe("ADB post-dispatch transport loss", () => {
  test.each([false, true])("non-safe command dispatches once (noRetry=%s)", async (noRetry) => {
    const original = postDispatchLoss();
    const h = harness(Infinity, original);
    const error = await rejected(
      h.client.execute(
        ["shell", "am start -a android.intent.action.VIEW -d 'myapp://single-use'"],
        {
          noRetry,
        },
      ),
    );
    expect(error).toBeInstanceOf(AdbDeviceTransportUnavailableError);
    expect(error).toMatchObject({
      code: "device_transport_unavailable",
      retryable: true,
      retryAfterMs: 1000,
      dispatched: "unknown",
      cause: original,
    });
    expect(String(error)).toContain("may already have run");
    expect(String(error)).toContain("Observe before reissuing a non-idempotent command");
    expect(h.calls()).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("safe reads retain general retries and can recover", async () => {
    const h = harness(2, postDispatchLoss());
    expect((await h.client.execute(["shell", "getprop foo"])).stdout).toBe("recovered");
    expect(h.calls()).toBe(3);
    expect(h.timer.getSleepHistory()).toEqual([200, 500]);
  });

  test("safe read exhaustion is typed with unknown dispatch", async () => {
    const h = harness(Infinity, postDispatchLoss());
    expect(await rejected(h.client.execute(["shell", "getprop foo"]))).toMatchObject({
      code: "device_transport_unavailable",
      retryable: true,
      dispatched: "unknown",
    });
    expect(h.calls()).toBe(4);
    expect(h.timer.getSleepHistory()).toEqual([200, 500, 1000]);
  });

  test("exit 255 preserves pre-dispatch retries for a non-safe command", async () => {
    const original = Object.assign(new Error("cannot connect to adb"), {
      code: 255,
      stdout: "",
      stderr: "",
    });
    const h = harness(Infinity, original);
    expect(await rejected(h.client.execute(["shell", "input tap 1 2"]))).toBe(original);
    expect(h.calls()).toBe(4);
    expect(h.timer.getSleepHistory()).toEqual([200, 500, 1000]);
  });

  test("message-less exit 255 with empty streams dispatches a non-safe command once", async () => {
    const original = Object.assign(new Error(""), { code: 255, stdout: "", stderr: "" });
    const h = harness(Infinity, original);
    expect(await rejected(h.client.execute(["shell", "input tap 1 2"]))).toMatchObject({
      code: "device_transport_unavailable",
      dispatched: "unknown",
    });
    expect(h.calls()).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test.each<{ command: string; attempts: number; delays: number[] }>([
    { command: "input tap 1 2", attempts: 1, delays: [] },
    { command: "getprop foo", attempts: 4, delays: [200, 500, 1000] },
  ])(
    "exit 255 with remote stdout preserves the original error and retries for $command",
    async ({ command, attempts, delays }) => {
      const original = wrapCommandError(
        Object.assign(new Error("Command failed: adb shell"), {
          code: 255,
          stdout: Buffer.from("Unknown command: bar\n"),
          stderr: Buffer.from(""),
        }),
        { command: "adb", args: ["-s", device.deviceId, "shell", command] },
      );
      const h = harness(Infinity, original);
      expect(await rejected(h.client.execute(["shell", command]))).toBe(original);
      expect(h.calls()).toBe(attempts);
      expect(h.timer.getSleepHistory()).toEqual(delays);
    },
  );

  test.each(["error: closed", "protocol fault", ""])(
    "types transport stderr %s with exit 255",
    async (stderr) => {
      const h = harness(Infinity, postDispatchLoss(stderr, 255));
      expect(await rejected(h.client.execute(["shell", "input tap 1 2"]))).toMatchObject({
        dispatched: "unknown",
        retryable: true,
      });
      expect(h.calls()).toBe(1);
    },
  );

  test.each([
    Object.assign(
      new Error("Command failed: adb shell echo 'connection terminated: read failed'"),
      { code: 1 },
    ),
    Object.assign(new Error("Command failed: adb shell"), {
      stdout: "error: closed",
      stderr: "remote command failed",
      code: 255,
    }),
    Object.assign(new Error("connection terminated: read failed"), { code: 1 }),
    postDispatchLoss("adb: device 'emulator-5556': error: closed", 255),
  ])("ignores argv, stdout, standalone messages and other serials", async (original) => {
    const h = harness(Infinity, original);
    expect(await rejected(h.client.execute(["shell", "input tap 1 2"]))).toBe(original);
    expect(h.calls()).toBe(1);
  });

  test("a client without a selected device cannot attribute the transport failure", async () => {
    const original = postDispatchLoss();
    const h = harness(Infinity, original, null);
    expect(await rejected(h.client.execute(["shell", "input tap 1 2"]))).toBe(original);
    expect(h.calls()).toBe(1);
  });

  test.each([false, true])("confirmed loss wins over unknown dispatch (safe=%s)", async (safe) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const controller = new AbortController();
    const lost = new DeviceLostError(device.deviceId, "confirmed loss");
    let calls = 0;
    const client = new AdbClient(
      device,
      async () => {
        calls++;
        rememberDeviceLossAbort(controller.signal, lost);
        controller.abort();
        throw postDispatchLoss();
      },
      { timer, retryExecutor: new DefaultRetryExecutor(timer) },
    );
    expect(
      await rejected(
        client.execute(["shell", safe ? "getprop foo" : "input tap 1 2"], {
          signal: controller.signal,
        }),
      ),
    ).toBe(lost);
    expect(calls).toBe(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });
});
