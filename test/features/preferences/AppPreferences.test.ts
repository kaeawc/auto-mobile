import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";
import { AppPreferences } from "../../../src/features/preferences/AppPreferences";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

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
  const command = commands.find(entry => entry.includes(match));
  expect(command).toBeDefined();
  return command!;
}

function decodeBase64WritePayload(command: string): string {
  const match = command.match(/([A-Za-z0-9+/=]{24,})/);
  expect(match).toBeTruthy();
  return Buffer.from(match![1], "base64").toString("utf8");
}

describe("AppPreferences", () => {
  test("reads Android system properties with adb getprop", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell getprop debug.example.api.url", createExecResult("https://dev.example.com/\n", ""));

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
    expect(adb.getExecutedCommands()).toEqual([
      "shell getprop debug.example.api.url",
    ]);
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

  test("rejects non-integral int preference values instead of truncating them", async () => {
    const adb = new FakeAdbExecutor();
    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });

    await expect(preferences.setPreference({
      scope: "systemProperty",
      key: "debug.example.count",
      value: 3.5,
      type: "int",
    })).rejects.toThrow("Expected int preference value");

    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("reads typed values from Android SharedPreferences XML", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "cat shared_prefs/settings.xml",
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          "<map><boolean name=\"onboarding_complete\" value=\"true\" /></map>\n",
        ""
      )
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

  test("writes typed Android SharedPreferences XML, preserves other entries, and verifies read-back", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("cat shared_prefs/settings.xml", [
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          "<map><string name=\"host\">prod.example.com</string></map>\n",
        ""
      ),
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          "<map><string name=\"host\">prod.example.com</string><int name=\"launch_count\" value=\"3\" /></map>\n",
        ""
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
    const commands = adb.getExecutedCommands();
    expect(commands[0]).toBe("shell run-as com.example.app cat shared_prefs/settings.xml");
    expect(commands[2]).toBe("shell run-as com.example.app cat shared_prefs/settings.xml");

    const writeCommand = commandText(commands, "base64 -d > shared_prefs/settings.xml");
    const writtenXml = decodeBase64WritePayload(writeCommand);
    expect(writtenXml).toContain("<string name=\"host\">prod.example.com</string>");
    expect(writtenXml).toContain("<int name=\"launch_count\" value=\"3\"/>");
  });

  test("writes the first Android SharedPreferences entry when the XML map is empty", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("cat shared_prefs/settings.xml", [
      createExecResult("<map/>", ""),
      createExecResult(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n" +
          "<map><boolean name=\"onboarding_complete\" value=\"true\" /></map>\n",
        ""
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
    const writeCommand = commandText(adb.getExecutedCommands(), "base64 -d > shared_prefs/settings.xml");
    const writtenXml = decodeBase64WritePayload(writeCommand);
    expect(writtenXml).toContain("<boolean name=\"onboarding_complete\" value=\"true\"/>");
  });

  test("rejects Android SharedPreferences int values outside the Java 32-bit range", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cat shared_prefs/settings.xml", createExecResult("<map/>", ""));

    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });
    await expect(preferences.setPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "settings",
      key: "timestamp_id",
      value: 1710000000000,
      type: "int",
    })).rejects.toThrow("32-bit");

    expect(adb.getExecutedCommands()).toEqual([
      "shell run-as com.example.app cat shared_prefs/settings.xml",
    ]);
  });

  test("rejects Android SharedPreferences suite names with shell metacharacters", async () => {
    const adb = new FakeAdbExecutor();
    const preferences = new AppPreferences(androidDevice, { adbFactory: adbFactoryFor(adb) });

    await expect(preferences.getPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "prefs; echo pwn #",
      key: "host",
    })).rejects.toThrow("SharedPreferences suite");

    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("writes iOS simulator UserDefaults through defaults daemon and verifies read-back", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults write com.example.app onboardingComplete -bool true",
      ""
    );
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app onboardingComplete",
      "1\n"
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
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC defaults write com.example.app onboardingComplete -bool true",
        timeoutMs: 5000,
      },
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app onboardingComplete",
        timeoutMs: 5000,
      },
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC defaults read-type com.example.app onboardingComplete",
        timeoutMs: 5000,
      },
    ]);
  });

  test("uses an iOS suite as the defaults domain when provided", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read group.com.example defaultHost",
      "dev.example.com\n"
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

  test("infers typed iOS simulator UserDefaults values with defaults read-type", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app onboardingComplete",
      "1\n"
    );
    simctl.setCommandResult(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read-type com.example.app onboardingComplete",
      "Type is boolean\n"
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
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app onboardingComplete",
        timeoutMs: 5000,
      },
      {
        command: "spawn 12345678-1234-1234-1234-123456789ABC defaults read-type com.example.app onboardingComplete",
        timeoutMs: 5000,
      },
    ]);
  });

  test("returns a not-found result when iOS defaults reports a missing key", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(
      "spawn 12345678-1234-1234-1234-123456789ABC defaults read com.example.app missingKey",
      new Error("The domain/default pair of (com.example.app, missingKey) does not exist")
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
  });

  test("rejects physical iOS UserDefaults instead of reading the runner process defaults", async () => {
    const preferences = new AppPreferences(physicalIosDevice);

    await expect(preferences.getPreference({
      scope: "userDefaults",
      appId: "com.example.app",
      key: "onboardingComplete",
    })).rejects.toThrow("iOS physical devices");
  });
});
