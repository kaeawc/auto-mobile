import { describe, expect, test } from "bun:test";
import {
  AdbClient,
  AdbCommandTimeoutError,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, ExecResult } from "../../../src/models";
import {
  onAdbMissingDevice,
  type AdbMissingDeviceEvent,
} from "../../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import { FakeEmulatorConsoleBusyRegistry } from "../../fakes/FakeEmulatorConsoleBusyRegistry";

const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  isEmulator: true,
  name: "Test Device",
};

function ok(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

function autoRetrySeam(): [DefaultRetryExecutor, FakeTimer] {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return [new DefaultRetryExecutor(timer), timer];
}

describe("AdbClient retry contract", () => {
  test("runs beforeDispatch after path resolution and before the ADB subprocess", async () => {
    const events: string[] = [];
    const client = new AdbClient(
      DEVICE,
      async () => {
        events.push("dispatch");
        return ok("");
      },
      null,
      ...autoRetrySeam(),
    );
    const internals = client as unknown as {
      getBaseCommandParts: () => Promise<{ adbPath: string; baseArgs: string[] }>;
    };
    internals.getBaseCommandParts = async () => {
      events.push("path-resolved");
      return { adbPath: "adb", baseArgs: [] };
    };

    await client.execute(["shell", "input", "keyevent", "KEYCODE_TAB"], {
      timeoutMs: 1234,
      noRetry: true,
      beforeDispatch: async (timeoutMs) => {
        events.push(`validated:${timeoutMs}`);
      },
    });

    expect(events).toEqual(["path-resolved", "validated:1234", "dispatch"]);
  });

  test("does not dispatch when beforeDispatch rejects", async () => {
    let dispatches = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        dispatches += 1;
        return ok("");
      },
      null,
      ...autoRetrySeam(),
    );

    await expect(
      client.execute(["shell", "input", "keyevent", "KEYCODE_TAB"], {
        noRetry: true,
        beforeDispatch: async () => {
          throw new Error("stale frame context");
        },
      }),
    ).rejects.toThrow("stale frame context");

    expect(dispatches).toBe(0);
  });

  test("retries a transient failure and succeeds within MAX_ADB_RETRIES", async () => {
    let calls = 0;
    const exec = (): Promise<ExecResult> => {
      calls += 1;
      if (calls < 3) {
        return Promise.reject(new Error("adb transient blip"));
      }
      return Promise.resolve(ok("recovered"));
    };
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    const result = await client.executeCommand("shell echo hi");

    expect(result.stdout).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("gives up after MAX_ADB_RETRIES+1 attempts on a persistent transient failure", async () => {
    let calls = 0;
    const exec = (): Promise<ExecResult> => {
      calls += 1;
      return Promise.reject(new Error("adb transient blip"));
    };
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    await expect(client.executeCommand("shell echo hi")).rejects.toThrow("adb transient blip");
    // MAX_ADB_RETRIES = 3, so the initial attempt plus 3 retries == 4 executions.
    expect(calls).toBe(4);
  });

  test("retries a persistent offline failure with bounded backoff", async () => {
    let calls = 0;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const exec = (): Promise<ExecResult> => {
      calls += 1;
      return Promise.reject(new Error("error: device offline"));
    };
    const client = new AdbClient(DEVICE, exec, null, new DefaultRetryExecutor(timer), timer);

    await expect(client.executeCommand("shell echo hi")).rejects.toThrow("offline");
    expect(calls).toBe(4);
    expect(timer.getSleepHistory()).toEqual([200, 500, 1000]);
    expect(timer.getCurrentTime()).toBe(1_700);
  });

  test("outlasts a protocol fault that clears after 1.5 seconds", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const dispatchTimes: number[] = [];
    const client = new AdbClient(
      DEVICE,
      async () => {
        dispatchTimes.push(timer.now());
        if (timer.now() < 1_500) {
          throw new Error("protocol fault (couldn't read status): Connection reset by peer");
        }
        return ok("recovered");
      },
      null,
      new DefaultRetryExecutor(timer),
      timer,
    );

    expect((await client.executeCommand("shell echo hi")).stdout).toBe("recovered");
    expect(dispatchTimes).toEqual([0, 200, 700, 1_700]);
    expect(timer.getSleepHistory()).toEqual([200, 500, 1000]);
  });

  test("does not delay or retry a deterministic command error", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let dispatches = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        dispatches += 1;
        throw new Error("unknown command");
      },
      null,
      new DefaultRetryExecutor(timer),
      timer,
    );

    await expect(client.executeCommand("shell echo hi")).rejects.toThrow("unknown command");
    expect(dispatches).toBe(1);
    expect(timer.now()).toBe(0);
  });

  test("does not retry a non-mutating command that times out at its deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let dispatches = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        dispatches += 1;
        throw new AdbCommandTimeoutError("Command timed out after 5000ms: adb shell getprop");
      },
      null,
      new DefaultRetryExecutor(timer),
      timer,
    );

    await expect(client.executeCommand("shell getprop")).rejects.toThrow(
      "Command timed out after 5000ms",
    );
    // A dispatch timeout has, by construction, already consumed the whole
    // command budget: one dispatch, no backoff sleeps, no retries (#7536).
    expect(dispatches).toBe(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("does not replay a delivered mutation after an offline error", async () => {
    let dispatches = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        dispatches += 1;
        throw new Error("error: device offline");
      },
      null,
      ...autoRetrySeam(),
    );

    await expect(client.executeCommand("shell input tap 10 20")).rejects.toThrow("offline");
    expect(dispatches).toBe(1);
  });

  test.each([
    "shell input tap 10 20",
    "shell input swipe 10 20 30 40",
    "shell input keyevent KEYCODE_ENTER",
    "shell input text hello",
    "shell input",
    "shell keyevent KEYCODE_ENTER",
    "shell key KEYCODE_ENTER",
    "shell am start -n example/.MainActivity",
  ])("does not replay a possibly delivered mutation: %s", async (command) => {
    let calls = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        throw new Error("error: closed");
      },
      null,
      ...autoRetrySeam(),
    );

    await expect(client.executeCommand(command)).rejects.toThrow("error: closed");
    expect(calls).toBe(1);
  });

  test("does not replay a mutation passed as separate argv entries", async () => {
    let calls = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        throw new Error("protocol fault");
      },
      null,
      ...autoRetrySeam(),
    );

    await expect(client.execute(["shell", "input", "tap", "10", "20"])).rejects.toThrow(
      "protocol fault",
    );
    expect(calls).toBe(1);
  });

  test.each(["cannot connect to daemon", "CANNOT CONNECT TO ADB", "Executable not found"])(
    "retries a mutation after a pre-dispatch failure: %s",
    async (message) => {
      let calls = 0;
      const client = new AdbClient(
        DEVICE,
        async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error(message);
          }
          return ok("recovered");
        },
        null,
        ...autoRetrySeam(),
      );

      const result = await client.executeCommand("shell input tap 10 20");
      expect(result.stdout).toBe("recovered");
      expect(calls).toBe(2);
    },
  );

  test("keeps retrying a read-only query after a transient failure", async () => {
    let calls = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("error: closed");
        }
        return ok("1");
      },
      null,
      ...autoRetrySeam(),
    );

    const result = await client.executeCommand("shell getprop sys.boot_completed");
    expect(result.stdout).toBe("1");
    expect(calls).toBe(2);
  });

  test("keeps the existing non-retryable device error ahead of pre-dispatch checks", async () => {
    let calls = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        throw new Error("cannot connect to daemon: device not found");
      },
      null,
      ...autoRetrySeam(),
    );

    await expect(client.executeCommand("shell input tap 10 20")).rejects.toThrow(
      "device not found",
    );
    expect(calls).toBe(1);
  });
});

describe("AdbClient missing-device notifications", () => {
  test("does not forward a transient missing-device error while the emulator console is busy", async () => {
    const busyRegistry = new FakeEmulatorConsoleBusyRegistry();
    const notifications: AdbMissingDeviceEvent[] = [];
    const stopListening = onAdbMissingDevice((event) => notifications.push(event));
    const client = new AdbClient(
      DEVICE,
      async () => {
        throw new Error("adb: device 'emulator-5554' not found");
      },
      null,
      ...autoRetrySeam(),
      undefined,
      undefined,
      busyRegistry,
    );

    try {
      await busyRegistry.runExclusive(DEVICE.deviceId, async () => {
        await expect(
          client.executeCommand("shell getprop sys.boot_completed", undefined, undefined, true),
        ).rejects.toThrow("device 'emulator-5554' not found");
      });
      expect(notifications).toEqual([]);
    } finally {
      stopListening();
    }
  });

  test("forwards a missing-device error while the emulator console is idle", async () => {
    const busyRegistry = new FakeEmulatorConsoleBusyRegistry();
    const notifications: AdbMissingDeviceEvent[] = [];
    const stopListening = onAdbMissingDevice((event) => notifications.push(event));
    const client = new AdbClient(
      DEVICE,
      async () => {
        throw new Error("adb: device 'emulator-5554' not found");
      },
      null,
      ...autoRetrySeam(),
      undefined,
      undefined,
      busyRegistry,
    );

    try {
      await expect(
        client.executeCommand("shell getprop sys.boot_completed", undefined, undefined, true),
      ).rejects.toThrow("device 'emulator-5554' not found");
      expect(notifications).toEqual([expect.objectContaining({ deviceId: DEVICE.deviceId })]);
    } finally {
      stopListening();
    }
  });

  test("does not forward a missing-device error dispatched before the console becomes idle", async () => {
    const busyRegistry = new FakeEmulatorConsoleBusyRegistry();
    const notifications: AdbMissingDeviceEvent[] = [];
    const stopListening = onAdbMissingDevice((event) => notifications.push(event));
    const rejection = Promise.withResolvers<ExecResult>();
    const dispatched = Promise.withResolvers<void>();
    const client = new AdbClient(
      DEVICE,
      async () => {
        dispatched.resolve();
        return await rejection.promise;
      },
      null,
      ...autoRetrySeam(),
      undefined,
      undefined,
      busyRegistry,
    );

    try {
      busyRegistry.setBusy(DEVICE.deviceId, true);
      const command = client.executeCommand(
        "shell getprop sys.boot_completed",
        undefined,
        undefined,
        true,
      );
      await dispatched.promise;
      busyRegistry.setBusy(DEVICE.deviceId, false);
      rejection.reject(new Error("adb: device 'emulator-5554' not found"));

      await expect(command).rejects.toThrow("device 'emulator-5554' not found");
      expect(notifications).toEqual([]);
    } finally {
      stopListening();
    }
  });
});

describe("AdbClient abort-reason preservation", () => {
  function alwaysThrows(): Promise<ExecResult> {
    return Promise.reject(new Error("underlying exec failure"));
  }

  test("preserves a device-disconnected abort reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("device-disconnected:emulator-5554"));
    const client = new AdbClient(DEVICE, alwaysThrows, null, ...autoRetrySeam());

    await expect(
      client.executeCommand("shell echo hi", undefined, undefined, true, controller.signal),
    ).rejects.toThrow("device-disconnected:emulator-5554");
  });

  test("falls back to the generic cancellation message for a non-disconnect reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("some unrelated reason"));
    const client = new AdbClient(DEVICE, alwaysThrows, null, ...autoRetrySeam());

    await expect(
      client.executeCommand("shell echo hi", undefined, undefined, true, controller.signal),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
  });

  test("uses the generic cancellation message when aborted without a reason", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new AdbClient(DEVICE, alwaysThrows, null, ...autoRetrySeam());

    await expect(
      client.executeCommand("shell echo hi", undefined, undefined, true, controller.signal),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
  });
});

describe("AdbClient.getAndroidApiLevel caching", () => {
  const GETPROP = "getprop ro.build.version.sdk";

  test("caches a successful read and does not re-probe", async () => {
    let calls = 0;
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes(GETPROP)) {
        calls += 1;
      }
      return Promise.resolve(ok("34"));
    };
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    expect(await client.getAndroidApiLevel()).toBe(34);
    expect(await client.getAndroidApiLevel()).toBe(34);
    expect(calls).toBe(1);
  });

  test("caches a failed read so it does not re-probe a device that cannot answer", async () => {
    let calls = 0;
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes(GETPROP)) {
        calls += 1;
        return Promise.reject(new Error("getprop failed: device offline"));
      }
      return Promise.resolve(ok(""));
    };
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    expect(await client.getAndroidApiLevel()).toBeNull();
    expect(await client.getAndroidApiLevel()).toBeNull();
    // The failure is cached: exactly one probe, not one per call.
    expect(calls).toBe(1);
  });

  test("re-probes after setDevice clears the cache", async () => {
    let calls = 0;
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes(GETPROP)) {
        calls += 1;
      }
      return Promise.resolve(ok("30"));
    };
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    expect(await client.getAndroidApiLevel()).toBe(30);
    client.setDevice({ ...DEVICE, deviceId: "emulator-5556" });
    expect(await client.getAndroidApiLevel()).toBe(30);
    expect(calls).toBe(2);
  });
});

describe("AdbClient.getDeviceTimestampMs three-tier fallback", () => {
  test("returns millisecond device time from the +%s%3N tier", async () => {
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes("+%s%3N")) {
        return Promise.resolve(ok("1700000000123"));
      }
      return Promise.resolve(ok(""));
    };
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    expect(await client.getDeviceTimestampMs()).toBe(1700000000123);
    expect(await client.getDeviceTimestampMsWithSource()).toEqual({
      timestampMs: 1700000000123,
      source: "device-ms",
    });
  });

  test("rejects literal %3N suffixes instead of treating seconds as milliseconds", async () => {
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes("+%s%3N")) {
        return Promise.resolve(ok("1754063999%3N"));
      }
      if (command.includes("+%s")) {
        return Promise.resolve(ok("1700000000"));
      }
      return Promise.resolve(ok(""));
    };
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    expect(await client.getDeviceTimestampMs()).toBe(1700000000000);
    expect(await client.getDeviceTimestampMsWithSource()).toEqual({
      timestampMs: 1700000000000,
      source: "device-seconds",
    });
  });

  test("scales seconds to milliseconds when the millisecond tier yields nothing usable", async () => {
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes("+%s%3N")) {
        return Promise.resolve(ok("")); // unusable -> falls through to the seconds tier
      }
      if (command.includes("+%s")) {
        return Promise.resolve(ok("1700000000"));
      }
      return Promise.resolve(ok(""));
    };
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    // The *1000 scaling is the whole point of the seconds tier.
    expect(await client.getDeviceTimestampMs()).toBe(1700000000000);
  });

  test("rejects seconds values whose millisecond conversion is not safe", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_650_000_000_000);
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes("+%s%3N")) {
        return Promise.resolve(ok(""));
      }
      if (command.includes("+%s")) {
        return Promise.resolve(ok("9007199254740991"));
      }
      return Promise.resolve(ok(""));
    };
    const client = new AdbClient(DEVICE, exec, null, new DefaultRetryExecutor(timer), timer);

    expect(await client.getDeviceTimestampMsWithSource()).toEqual({
      timestampMs: 1_650_000_000_000,
      source: "host",
    });
  });

  test("falls back to the host clock when both device tiers fail", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_650_000_000_000);
    const exec = (): Promise<ExecResult> => Promise.reject(new Error("device offline"));
    timer.enableAutoAdvance();
    const client = new AdbClient(DEVICE, exec, null, new DefaultRetryExecutor(timer), timer);

    expect(await client.getDeviceTimestampMs()).toBe(1_650_000_000_000);
    expect(await client.getDeviceTimestampMsWithSource()).toEqual({
      timestampMs: 1_650_000_000_000,
      source: "host",
    });
  });
});

describe("AdbClient argv construction (parseCommandArgs)", () => {
  function recorder(): {
    argvs: string[][];
    exec: (file: string, args: string[], maxBuffer: number | undefined) => Promise<ExecResult>;
  } {
    const argvs: string[][] = [];
    const exec = (
      _file: string,
      args: string[],
      _maxBuffer: number | undefined,
    ): Promise<ExecResult> => {
      argvs.push(args);
      return Promise.resolve(ok(""));
    };
    return { argvs, exec };
  }

  test("prefixes the target serial with -s and keeps a quoted shell command as one argument", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    await client.executeCommand('shell "pm list packages | grep foo"');

    expect(argvs).toEqual([["-s", "emulator-5554", "shell", "pm list packages | grep foo"]]);
  });

  test("keeps a single-quoted shell payload intact including the pipe", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    await client.executeCommand("shell 'echo a | cat'");

    expect(argvs).toEqual([["-s", "emulator-5554", "shell", "echo a | cat"]]);
  });

  test("preserves spaces inside a double-quoted argument for a non-shell command", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    await client.executeCommand('install "/tmp/my app.apk"');

    expect(argvs).toEqual([["-s", "emulator-5554", "install", "/tmp/my app.apk"]]);
  });

  test("splits an unquoted command into separate argv tokens", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());

    await client.executeCommand("push local.txt /sdcard/remote.txt");

    expect(argvs).toEqual([["-s", "emulator-5554", "push", "local.txt", "/sdcard/remote.txt"]]);
  });

  test("omits the -s prefix when no device is targeted", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(null, exec, null, ...autoRetrySeam());

    await client.executeCommand("devices");

    expect(argvs).toEqual([["devices"]]);
  });
});
