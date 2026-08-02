import { describe, expect, test } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { defaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, ExecResult } from "../../../src/models";

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
      defaultRetryExecutor,
      new FakeTimer()
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
      beforeDispatch: async timeoutMs => {
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
      defaultRetryExecutor,
      new FakeTimer()
    );

    await expect(
      client.execute(["shell", "input", "keyevent", "KEYCODE_TAB"], {
        noRetry: true,
        beforeDispatch: async () => {
          throw new Error("stale frame context");
        },
      })
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
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

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
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

    await expect(client.executeCommand("shell echo hi")).rejects.toThrow("adb transient blip");
    // MAX_ADB_RETRIES = 3, so the initial attempt plus 3 retries == 4 executions.
    expect(calls).toBe(4);
  });

  test("does not retry a non-retryable offline failure", async () => {
    let calls = 0;
    const exec = (): Promise<ExecResult> => {
      calls += 1;
      return Promise.reject(new Error("error: device offline"));
    };
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

    await expect(client.executeCommand("shell echo hi")).rejects.toThrow("offline");
    expect(calls).toBe(1);
  });
});

describe("AdbClient abort-reason preservation", () => {
  function alwaysThrows(): Promise<ExecResult> {
    return Promise.reject(new Error("underlying exec failure"));
  }

  test("preserves a device-disconnected abort reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("device-disconnected:emulator-5554"));
    const client = new AdbClient(DEVICE, alwaysThrows, null, defaultRetryExecutor, new FakeTimer());

    await expect(
      client.executeCommand("shell echo hi", undefined, undefined, true, controller.signal)
    ).rejects.toThrow("device-disconnected:emulator-5554");
  });

  test("falls back to the generic cancellation message for a non-disconnect reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("some unrelated reason"));
    const client = new AdbClient(DEVICE, alwaysThrows, null, defaultRetryExecutor, new FakeTimer());

    await expect(
      client.executeCommand("shell echo hi", undefined, undefined, true, controller.signal)
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
  });

  test("uses the generic cancellation message when aborted without a reason", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new AdbClient(DEVICE, alwaysThrows, null, defaultRetryExecutor, new FakeTimer());

    await expect(
      client.executeCommand("shell echo hi", undefined, undefined, true, controller.signal)
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
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

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
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

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
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

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
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

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
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

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
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

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
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, timer);

    expect(await client.getDeviceTimestampMsWithSource()).toEqual({
      timestampMs: 1_650_000_000_000,
      source: "host",
    });
  });

  test("falls back to the host clock when both device tiers fail", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_650_000_000_000);
    const exec = (): Promise<ExecResult> => Promise.reject(new Error("device offline"));
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, timer);

    expect(await client.getDeviceTimestampMs()).toBe(1_650_000_000_000);
    expect(await client.getDeviceTimestampMsWithSource()).toEqual({
      timestampMs: 1_650_000_000_000,
      source: "host",
    });
  });
});

describe("AdbClient argv construction (parseCommandArgs)", () => {
  function recorder(): { argvs: string[][]; exec: (file: string, args: string[], maxBuffer: number | undefined) => Promise<ExecResult> } {
    const argvs: string[][] = [];
    const exec = (_file: string, args: string[], _maxBuffer: number | undefined): Promise<ExecResult> => {
      argvs.push(args);
      return Promise.resolve(ok(""));
    };
    return { argvs, exec };
  }

  test("prefixes the target serial with -s and keeps a quoted shell command as one argument", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

    await client.executeCommand("shell \"pm list packages | grep foo\"");

    expect(argvs).toEqual([["-s", "emulator-5554", "shell", "pm list packages | grep foo"]]);
  });

  test("keeps a single-quoted shell payload intact including the pipe", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

    await client.executeCommand("shell 'echo a | cat'");

    expect(argvs).toEqual([["-s", "emulator-5554", "shell", "echo a | cat"]]);
  });

  test("preserves spaces inside a double-quoted argument for a non-shell command", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

    await client.executeCommand("install \"/tmp/my app.apk\"");

    expect(argvs).toEqual([["-s", "emulator-5554", "install", "/tmp/my app.apk"]]);
  });

  test("splits an unquoted command into separate argv tokens", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, defaultRetryExecutor, new FakeTimer());

    await client.executeCommand("push local.txt /sdcard/remote.txt");

    expect(argvs).toEqual([["-s", "emulator-5554", "push", "local.txt", "/sdcard/remote.txt"]]);
  });

  test("omits the -s prefix when no device is targeted", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(null, exec, null, defaultRetryExecutor, new FakeTimer());

    await client.executeCommand("devices");

    expect(argvs).toEqual([["devices"]]);
  });
});
