import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";
import { AppPreferences } from "../../../src/features/preferences/AppPreferences";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const androidDevice: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

const iosSimulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

const physicalIosDevice: BootedDevice = {
  name: "Jason's iPhone",
  platform: "ios",
  deviceId: "00008110-001C195E0E42801E",
};

class SingleAdbFactory implements AdbClientFactory {
  constructor(private readonly adb: AdbExecutor) {}

  create(): AdbExecutor {
    return this.adb;
  }
}

function adbFactoryFor(adb: AdbExecutor): AdbClientFactory {
  return new SingleAdbFactory(adb);
}

function commandText(commands: string[], match: string): string {
  const command = commands.find((entry) => entry.includes(match));
  expect(command).toBeDefined();
  return command!;
}

function decodeBase64WritePayload(command: string): string {
  const match = command.match(/([A-Za-z0-9+/=]{24,})/);
  expect(match).toBeTruthy();
  return Buffer.from(match![1], "base64").toString("utf8");
}

interface ScriptedSimCtlOutcome {
  stdout?: string;
  error?: Error;
  elapsedMs?: number;
}

class ScriptedSimCtlClient {
  readonly calls: Array<{ args: string[]; timeoutMs?: number }> = [];

  constructor(
    private readonly outcomes: ScriptedSimCtlOutcome[],
    private readonly timer?: FakeTimer,
  ) {}

  async executeCommand(): Promise<{ stdout: string; stderr: string }> {
    return { stdout: "", stderr: "" };
  }

  async executeCommandArgs(
    args: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ args, timeoutMs });
    const outcome = this.outcomes.shift();
    if (!outcome) {
      throw new Error("Unexpected simctl command");
    }
    if (outcome.elapsedMs) {
      this.timer?.advanceTime(outcome.elapsedMs);
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return { stdout: outcome.stdout ?? "", stderr: "" };
  }
}

describe("AppPreferences", () => {
  test("reads Android system properties with adb getprop", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell getprop debug.example.api.url",
      createExecResult("https://dev.example.com/\n", ""),
    );

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.getPreference({
      scope: "systemProperty",
      key: "debug.example.api.url",
    });

    expect(result).toMatchObject({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      scope: "systemProperty",
      key: "debug.example.api.url",
      value: "https://dev.example.com/",
      type: "string",
      found: true,
    });
    expect(adb.getExecutedCommands()).toEqual(["shell getprop debug.example.api.url"]);
  });

  test("sets Android system properties and returns read-back verification", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell setprop debug.example.enabled true", createExecResult("", ""));
    adb.setCommandResponse("shell getprop debug.example.enabled", createExecResult("true\n", ""));

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.setPreference({
      scope: "systemProperty",
      key: "debug.example.enabled",
      value: true,
      type: "bool",
    });

    expect(result).toMatchObject({
      success: true,
      scope: "systemProperty",
      key: "debug.example.enabled",
      value: true,
      type: "bool",
      found: true,
      verified: true,
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell setprop debug.example.enabled true",
      "shell getprop debug.example.enabled",
    ]);
  });

  test("verifies Android system properties set to an empty string", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell setprop debug.example.empty ''", createExecResult("", ""));
    adb.setCommandResponse("shell getprop debug.example.empty", createExecResult("\n", ""));
    adb.setCommandResponse(
      "shell getprop",
      createExecResult("[debug.example.empty]: []\n[debug.example.enabled]: [true]\n", ""),
    );

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.setPreference({
      scope: "systemProperty",
      key: "debug.example.empty",
      value: "",
      type: "string",
    });

    expect(result).toMatchObject({
      success: true,
      scope: "systemProperty",
      key: "debug.example.empty",
      value: "",
      type: "string",
      found: true,
      verified: true,
    });
  });

  test("preserves whitespace in Android system property strings", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell setprop debug.example.token '  token  '",
      createExecResult("", ""),
    );
    adb.setCommandResponse(
      "shell getprop debug.example.token",
      createExecResult("  token  \n", ""),
    );

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.setPreference({
      scope: "systemProperty",
      key: "debug.example.token",
      value: "  token  ",
      type: "string",
    });

    expect(result).toMatchObject({
      success: true,
      found: true,
      value: "  token  ",
      type: "string",
      verified: true,
    });
  });

  test("rejects non-integral int preference values instead of truncating them", async () => {
    const adb = new FakeAdbExecutor();
    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });

    await expect(
      preferences.setPreference({
        scope: "systemProperty",
        key: "debug.example.count",
        value: 3.5,
        type: "int",
      }),
    ).rejects.toThrow("Expected int preference value");

    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("reads typed values from Android SharedPreferences XML", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "cat shared_prefs/settings.xml",
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          '<map><boolean name="onboarding_complete" value="true" /></map>\n',
        "",
      ),
    );

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.getPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "settings",
      key: "onboarding_complete",
    });

    expect(result).toMatchObject({
      success: true,
      appId: "com.example.app",
      suite: "settings",
      key: "onboarding_complete",
      value: true,
      type: "bool",
      found: true,
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell run-as com.example.app cat shared_prefs/settings.xml",
    ]);
  });

  test("reports Android SharedPreferences long entries as found", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "cat shared_prefs/automobile_anr.xml",
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          '<map><long name="last_reported_timestamp" value="1710000000000" /></map>\n',
        "",
      ),
    );

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.getPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "automobile_anr",
      key: "last_reported_timestamp",
    });

    expect(result).toMatchObject({
      success: true,
      found: true,
      type: "long",
      value: 1710000000000,
    });
  });

  test("reports Android SharedPreferences string sets as found", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "cat shared_prefs/settings.xml",
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          '<map><set name="enabled_flags"><string>first</string><string>second</string></set></map>\n',
        "",
      ),
    );

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.getPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "settings",
      key: "enabled_flags",
    });

    expect(result).toMatchObject({
      success: true,
      found: true,
      type: "stringSet",
      value: ["first", "second"],
    });
  });

  test("surfaces Android SharedPreferences run-as app lookup failures", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "shell run-as com.missing.app cat shared_prefs/settings.xml",
      new Error("run-as: package not found: com.missing.app"),
    );

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });

    await expect(
      preferences.getPreference({
        scope: "sharedPreferences",
        appId: "com.missing.app",
        suite: "settings",
        key: "host",
      }),
    ).rejects.toThrow("run-as");
  });

  test("treats a missing Android SharedPreferences XML file as an empty map", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "shell run-as com.example.app cat shared_prefs/settings.xml",
      new Error("cat: shared_prefs/settings.xml: No such file or directory"),
    );

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.getPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "settings",
      key: "host",
    });

    expect(result).toMatchObject({
      success: true,
      found: false,
      value: null,
    });
  });

  test("writes typed Android SharedPreferences XML, preserves other entries, and verifies read-back", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("cat shared_prefs/settings.xml", [
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          '<map><string name="host">prod.example.com</string></map>\n',
        "",
      ),
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          '<map><string name="host">prod.example.com</string><int name="launch_count" value="3" /></map>\n',
        "",
      ),
    ]);

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.setPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "settings",
      key: "launch_count",
      value: 3,
      type: "int",
    });

    expect(result).toMatchObject({
      success: true,
      verified: true,
      appId: "com.example.app",
      suite: "settings",
      key: "launch_count",
      value: 3,
      type: "int",
    });
    expect(result.warning).toContain("cold relaunch");
    const commands = adb.getExecutedCommands();
    expect(commands[0]).toBe("shell run-as com.example.app cat shared_prefs/settings.xml");
    expect(commands[2]).toBe("shell run-as com.example.app cat shared_prefs/settings.xml");

    const writeCommand = commandText(commands, "base64 -d > shared_prefs/settings.xml");
    const writtenXml = decodeBase64WritePayload(writeCommand);
    expect(writtenXml).toContain('<string name="host">prod.example.com</string>');
    expect(writtenXml).toContain('<int name="launch_count" value="3"/>');
  });

  test("writes the first Android SharedPreferences entry when the XML map is empty", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("cat shared_prefs/settings.xml", [
      createExecResult("<map/>", ""),
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          '<map><boolean name="onboarding_complete" value="true" /></map>\n',
        "",
      ),
    ]);

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    const result = await preferences.setPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "settings",
      key: "onboarding_complete",
      value: true,
      type: "bool",
    });

    expect(result.verified).toBe(true);
    const writeCommand = commandText(
      adb.getExecutedCommands(),
      "base64 -d > shared_prefs/settings.xml",
    );
    const writtenXml = decodeBase64WritePayload(writeCommand);
    expect(writtenXml).toContain('<boolean name="onboarding_complete" value="true"/>');
  });

  test("rejects Android SharedPreferences int values outside the Java 32-bit range", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cat shared_prefs/settings.xml", createExecResult("<map/>", ""));

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    await expect(
      preferences.setPreference({
        scope: "sharedPreferences",
        appId: "com.example.app",
        suite: "settings",
        key: "timestamp_id",
        value: 1710000000000,
        type: "int",
      }),
    ).rejects.toThrow("32-bit");

    expect(adb.getExecutedCommands()).toEqual([
      "shell run-as com.example.app cat shared_prefs/settings.xml",
    ]);
  });

  test("rejects Android SharedPreferences suite names with shell metacharacters", async () => {
    const adb = new FakeAdbExecutor();
    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });

    await expect(
      preferences.getPreference({
        scope: "sharedPreferences",
        appId: "com.example.app",
        suite: "prefs; echo pwn #",
        key: "host",
      }),
    ).rejects.toThrow("SharedPreferences suite");

    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("writes iOS simulator UserDefaults through defaults daemon and verifies read-back", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app onboardingComplete",
      "1\n",
    );

    const preferences = new AppPreferences(iosSimulator, { simctl });
    const result = await preferences.setPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "onboardingComplete",
      value: true,
      type: "bool",
    });

    expect(result).toMatchObject({
      success: true,
      platform: "ios",
      scope: "userDefaults",
      appId: "com.example.app",
      key: "onboardingComplete",
      value: true,
      type: "bool",
      found: true,
      verified: true,
    });
    expect(result.warning).toContain("cold relaunch");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      {
        args: [
          "spawn",
          "12345678-1234-1234-1234-123456789ABC",
          "defaults",
          "write",
          "com.example.app",
          "onboardingComplete",
          "-bool",
          "true",
        ],
        timeoutMs: 10_000,
      },
      {
        args: [
          "spawn",
          "12345678-1234-1234-1234-123456789ABC",
          "defaults",
          "read",
          "com.example.app",
          "onboardingComplete",
        ],
        timeoutMs: 10_000,
      },
      {
        args: [
          "spawn",
          "12345678-1234-1234-1234-123456789ABC",
          "defaults",
          "read-type",
          "com.example.app",
          "onboardingComplete",
        ],
        timeoutMs: 10_000,
      },
    ]);
  });

  test("writes literal iOS simulator string values through argv-preserving defaults arguments", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app windowsPath",
      "C:\\tmp\n",
    );
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app emptyString",
      "\n",
    );

    const preferences = new AppPreferences(iosSimulator, { simctl });
    await preferences.setPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "windowsPath",
      value: "C:\\tmp",
      type: "string",
    });
    await preferences.setPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "emptyString",
      value: "",
      type: "string",
    });

    const argvCalls = simctl.getMethodCalls("executeCommandArgs");
    expect(argvCalls).toContainEqual({
      args: [
        "spawn",
        "12345678-1234-1234-1234-123456789ABC",
        "defaults",
        "write",
        "com.example.app",
        "windowsPath",
        "-string",
        "C:\\tmp",
      ],
      timeoutMs: 10_000,
    });
    expect(argvCalls).toContainEqual({
      args: [
        "spawn",
        "12345678-1234-1234-1234-123456789ABC",
        "defaults",
        "write",
        "com.example.app",
        "emptyString",
        "-string",
        "",
      ],
      timeoutMs: 10_000,
    });
  });

  test("preserves whitespace in iOS simulator string defaults while removing the command newline", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app paddedString",
      "  padded value  \n",
    );
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read-type com.example.app paddedString",
      "Type is string\n",
    );

    const preferences = new AppPreferences(iosSimulator, { simctl });
    const result = await preferences.setPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "paddedString",
      value: "  padded value  ",
      type: "string",
    });

    expect(result).toMatchObject({
      found: true,
      value: "  padded value  ",
      type: "string",
      verified: true,
    });
  });

  test("reads iOS simulator UserDefaults through argv-preserving defaults arguments", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read group\\com.example path\\key",
      "C:\\tmp\n",
    );
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read-type group\\com.example path\\key",
      "Type is string\n",
    );

    const preferences = new AppPreferences(iosSimulator, { simctl });
    const result = await preferences.getPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      suite: "group\\com.example",
      key: "path\\key",
    });

    expect(result.value).toBe("C:\\tmp");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      {
        args: [
          "spawn",
          "12345678-1234-1234-1234-123456789ABC",
          "defaults",
          "read",
          "group\\com.example",
          "path\\key",
        ],
        timeoutMs: 10_000,
      },
      {
        args: [
          "spawn",
          "12345678-1234-1234-1234-123456789ABC",
          "defaults",
          "read-type",
          "group\\com.example",
          "path\\key",
        ],
        timeoutMs: 10_000,
      },
    ]);
  });

  test("uses an iOS suite as the defaults domain when provided", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read group.com.example defaultHost",
      "dev.example.com\n",
    );

    const preferences = new AppPreferences(iosSimulator, { simctl });
    const result = await preferences.getPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      suite: "group.com.example",
      key: "defaultHost",
    });

    expect(result).toMatchObject({
      success: true,
      suite: "group.com.example",
      value: "dev.example.com",
      type: "string",
    });
  });

  test("maps the iOS Standard suite to the app defaults domain", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app defaultHost",
      "dev.example.com\n",
    );

    const preferences = new AppPreferences(iosSimulator, { simctl });
    const result = await preferences.getPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      suite: "Standard",
      key: "defaultHost",
    });

    expect(result).toMatchObject({
      success: true,
      suite: "Standard",
      value: "dev.example.com",
      type: "string",
    });
    expect(simctl.getMethodCalls("executeCommandArgs")[0].args).toContain("com.example.app");
  });

  test("rejects unsafe iOS integer writes instead of rounding", async () => {
    const simctl = new FakeSimCtlClient();
    const preferences = new AppPreferences(iosSimulator, { simctl });

    await expect(
      preferences.setPreference({
        scope: "userDefaults",
        appId: "com.example.app",
        key: "unsafeInteger",
        value: "9007199254740993",
        type: "int",
      }),
    ).rejects.toThrow("safe integer");

    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("infers typed iOS simulator UserDefaults values with defaults read-type", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app onboardingComplete",
      "1\n",
    );
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read-type com.example.app onboardingComplete",
      "Type is boolean\n",
    );

    const preferences = new AppPreferences(iosSimulator, { simctl });
    const result = await preferences.getPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "onboardingComplete",
    });

    expect(result).toMatchObject({
      success: true,
      found: true,
      value: true,
      type: "bool",
    });
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      {
        args: [
          "spawn",
          "12345678-1234-1234-1234-123456789ABC",
          "defaults",
          "read",
          "com.example.app",
          "onboardingComplete",
        ],
        timeoutMs: 10_000,
      },
      {
        args: [
          "spawn",
          "12345678-1234-1234-1234-123456789ABC",
          "defaults",
          "read-type",
          "com.example.app",
          "onboardingComplete",
        ],
        timeoutMs: 10_000,
      },
    ]);
  });

  test("returns unsafe iOS integer defaults as strings instead of rounded numbers", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app unsafeInteger",
      "9007199254740993\n",
    );
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read-type com.example.app unsafeInteger",
      "Type is integer\n",
    );

    const preferences = new AppPreferences(iosSimulator, { simctl });
    const result = await preferences.getPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "unsafeInteger",
    });

    expect(result).toMatchObject({
      success: true,
      found: true,
      value: "9007199254740993",
      type: "int",
    });
  });

  test("returns a not-found result when iOS defaults reports a missing key", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app missingKey",
      new Error("The domain/default pair of (com.example.app, missingKey) does not exist"),
    );

    const preferences = new AppPreferences(iosSimulator, { simctl });
    const result = await preferences.getPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "missingKey",
    });

    expect(result).toMatchObject({
      success: true,
      found: false,
      value: null,
      key: "missingKey",
    });
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
  });

  test("retries a timed-out iOS UserDefaults write once", async () => {
    const simctl = new ScriptedSimCtlClient([
      { error: new Error("Command timed out after 10000ms") },
      {},
      { stdout: "enabled\n" },
      { stdout: "Type is string\n" },
    ]);
    const preferences = new AppPreferences(iosSimulator, { simctl });

    await preferences.setPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "featureFlag",
      value: "enabled",
      type: "string",
    });

    expect(simctl.calls.map((call) => call.args[3])).toEqual([
      "write",
      "write",
      "read",
      "read-type",
    ]);
    expect(simctl.calls.map((call) => call.timeoutMs)).toEqual([
      10_000,
      10_000,
      10_000,
      10_000,
    ]);
  });

  test("preserves the final iOS UserDefaults command error after one retry", async () => {
    const simctl = new ScriptedSimCtlClient([
      { error: new Error("first defaults command timed out") },
      { error: new Error("final defaults timeout") },
    ]);
    const preferences = new AppPreferences(iosSimulator, { simctl });

    await expect(
      preferences.setPreference({
        scope: "userDefaults",
        appId: "com.example.app",
        key: "featureFlag",
        value: "enabled",
        type: "string",
      }),
    ).rejects.toThrow("final defaults timeout");
    expect(simctl.calls.map((call) => call.args[3])).toEqual(["write", "write"]);
  });

  test("retries a transient CoreSimulator connection failure for UserDefaults reads once", async () => {
    const simctl = new ScriptedSimCtlClient([
      {},
      { error: new Error("Failed to connect to the CoreSimulator service") },
      { stdout: "enabled\n" },
      { stdout: "Type is string\n" },
    ]);
    const preferences = new AppPreferences(iosSimulator, { simctl });

    const result = await preferences.setPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "featureFlag",
      value: "enabled",
      type: "string",
    });

    expect(result.verified).toBeTrue();
    expect(simctl.calls.map((call) => call.args[3])).toEqual([
      "write",
      "read",
      "read",
      "read-type",
    ]);
  });

  test("retries a timed-out iOS UserDefaults type-read once", async () => {
    const simctl = new ScriptedSimCtlClient([
      {},
      { stdout: "enabled\n" },
      { error: new Error("Command timed out after 10000ms") },
      { stdout: "Type is string\n" },
    ]);
    const preferences = new AppPreferences(iosSimulator, { simctl });

    await preferences.setPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "featureFlag",
      value: "enabled",
      type: "string",
    });

    expect(simctl.calls.map((call) => call.args[3])).toEqual([
      "write",
      "read",
      "read-type",
      "read-type",
    ]);
  });

  test("bounds the full iOS UserDefaults write and verification operation to 30 seconds", async () => {
    const timer = new FakeTimer();
    const simctl = new ScriptedSimCtlClient(
      [
        { elapsedMs: 10_000 },
        { elapsedMs: 10_000, error: new Error("Command timed out after 10000ms") },
        { elapsedMs: 10_000, stdout: "enabled\n" },
      ],
      timer,
    );
    const preferences = new AppPreferences(iosSimulator, { simctl, timer });

    await expect(
      preferences.setPreference({
        scope: "userDefaults",
        appId: "com.example.app",
        key: "featureFlag",
        value: "enabled",
        type: "string",
      }),
    ).rejects.toThrow("timed out after 30000ms");

    expect(timer.now()).toBe(30_000);
    expect(simctl.calls.map((call) => call.args[3])).toEqual(["write", "read", "read"]);
  });

  test("rejects physical iOS UserDefaults instead of reading the runner process defaults", async () => {
    const preferences = new AppPreferences(physicalIosDevice);

    await expect(
      preferences.getPreference({
        scope: "userDefaults",
        appId: "com.example.app",
        key: "onboardingComplete",
      }),
    ).rejects.toThrow("iOS physical devices");
  });

  describe("validateScope guards", () => {
    // Each guard must fire BEFORE any device command runs — a wrong scope on the
    // wrong platform must never silently run `adb getprop` on an iOS device, and a
    // missing appId must never write to `undefined_preferences.xml`.
    test("rejects userDefaults scope on an Android device without touching adb", async () => {
      const adb = new FakeAdbExecutor();
      const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });

      await expect(
        preferences.getPreference({
          scope: "userDefaults",
          appId: "com.example.app",
          key: "onboardingComplete",
        }),
      ).rejects.toThrow("userDefaults scope is only supported on iOS devices.");
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test("rejects systemProperty scope on an iOS device without spawning defaults", async () => {
      const simctl = new FakeSimCtlClient();
      const preferences = new AppPreferences(iosSimulator, { simctl });

      await expect(
        preferences.getPreference({
          scope: "systemProperty",
          key: "debug.example.enabled",
        }),
      ).rejects.toThrow("systemProperty scope is only supported on Android devices.");
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    });

    test("rejects sharedPreferences scope on an iOS device without spawning defaults", async () => {
      const simctl = new FakeSimCtlClient();
      const preferences = new AppPreferences(iosSimulator, { simctl });

      await expect(
        preferences.getPreference({
          scope: "sharedPreferences",
          appId: "com.example.app",
          suite: "settings",
          key: "host",
        }),
      ).rejects.toThrow("sharedPreferences scope is only supported on Android devices.");
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    });

    test("rejects Android sharedPreferences without an appId instead of writing undefined_preferences.xml", async () => {
      const adb = new FakeAdbExecutor();
      const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });

      await expect(
        preferences.getPreference({
          scope: "sharedPreferences",
          suite: "settings",
          key: "host",
        }),
      ).rejects.toThrow("appId is required for sharedPreferences.");
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test("rejects iOS userDefaults without an appId before spawning defaults", async () => {
      const simctl = new FakeSimCtlClient();
      const preferences = new AppPreferences(iosSimulator, { simctl });

      await expect(
        preferences.getPreference({
          scope: "userDefaults",
          key: "onboardingComplete",
        }),
      ).rejects.toThrow("appId is required for userDefaults.");
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    });

    test("guards setPreference on the same rules, not only getPreference", async () => {
      const adb = new FakeAdbExecutor();
      const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });

      await expect(
        preferences.setPreference({
          scope: "userDefaults",
          appId: "com.example.app",
          key: "onboardingComplete",
          value: true,
          type: "bool",
        }),
      ).rejects.toThrow("userDefaults scope is only supported on iOS devices.");
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  });
});
