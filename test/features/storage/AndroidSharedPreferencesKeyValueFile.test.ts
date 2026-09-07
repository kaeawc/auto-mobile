import { describe, expect, test } from "bun:test";
import {
  clearAndroidKeyValueFileDirect,
  isSharedPreferencesInspectionDisabledError,
  removeAndroidKeyValueDirect,
  setAndroidKeyValueDirect,
} from "../../../src/features/storage/AndroidSharedPreferencesKeyValueFile";
import { ActionableError, type ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { AppPreferences } from "../../../src/features/preferences/AppPreferences";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../../src/models";

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

    await setAndroidKeyValueDirect(
      adb,
      "device-1",
      "com.example.app",
      "settings",
      "probeB",
      "hello",
      "STRING",
    );

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

    await setAndroidKeyValueDirect(
      adb,
      "device-1",
      "com.example.app",
      "settings",
      "probeA",
      "new",
      "STRING",
    );

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
      "device-1",
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
        "device-1",
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
      setAndroidKeyValueDirect(
        adb,
        "device-1",
        "com.example.app",
        "settings",
        "big",
        "99999999999",
        "INT",
      ),
    ).rejects.toThrow(/32-bit range/);
  });

  test("surfaces a non-debuggable app failure as an actionable error, not the bare run-as message", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "shell run-as com.example.app cat shared_prefs/settings.xml",
      new Error("run-as: package not debuggable: com.example.app"),
    );

    await expect(
      setAndroidKeyValueDirect(
        adb,
        "device-1",
        "com.example.app",
        "settings",
        "probeA",
        "1",
        "STRING",
      ),
    ).rejects.toThrow(/debuggable\/test build/);
  });

  test.each(["+1.0", "1.", "1F", "1.e2", "0x1.0p0", "NaN", "Infinity"])(
    "accepts the SDK FLOAT spelling %s",
    async (value) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("cat shared_prefs/settings.xml", createExecResult("<map/>", ""));

      await setAndroidKeyValueDirect(
        adb,
        "device-1",
        "com.example.app",
        "settings",
        "ratio",
        value,
        "FLOAT",
      );

      expect(
        decodeBase64WritePayload(
          commandText(adb.getExecutedCommands(), "base64 -d > shared_prefs/settings.xml"),
        ),
      ).toContain(`value="${value}"`);
    },
  );

  test.each([" YES", "true ", "1", "no"])(
    "rejects non-strict BOOLEAN spelling %s",
    async (value) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("cat shared_prefs/settings.xml", createExecResult("<map/>", ""));

      await expect(
        setAndroidKeyValueDirect(
          adb,
          "device-1",
          "com.example.app",
          "settings",
          "enabled",
          value,
          "BOOLEAN",
        ),
      ).rejects.toThrow(/Expected BOOLEAN/);
    },
  );
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
    await setAndroidKeyValueDirect(
      adb,
      "device-1",
      "com.example.app",
      "settings",
      "probeA",
      "1",
      "STRING",
    );
    await removeAndroidKeyValueDirect(adb, "device-1", "com.example.app", "settings", "probeA");

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
      removeAndroidKeyValueDirect(adb, "device-1", "com.example.app", "settings", "probeA"),
    ).resolves.toBeUndefined();
    expect(adb.getExecutedCommands()).not.toContainEqual(
      expect.stringContaining("base64 -d > shared_prefs/settings.xml"),
    );
  });
});

describe("clearAndroidKeyValueFileDirect", () => {
  test("writes an empty map without needing to read the file first", async () => {
    const adb = new FakeAdbExecutor();

    await clearAndroidKeyValueFileDirect(adb, "device-1", "com.example.app", "settings");

    const commands = adb.getExecutedCommands();
    expect(commands.some((entry) => entry.includes("cat shared_prefs/settings.xml"))).toBe(false);
    const writeCommand = commandText(commands, "base64 -d > shared_prefs/settings.xml");
    const writtenXml = decodeBase64WritePayload(writeCommand);
    expect(writtenXml).toContain("<map");
    expect(writtenXml).not.toContain("<string");
  });
});

/**
 * A minimal stateful `adb` that models `shared_prefs/<file>.xml` as a single in-memory
 * document: `cat` returns the CURRENT stored XML (captured synchronously, as the real
 * command would), and the `base64 -d > ...xml` write persists the decoded payload. This
 * exposes the lost-update TOCTOU (issue #6292): two concurrent read-modify-write mutations
 * to the same file each read the same snapshot and the later write clobbers the earlier,
 * unless the direct mutations are serialized per (app, file).
 */
class StatefulPrefsAdb extends FakeAdbExecutor {
  private storedXml = "<map/>";
  private readCount = 0;
  private firstReadBlocked = false;
  private firstReadStartedResolve: (() => void) | undefined;
  private firstReadRelease: (() => void) | undefined;

  blockFirstRead(): { readStarted: Promise<void>; release: () => void } {
    this.firstReadBlocked = true;
    const readStarted = new Promise<void>((resolve) => {
      this.firstReadStartedResolve = resolve;
    });
    const release = () => this.firstReadRelease?.();
    return { readStarted, release };
  }

  currentXml(): string {
    return this.storedXml;
  }

  reads(): number {
    return this.readCount;
  }

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    if (command.includes("cat shared_prefs/settings.xml")) {
      // Capture the snapshot at read time (as `cat` would), then yield a microtask so a
      // concurrent, unserialized mutation gets a chance to read the SAME stale snapshot.
      const snapshot = this.storedXml;
      this.readCount += 1;
      if (this.firstReadBlocked) {
        this.firstReadBlocked = false;
        this.firstReadStartedResolve?.();
        await new Promise<void>((resolve) => {
          this.firstReadRelease = resolve;
        });
      }
      await Promise.resolve();
      return createExecResult(snapshot, "");
    }
    if (command.includes("base64 -d > shared_prefs/settings.xml")) {
      this.storedXml = decodeBase64WritePayload(command);
      return createExecResult("", "");
    }
    return super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
  }
}

describe("direct mutation serialization (#6292)", () => {
  test("two concurrent mutations to the same file both persist — no lost update", async () => {
    const adb = new StatefulPrefsAdb();
    const gate = adb.blockFirstRead();

    const first = setAndroidKeyValueDirect(
      adb,
      "device-1",
      "com.example.app",
      "settings",
      "alpha",
      "1",
      "STRING",
    );
    await gate.readStarted;
    const second = setAndroidKeyValueDirect(
      adb,
      "device-1",
      "com.example.app",
      "settings",
      "beta",
      "2",
      "STRING",
    );
    await Promise.resolve();
    expect(adb.reads()).toBe(1);
    gate.release();
    await Promise.all([first, second]);

    const finalXml = adb.currentXml();
    expect(finalXml).toContain('<string name="alpha">1</string>');
    expect(finalXml).toContain('<string name="beta">2</string>');
  });

  test("a mixed set + remove race on the same file does not clobber the other's write", async () => {
    const adb = new StatefulPrefsAdb();
    // Seed an existing key so the concurrent remove has something to delete.
    await setAndroidKeyValueDirect(
      adb,
      "device-1",
      "com.example.app",
      "settings",
      "existing",
      "0",
      "STRING",
    );

    await Promise.all([
      setAndroidKeyValueDirect(
        adb,
        "device-1",
        "com.example.app",
        "settings",
        "added",
        "9",
        "STRING",
      ),
      removeAndroidKeyValueDirect(adb, "device-1", "com.example.app", "settings", "existing"),
    ]);

    const finalXml = adb.currentXml();
    expect(finalXml).toContain('<string name="added">9</string>');
    expect(finalXml).not.toContain('name="existing"');
  });

  test("does not serialize independent devices sharing the same app and file", async () => {
    const firstDeviceAdb = new StatefulPrefsAdb();
    const secondDeviceAdb = new StatefulPrefsAdb();
    const firstGate = firstDeviceAdb.blockFirstRead();
    const secondGate = secondDeviceAdb.blockFirstRead();

    const first = setAndroidKeyValueDirect(
      firstDeviceAdb,
      "device-1",
      "com.example.app",
      "settings",
      "alpha",
      "1",
      "STRING",
    );
    await firstGate.readStarted;
    const second = setAndroidKeyValueDirect(
      secondDeviceAdb,
      "device-2",
      "com.example.app",
      "settings",
      "beta",
      "2",
      "STRING",
    );

    await secondGate.readStarted;
    firstGate.release();
    secondGate.release();
    await Promise.all([first, second]);
  });

  test("serializes the legacy setPreference route with the direct key-value route", async () => {
    const adb = new StatefulPrefsAdb();
    const gate = adb.blockFirstRead();
    const device: BootedDevice = { name: "Pixel", platform: "android", deviceId: "device-1" };
    const factory: AdbClientFactory = { create: () => adb };
    const preferences = new AppPreferences(device, { adbFactory: factory });

    const legacyWrite = preferences.setPreference({
      scope: "sharedPreferences",
      appId: "com.example.app",
      suite: "settings",
      key: "legacy",
      value: "one",
      type: "string",
    });
    await gate.readStarted;
    const directWrite = setAndroidKeyValueDirect(
      adb,
      "device-1",
      "com.example.app",
      "settings",
      "direct",
      "two",
      "STRING",
    );

    // The direct route must not begin its stale read while the legacy route owns
    // the whole-file transaction.
    await Promise.resolve();
    expect(adb.reads()).toBe(1);
    gate.release();
    await Promise.all([legacyWrite, directWrite]);

    expect(adb.currentXml()).toContain('<string name="legacy">one</string>');
    expect(adb.currentXml()).toContain('<string name="direct">two</string>');
  });
});
