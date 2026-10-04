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
import { wrapCommandError } from "../../../src/utils/CommandError";

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

describe("AdbClient constructor test execution selection", () => {
  test.each([undefined, "", "false", "0", "true", "1", "FALSE", " "])(
    "preserves the test-mode interpretation of %s",
    (value) => {
      const previous = process.env.AUTOMOBILE_TEST_MODE;
      try {
        if (value === undefined) {
          delete process.env.AUTOMOBILE_TEST_MODE;
        } else {
          process.env.AUTOMOBILE_TEST_MODE = value;
        }
        const expected = value !== undefined && value !== "" && value !== "false" && value !== "0";
        const client = new AdbClient(null, null, null, ...autoRetrySeam());
        expect(Reflect.get(client, "isTestMode")).toBe(expected);
        const injected = new AdbClient(null, async () => ok("injected"), null, ...autoRetrySeam());
        expect(Reflect.get(injected, "isTestMode")).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.AUTOMOBILE_TEST_MODE;
        } else {
          process.env.AUTOMOBILE_TEST_MODE = previous;
        }
      }
    },
  );

  test("the test-mode stub returns the same empty ExecResult", async () => {
    const previous = process.env.AUTOMOBILE_TEST_MODE;
    try {
      process.env.AUTOMOBILE_TEST_MODE = "true";
      const client = new AdbClient(null, null, null, ...autoRetrySeam());
      const result = await client.execAsync("unused", []);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.toString()).toBe("");
      expect(result.trim()).toBe("");
      expect(result.includes("")).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_TEST_MODE;
      } else {
        process.env.AUTOMOBILE_TEST_MODE = previous;
      }
    }
  });
});

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

  test("does not retry a genuine adb authorization error", async () => {
    let calls = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        throw new Error("error: unauthorized");
      },
      null,
      ...autoRetrySeam(),
    );

    await expect(client.executeCommand("shell dumpsys window")).rejects.toThrow("unauthorized");
    expect(calls).toBe(1);
  });

  test("does not classify echoed command output as an adb non-retryable error", async () => {
    let calls = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        throw wrapCommandError(new Error("exit 1"), {
          command: "adb",
          args: ["shell", "some-command"],
          stdout: "app reported status offline",
        });
      },
      null,
      ...autoRetrySeam(),
    );

    await expect(client.executeCommand("shell dumpsys window")).rejects.toThrow("offline");
    expect(calls).toBe(4);
  });

  test.each([
    "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]",
    "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]",
    "Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES]",
  ])("does not retry deterministic package install failure: %s", async (message) => {
    let calls = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        throw new Error(message);
      },
      null,
      ...autoRetrySeam(),
    );

    await expect(client.executeCommand("install app.apk")).rejects.toThrow(message);
    expect(calls).toBe(1);
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

  test.each(["shell monkey -p 'com.example' --user 0 1", "shell kill -USR1 1234"])(
    "does not replay an unclassified action after device offline: %s",
    async (command) => {
      let calls = 0;
      const client = new AdbClient(
        DEVICE,
        async () => {
          calls += 1;
          throw new Error("error: device offline");
        },
        null,
        ...autoRetrySeam(),
      );

      await expect(client.executeCommand(command)).rejects.toThrow("offline");
      expect(calls).toBe(1);
    },
  );

  test.each([
    { name: "dumpsys window bare", command: "shell dumpsys window", dispatches: 4 },
    {
      name: "dumpsys window rotation grep",
      command: 'shell dumpsys window | grep -i "mRotation="',
      dispatches: 4,
    },
    {
      name: "dumpsys window focus grep",
      command: "shell dumpsys window | grep mCurrentFocus",
      dispatches: 4,
    },
    {
      name: "dumpsys activity activities bare",
      command: "shell dumpsys activity activities",
      dispatches: 4,
    },
    {
      name: "dumpsys activity activities filtered foreground",
      command:
        "shell dumpsys activity activities | grep -E '^[^[:space:]]|^[[:space:]]*(topResumedActivity|mResumedActivity|ResumedActivity|Resumed|mFocusedActivity)[[:space:]]*[:=]'",
      dispatches: 4,
    },
    {
      name: "dumpsys activity processes bare",
      command: "shell dumpsys activity processes",
      dispatches: 4,
    },
    {
      name: "dumpsys activity processes package",
      command: "shell dumpsys activity processes com.example",
      dispatches: 4,
    },
    { name: "dumpsys display", command: "shell dumpsys display", dispatches: 4 },
    { name: "dumpsys SurfaceFlinger", command: "shell dumpsys SurfaceFlinger", dispatches: 4 },
    { name: "dumpsys package", command: "shell dumpsys package com.example", dispatches: 4 },
    { name: "dumpsys notification", command: "shell dumpsys notification", dispatches: 4 },
    { name: "dumpsys accessibility", command: "shell dumpsys accessibility", dispatches: 4 },
    { name: "dumpsys meminfo", command: "shell dumpsys meminfo com.example", dispatches: 4 },
    { name: "dumpsys gfxinfo read", command: "shell dumpsys gfxinfo com.example", dispatches: 4 },
    { name: "dumpsys user", command: "shell dumpsys user", dispatches: 4 },
    {
      name: "dumpsys power grep",
      command: "shell dumpsys power | grep mWakefulness=",
      dispatches: 4,
    },
    { name: "dumpsys input_method", command: "shell dumpsys input_method", dispatches: 4 },
    { name: "wm size read", command: "shell wm size", dispatches: 4 },
    { name: "wm density read", command: "shell wm density", dispatches: 4 },
    { name: "settings get", command: "shell settings get system font_scale", dispatches: 4 },
    { name: "pm list packages", command: "shell pm list packages --user 0", dispatches: 4 },
    { name: "pm path", command: "shell pm path com.example", dispatches: 4 },
    {
      name: "cmd package query-activities",
      command: "shell cmd package query-activities --brief android.intent.action.MAIN",
      dispatches: 4,
    },
    {
      name: "cmd package query-receivers",
      command: "shell cmd package query-receivers --brief -a android.intent.action.BOOT_COMPLETED",
      dispatches: 4,
    },
    {
      name: "cmd package resolve-activity",
      command: "shell cmd package resolve-activity --brief -a android.intent.action.MAIN",
      dispatches: 4,
    },
    { name: "cat proc file", command: "shell cat /proc/uptime", dispatches: 4 },
    { name: "getevent probe", command: "shell getevent -p", dispatches: 4 },
    {
      name: "sha256sum one path",
      command: "shell sha256sum /data/local/tmp/app.apk",
      dispatches: 4,
    },
    { name: "stat one path", command: "shell stat -c %s /data/local/tmp/app.apk", dispatches: 4 },
    { name: "uiautomator dump writes file", command: "shell uiautomator dump", dispatches: 1 },
    { name: "uiautomator invocation", command: "shell uiautomator events", dispatches: 1 },
    { name: "screencap writes file", command: "shell screencap -p /sdcard/x", dispatches: 1 },
    { name: "base64 just-written file", command: "shell base64 /sdcard/x", dispatches: 1 },
    { name: "rm file", command: "shell rm /sdcard/x", dispatches: 1 },
    {
      name: "screencap base64 rm chain",
      command: "shell screencap -p /sdcard/x && base64 /sdcard/x && rm /sdcard/x",
      dispatches: 1,
    },
    { name: "wm density set", command: "shell wm density 420", dispatches: 1 },
    { name: "wm density reset", command: "shell wm density reset", dispatches: 1 },
    { name: "settings put", command: "shell settings put system font_scale 1.2", dispatches: 1 },
    { name: "settings delete", command: "shell settings delete system font_scale", dispatches: 1 },
    { name: "pm clear", command: "shell pm clear com.example", dispatches: 1 },
    { name: "pm uninstall", command: "shell pm uninstall com.example", dispatches: 1 },
    {
      name: "pm grant",
      command: "shell pm grant com.example android.permission.CAMERA",
      dispatches: 1,
    },
    { name: "pm other subcommand", command: "shell pm dump com.example", dispatches: 1 },
    {
      name: "cmd package other subcommand",
      command: "shell cmd package install /tmp/app.apk",
      dispatches: 1,
    },
    {
      name: "dumpsys semicolon rm chain",
      command: "shell dumpsys window; rm -rf /sdcard/x",
      dispatches: 1,
    },
    {
      name: "dumpsys and rm chain",
      command: "shell dumpsys window && rm -rf /sdcard/x",
      dispatches: 1,
    },
    {
      name: "dumpsys or rm chain",
      command: "shell dumpsys window || rm -rf /sdcard/x",
      dispatches: 1,
    },
    {
      name: "dumpsys tee pipe",
      command: "shell dumpsys window | tee /sdcard/x",
      dispatches: 1,
    },
    {
      name: "settings tee pipe",
      command: "shell settings get system font_scale | tee /sdcard/x",
      dispatches: 1,
    },
    {
      name: "gfxinfo reset clears counters",
      command: "shell dumpsys gfxinfo com.example reset",
      dispatches: 1,
    },
    { name: "getevent other flags", command: "shell getevent -pl", dispatches: 1 },
    {
      name: "sha256sum semicolon chain",
      command: "shell sha256sum /sdcard/x; rm /sdcard/x",
      dispatches: 1,
    },
    {
      name: "sha256sum and chain",
      command: "shell sha256sum /sdcard/x && rm /sdcard/x",
      dispatches: 1,
    },
    {
      name: "sha256sum or chain",
      command: "shell sha256sum /sdcard/x || rm /sdcard/x",
      dispatches: 1,
    },
    {
      name: "sha256sum pipe chain",
      command: "shell sha256sum /sdcard/x | tee /sdcard/x.hash",
      dispatches: 1,
    },
    {
      name: "stat semicolon chain",
      command: "shell stat -c %s /sdcard/x; rm /sdcard/x",
      dispatches: 1,
    },
    {
      name: "stat and chain",
      command: "shell stat -c %s /sdcard/x && rm /sdcard/x",
      dispatches: 1,
    },
    {
      name: "stat or chain",
      command: "shell stat -c %s /sdcard/x || rm /sdcard/x",
      dispatches: 1,
    },
    {
      name: "stat pipe chain",
      command: "shell stat -c %s /sdcard/x | tee /sdcard/x.size",
      dispatches: 1,
    },
  ])(
    "retries only allowlisted shell reads after device offline: $name",
    async ({ command, dispatches }) => {
      let calls = 0;
      const client = new AdbClient(
        DEVICE,
        async () => {
          calls += 1;
          throw new Error("error: device offline");
        },
        null,
        ...autoRetrySeam(),
      );

      await expect(client.executeCommand(command)).rejects.toThrow("offline");
      expect(calls).toBe(dispatches);
    },
  );

  test("stops a retry backoff at the whole-command deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let calls = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        throw new Error("error: closed");
      },
      null,
      new DefaultRetryExecutor(timer),
      timer,
    );

    await expect(client.executeCommand("shell getprop sys.boot_completed", 100)).rejects.toThrow(
      "Command timed out after 100ms",
    );
    expect(calls).toBe(1);
    expect(timer.now()).toBe(100);
  });

  test("keeps a covered backoff and caps only the next one", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let calls = 0;
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        throw new Error("error: closed");
      },
      null,
      new DefaultRetryExecutor(timer),
      timer,
    );

    await expect(client.executeCommand("shell getprop sys.boot_completed", 300)).rejects.toThrow(
      "Command timed out after 300ms",
    );
    expect(calls).toBe(2);
    expect(timer.getSleepHistory()).toEqual([200, 100]);
    expect(timer.now()).toBe(300);
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

  test("does not replay a monkey launch after a closed connection", async () => {
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

    await expect(client.executeCommand("shell monkey -p 'com.example' --user 0 1")).rejects.toThrow(
      "closed",
    );
    expect(calls).toBe(1);
  });

  test("ignores pre-dispatch phrases in wrapped command arguments", async () => {
    let calls = 0;
    const command =
      "shell am start -a android.intent.action.VIEW -d 'https://example.com/cannot connect to daemon'";
    const client = new AdbClient(
      DEVICE,
      async () => {
        calls += 1;
        throw wrapCommandError(new Error("error: closed"), { command: "adb", args: [command] });
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
  test("does not forward a missing-device error after a console operation starts and settles during the command", async () => {
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
      const command = client.executeCommand(
        "shell getprop sys.boot_completed",
        undefined,
        undefined,
        true,
      );
      await dispatched.promise;
      await busyRegistry.runExclusive(DEVICE.deviceId, async () => undefined);
      expect(busyRegistry.isBusy(DEVICE.deviceId)).toBe(false);
      rejection.reject(new Error("adb: device 'emulator-5554' not found"));

      await expect(command).rejects.toThrow("device 'emulator-5554' not found");
      expect(notifications).toEqual([]);

      const idleClient = new AdbClient(
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
      await expect(
        idleClient.executeCommand("shell getprop sys.boot_completed", undefined, undefined, true),
      ).rejects.toThrow("device 'emulator-5554' not found");
      expect(notifications).toEqual([expect.objectContaining({ deviceId: DEVICE.deviceId })]);
    } finally {
      stopListening();
    }
  });

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

  test.each([
    { command: 'install "" "/tmp/my app.apk"', expected: ["install", "/tmp/my app.apk"] },
    { command: 'install "/tmp/my app.apk', expected: ["install", "/tmp/my app.apk"] },
    { command: "install '/tmp/my app.apk'", expected: ["install", "/tmp/my app.apk"] },
    { command: "shell 'echo a | cat", expected: ["shell", "'echo a | cat"] },
    { command: "shell\t'echo a | cat'", expected: ["shell", "echo a | cat"] },
    { command: 'install "/tmp/my \'app.apk"', expected: ["install", "/tmp/my 'app.apk"] },
    { command: "install '/tmp/my \"app.apk'", expected: ["install", '/tmp/my "app.apk'] },
  ])("preserves tolerant tokenization for $command", async ({ command, expected }) => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());
    await client.executeCommand(command);
    expect(argvs).toEqual([["-s", "emulator-5554", ...expected]]);
  });

  test("preserves platform-specific escapes and drops a trailing escape only on POSIX", async () => {
    const { argvs, exec } = recorder();
    const client = new AdbClient(DEVICE, exec, null, ...autoRetrySeam());
    await client.executeCommand("push local\\.txt /sdcard/remote.txt\\");
    await client.executeCommand("push 'local\\.txt' /sdcard/remote.txt");
    expect(argvs).toEqual([
      [
        "-s",
        "emulator-5554",
        "push",
        process.platform === "win32" ? "local\\.txt" : "local.txt",
        process.platform === "win32" ? "/sdcard/remote.txt\\" : "/sdcard/remote.txt",
      ],
      ["-s", "emulator-5554", "push", "local\\.txt", "/sdcard/remote.txt"],
    ]);
  });

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
