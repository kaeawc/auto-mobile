import { describe, expect, test } from "bun:test";
import {
  clearAndroidKeyValueFileDirect,
  isSharedPreferencesInspectionDisabledError,
  removeAndroidKeyValueDirect,
  setAndroidKeyValueDirect,
} from "../../../src/features/storage/AndroidSharedPreferencesKeyValueFile";
import { ActionableError } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

// This module gives setKeyValue/removeKeyValue/clearKeyValueFile the same reachability
// as the setPreference/getPreference tools for Android SharedPreferences (issue #6292):
// direct `adb shell run-as` XML edits, with no dependency on the SDK's
// SharedPreferencesInspector capability.

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

describe("isSharedPreferencesInspectionDisabledError", () => {
  test("matches the SDK's disabled-inspection error text", () => {
    expect(
      isSharedPreferencesInspectionDisabledError(
        new Error("Failed to set key-value entry: Error: SharedPreferences inspection is disabled"),
      ),
    ).toBe(true);
  });

  test("does not match an unrelated error", () => {
    expect(isSharedPreferencesInspectionDisabledError(new Error("WebSocket not connected"))).toBe(
      false,
    );
  });

  test("does not match a non-Error thrown value", () => {
    expect(isSharedPreferencesInspectionDisabledError("boom")).toBe(false);
  });
});

describe("setAndroidKeyValueDirect", () => {
  test("writes a new STRING entry into the on-device XML file", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cat shared_prefs/settings.xml", createExecResult("<map/>", ""));

    await setAndroidKeyValueDirect(adb, "com.example.app", "settings", "probeB", "hello", "STRING");

    const commands = adb.getExecutedCommands();
    const writeCommand = commandText(commands, "base64 -d > shared_prefs/settings.xml");
    const writtenXml = decodeBase64WritePayload(writeCommand);
    expect(writtenXml).toContain('<string name="probeB">hello</string>');
  });

  test("replaces an existing entry for the same key rather than duplicating it", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "cat shared_prefs/settings.xml",
      createExecResult('<map><string name="probeA">old</string></map>', ""),
    );

    await setAndroidKeyValueDirect(adb, "com.example.app", "settings", "probeA", "new", "STRING");

    const writeCommand = commandText(
      adb.getExecutedCommands(),
      "base64 -d > shared_prefs/settings.xml",
    );
    const writtenXml = decodeBase64WritePayload(writeCommand);
    expect(writtenXml).toContain('<string name="probeA">new</string>');
    expect(writtenXml.match(/name="probeA"/g)?.length).toBe(1);
  });

  test("writes a STRING_SET entry from a JSON array", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cat shared_prefs/settings.xml", createExecResult("<map/>", ""));

    await setAndroidKeyValueDirect(
      adb,
      "com.example.app",
      "settings",
      "tags",
      '["a","b"]',
      "STRING_SET",
    );

    const writtenXml = decodeBase64WritePayload(
      commandText(adb.getExecutedCommands(), "base64 -d > shared_prefs/settings.xml"),
    );
    expect(writtenXml).toContain('<set name="tags">');
    expect(writtenXml).toContain("<string>a</string>");
    expect(writtenXml).toContain("<string>b</string>");
  });

  test("rejects a malformed STRING_SET value with an actionable error", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cat shared_prefs/settings.xml", createExecResult("<map/>", ""));

    await expect(
      setAndroidKeyValueDirect(
        adb,
        "com.example.app",
        "settings",
        "tags",
        "not-json",
        "STRING_SET",
      ),
    ).rejects.toThrow(ActionableError);
  });

  test("rejects an out-of-range INT value with an actionable error", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cat shared_prefs/settings.xml", createExecResult("<map/>", ""));

    await expect(
      setAndroidKeyValueDirect(adb, "com.example.app", "settings", "big", "99999999999", "INT"),
    ).rejects.toThrow(/32-bit range/);
  });

  test("surfaces a non-debuggable app failure as an actionable error, not the bare run-as message", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "shell run-as com.example.app cat shared_prefs/settings.xml",
      new Error("run-as: package not debuggable: com.example.app"),
    );

    await expect(
      setAndroidKeyValueDirect(adb, "com.example.app", "settings", "probeA", "1", "STRING"),
    ).rejects.toThrow(/debuggable\/test build/);
  });
});

describe("removeAndroidKeyValueDirect", () => {
  test("removes an entry written via the same direct-file path, leaving other keys intact", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("cat shared_prefs/settings.xml", [
      createExecResult("<map/>", ""),
      createExecResult(
        '<map><string name="probeA">1</string><string name="probeB">2</string></map>',
        "",
      ),
    ]);

    // setPreference-equivalent write, then delete through the same file.
    await setAndroidKeyValueDirect(adb, "com.example.app", "settings", "probeA", "1", "STRING");
    await removeAndroidKeyValueDirect(adb, "com.example.app", "settings", "probeA");

    const commands = adb.getExecutedCommands();
    const secondWrite = commands
      .filter((entry) => entry.includes("base64 -d > shared_prefs/settings.xml"))
      .at(-1)!;
    const writtenXml = decodeBase64WritePayload(secondWrite);
    expect(writtenXml).not.toContain("probeA");
    expect(writtenXml).toContain('<string name="probeB">2</string>');
  });

  test("removing a key from a missing preferences file is a no-op, not an error", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "shell run-as com.example.app cat shared_prefs/settings.xml",
      new Error("cat: shared_prefs/settings.xml: No such file or directory"),
    );

    await expect(
      removeAndroidKeyValueDirect(adb, "com.example.app", "settings", "probeA"),
    ).resolves.toBeUndefined();
  });
});

describe("clearAndroidKeyValueFileDirect", () => {
  test("writes an empty map without needing to read the file first", async () => {
    const adb = new FakeAdbExecutor();

    await clearAndroidKeyValueFileDirect(adb, "com.example.app", "settings");

    const commands = adb.getExecutedCommands();
    expect(commands.some((entry) => entry.includes("cat shared_prefs/settings.xml"))).toBe(false);
    const writeCommand = commandText(commands, "base64 -d > shared_prefs/settings.xml");
    const writtenXml = decodeBase64WritePayload(writeCommand);
    expect(writtenXml).toContain("<map");
    expect(writtenXml).not.toContain("<string");
  });
});
