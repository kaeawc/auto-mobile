import { describe, expect, test } from "bun:test";
import {
  AndroidDeviceResourceReader,
  type AndroidResourceReadRun,
} from "../../src/utils/androidDeviceResourceReader";
import type { DeviceResourceObservationRequest } from "../../src/utils/deviceResourceObserver";
import type { AndroidResourceRestoration } from "../../src/models/AndroidResourceRestoration";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { ResourceAdb } from "../fakes/FakeAndroidResourceAdb";
import { FakeTimer } from "../fakes/FakeTimer";

type Entry = AndroidResourceRestoration["entries"][number];
const packageEntry: Entry = {
  resource: "mailApp",
  kind: "package",
  target: "com.google.android.gm",
  value: null,
};
const backupEntry: Entry = { resource: "backup", kind: "backup", target: "backup", value: null };
const globalEntry: Entry = {
  resource: "animations",
  kind: "global",
  target: "window_animation_scale",
  value: null,
};
const secureEntry: Entry = {
  resource: "screensavers",
  kind: "secure",
  target: "screensaver_enabled",
  value: null,
};

function setup() {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  const reader = new AndroidDeviceResourceReader({ adbFactory: { create: () => adb }, timer });
  const request: DeviceResourceObservationRequest = {
    device: { platform: "android", deviceId: "emulator-5580", name: "reader-test" },
    deadlineMs: timer.now() + 1000,
  };
  return { adb, timer, reader, request };
}

function scriptedRun(command: AndroidResourceReadRun["command"]) {
  const { reader, request } = setup();
  const commands: string[][] = [];
  const run: AndroidResourceReadRun = {
    request,
    user: "10",
    command: async (args) => {
      commands.push(args);
      return command(args);
    },
  };
  return { reader, run, commands };
}

describe("AndroidDeviceResourceReader.createRun", () => {
  test.each([0, -1])("does not execute ADB when remaining deadline is %i", async (remaining) => {
    const { reader, request, timer, adb } = setup();
    request.deadlineMs = timer.now() + remaining;
    await expect(reader.createRun(request).command(["am", "get-current-user"])).rejects.toThrow(
      "Android resource configuration deadline expired",
    );
    expect(adb.getExecutedArgv()).toEqual([]);
  });

  test("rejects an already-aborted signal before executing ADB", async () => {
    const { reader, request, adb } = setup();
    const abort = new AbortController();
    const reason = new Error("cancel before execute");
    abort.abort(reason);
    request.signal = abort.signal;
    await expect(reader.createRun(request).command(["am", "get-current-user"])).rejects.toBe(
      reason,
    );
    expect(adb.getExecutedArgv()).toEqual([]);
  });

  test("rejects cancellation after execute returns rather than returning stdout", async () => {
    const { request, timer } = setup();
    const adb = new ResourceAdb();
    const reader = new AndroidDeviceResourceReader({ adbFactory: { create: () => adb }, timer });
    const abort = new AbortController();
    const reason = new Error("cancel during execute");
    request.signal = abort.signal;
    adb.onCommand = () => abort.abort(reason);
    await expect(reader.createRun(request).command(["am", "get-current-user"])).rejects.toBe(
      reason,
    );
    expect(adb.commands).toEqual([["am", "get-current-user"]]);
  });

  test("quotes shell arguments, trims stdout, and recomputes remaining timeout per command", async () => {
    const { reader, request, timer, adb } = setup();
    request.signal = new AbortController().signal;
    adb.setDefaultResponse(createExecResult(" \r\nresult\t\n", ""));
    const run = reader.createRun(request);
    expect(run.user).toBe("");
    expect(run.request).toBe(request);
    const args = ["echo", "two words", "it's", "$HOME;`id`", ""];
    expect(await run.command(args)).toBe("result");
    timer.advanceTime(250);
    expect(await run.command(args)).toBe("result");
    const shell = "'echo' 'two words' 'it'\\''s' '$HOME;`id`' ''";
    expect(adb.getExecutedArgv()).toEqual([
      ["shell", shell],
      ["shell", shell],
    ]);
    expect(adb.getCommandCalls()).toEqual(
      [1000, 750].map((timeoutMs) => ({
        command: `shell ${shell}`,
        timeoutMs,
        maxBuffer: undefined,
        noRetry: true,
        signal: request.signal,
        waitForProcessSettlementAfterAbort: true,
      })),
    );
    timer.advanceTime(750);
    await expect(run.command(args)).rejects.toThrow(
      "Android resource configuration deadline expired",
    );
    expect(adb.getExecutedArgv()).toHaveLength(2);
  });

  test("propagates ADB errors unchanged", async () => {
    const { reader, request, adb } = setup();
    const reason = new Error("ADB read failed");
    adb.setDefaultError(reason);
    await expect(reader.createRun(request).command(["am", "get-current-user"])).rejects.toBe(
      reason,
    );
    expect(adb.getExecutedArgv()).toHaveLength(1);
  });
});

describe("AndroidDeviceResourceReader.identifyRun", () => {
  test.each(["", "abc", "10x"])("rejects non-numeric foreground user %j", async (user) => {
    const { reader, run, commands } = scriptedRun(async () => user);
    await expect(reader.identifyRun(run)).rejects.toThrow(
      "Cannot determine Android foreground user",
    );
    expect(commands).toEqual([["am", "get-current-user"]]);
    expect(run.user).toBe(user);
  });

  test.each([
    "",
    "abcdef01-2345-6789-abcd-0123456789a",
    "gbcdef01-2345-6789-abcd-0123456789ab",
    "abcdef0123456789abcd0123456789ab",
  ])("rejects malformed boot ID %j", async (boot) => {
    const { reader, run, commands } = scriptedRun(async (args) => (args[0] === "am" ? "10" : boot));
    await expect(reader.identifyRun(run)).rejects.toThrow("Cannot identify this Android boot");
    expect(run.user).toBe("10");
    expect(commands).toEqual([
      ["am", "get-current-user"],
      ["cat", "/proc/sys/kernel/random/boot_id"],
    ]);
  });

  test.each(["abcdef01-2345-6789-abcd-0123456789ab", "ABCDEF01-2345-6789-ABCD-0123456789AB"])(
    "returns valid boot ID %s without changing its case",
    async (boot) => {
      const { reader, run, commands } = scriptedRun(async (args) =>
        args[0] === "am" ? "10" : boot,
      );
      expect(await reader.identifyRun(run)).toBe(boot);
      expect(run.user).toBe("10");
      expect(commands).toEqual([
        ["am", "get-current-user"],
        ["cat", "/proc/sys/kernel/random/boot_id"],
      ]);
    },
  );
});

describe("AndroidDeviceResourceReader.discover", () => {
  test.each(["\n", "\r\n"])(
    "filters installed package lines with separator %j",
    async (separator) => {
      const output = [
        "com.android.email",
        "package:com.google.android.gm",
        "package:com.google.android.gm",
        "package:com.android.vending",
        " package:com.android.email",
        "unrelated text",
      ].join(separator);
      const { reader, run, commands } = scriptedRun(async () => output);
      expect(await reader.discover(run, "mailApp")).toEqual([packageEntry]);
      expect(commands).toEqual([["pm", "list", "packages", "-s", "--user", "10"]]);
    },
  );

  test("returns no entries when catalog packages are absent", async () => {
    const { reader, run } = scriptedRun(async () => "");
    expect(await reader.discover(run, "mailApp")).toEqual([]);
  });

  test("returns all installed catalog packages in catalog order", async () => {
    const { reader, run } = scriptedRun(
      async () => "package:com.android.email\npackage:com.google.android.gm",
    );
    expect(await reader.discover(run, "mailApp")).toEqual([
      packageEntry,
      { ...packageEntry, target: "com.android.email" },
    ]);
  });

  test("returns global and secure settings entries without executing commands", async () => {
    const { reader, run, commands } = scriptedRun(async () => "");
    expect(await reader.discover(run, "animations")).toEqual([
      globalEntry,
      { ...globalEntry, target: "transition_animation_scale" },
      { ...globalEntry, target: "animator_duration_scale" },
    ]);
    expect(await reader.discover(run, "screensavers")).toEqual([secureEntry]);
    expect(commands).toEqual([]);
  });

  test("falls back to a backup entry when neither catalog contains the resource", async () => {
    const { reader, run, commands } = scriptedRun(async () => "");
    expect(await reader.discover(run, "backup")).toEqual([backupEntry]);
    expect(commands).toEqual([]);
  });
});

describe("AndroidDeviceResourceReader.read", () => {
  test.each(["", "unrelated text"])("rejects unverifiable package output %j", async (output) => {
    const { reader, run, commands } = scriptedRun(async () => output);
    await expect(reader.read(run, packageEntry)).rejects.toThrow(
      "Cannot verify installed package override for com.google.android.gm",
    );
    expect(commands).toEqual([["dumpsys", "package", packageEntry.target]]);
  });

  test.each([
    ["Backup Manager currently enabled", "1"],
    ["Backup Manager currently disabled", "0"],
  ])("reads backup output %s as %s", async (output, value) => {
    const { reader, run, commands } = scriptedRun(async () => output);
    expect(await reader.read(run, backupEntry)).toBe(value);
    expect(commands).toEqual([["bmgr", "--user", "10", "enabled"]]);
  });

  test.each([
    "",
    "enabled",
    "disabled",
    "unrelated text",
    "Backup Manager currently enabled trailing text",
    "Backup Manager currently disabled trailing text",
  ])("rejects unrecognized backup output %j", async (output) => {
    const { reader, run } = scriptedRun(async () => output);
    await expect(reader.read(run, backupEntry)).rejects.toThrow(
      "Cannot verify Backup Manager state",
    );
  });

  test.each([globalEntry, secureEntry])(
    "reads null and numeric settings from $kind",
    async (entry) => {
      for (const value of ["null", "0", "1", "12", "0.0", "0.5", ".5"]) {
        const { reader, run, commands } = scriptedRun(async () => value);
        expect(await reader.read(run, entry)).toBe(value === "null" ? null : value);
        expect(commands).toEqual([["settings", "--user", "10", "get", entry.kind, entry.target]]);
      }
    },
  );

  test.each(["", "abc", "1.", "-1", "1e3", "null\n", "null\r\n", " null", "null "])(
    "rejects invalid untrimmed setting %j",
    async (value) => {
      const { reader, run } = scriptedRun(async () => value);
      await expect(reader.read(run, globalEntry)).rejects.toThrow(
        "Cannot verify setting window_animation_scale",
      );
    },
  );

  test("createRun trims a trailing newline before read validates a null setting", async () => {
    const { reader, request, adb } = setup();
    adb.setDefaultResponse(createExecResult("null\n", ""));
    const run = reader.createRun(request);
    run.user = "10";
    expect(await reader.read(run, globalEntry)).toBeNull();
  });
});

describe("AndroidDeviceResourceReader.state", () => {
  test.each([
    ["1", "enabled"],
    ["0", "unknown"],
    ["2", "disabled"],
    ["3", "disabled"],
    ["4", "disabled"],
    [null, "disabled"],
  ] as const)("maps package override %j to %s", (value, state) => {
    expect(setup().reader.state(packageEntry, value)).toBe(state);
  });

  test.each([
    [null, "unknown"],
    ["0", "disabled"],
    ["0.0", "disabled"],
    ["1", "enabled"],
    ["0.5", "enabled"],
  ] as const)("maps non-package value %j to %s", (value, state) => {
    const { reader } = setup();
    for (const entry of [globalEntry, secureEntry, backupEntry]) {
      expect(reader.state(entry, value)).toBe(state);
    }
  });
});
