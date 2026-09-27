import { describe, expect, mock, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import {
  DefaultSendKeysCommandExecutor,
  SendKeys,
  type SendKeysCommandExecutor,
  type SendKeysInputKey,
  type SendKeysObserver,
  type SendKeysTextClient,
} from "../../../src/features/action/SendKeys";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import {
  clearAndroidImeQuarantine,
  withAndroidImeLock,
} from "../../../src/features/action/androidImeLock";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

const iosDevice: BootedDevice = {
  deviceId: "ios-sim",
  name: "iPhone",
  platform: "ios",
};

function createObserver(
  result: ObserveResult = { timestamp: Date.now() } as ObserveResult,
): SendKeysObserver & {
  calls: number;
  options: Array<Parameters<SendKeysObserver["execute"]>[0]>;
} {
  return {
    calls: 0,
    options: [],
    async execute(options) {
      this.calls++;
      this.options.push(options);
      return result;
    },
  };
}

function focusedAndroidObservation(
  text: string = "",
  properties: Record<string, unknown> = {},
): ObserveResult {
  return {
    timestamp: Date.now(),
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            focused: "true",
            text,
            class: "android.widget.EditText",
            ...properties,
          },
        },
      },
    },
  } as ObserveResult;
}

function createTextClient(
  options: {
    supportsImeCommit?: boolean;
    supportsImeKeyEvents?: boolean;
    supportsKeyboardProfiles?: boolean;
    setKeyboardProfile?: (
      id: string,
    ) => Promise<{ success: boolean; previousProfileId?: string; error?: string }>;
    commitViaIme?: (
      text: string,
      priorImeId: string | null,
    ) => Promise<{
      success: boolean;
      error?: string;
      partialApplication?: boolean;
      sessionUnsafe?: boolean;
    }>;
  } = {},
) {
  const calls: string[] = [];
  const commitViaImeCalls: Array<{ text: string; priorImeId: string | null }> = [];
  const commitDeliveries: Array<"commit" | "keyEvents" | undefined> = [];
  let supportsImeCommitCalls = 0;
  const client: SendKeysTextClient = {
    replace: async (text) => {
      calls.push(`replace:${text}`);
      return { success: true };
    },
    insert: async (text) => {
      calls.push(`insert:${text}`);
      return { success: true };
    },
    clear: async () => {
      calls.push("clear");
      return { success: true };
    },
    ime: async (action) => {
      calls.push(`ime:${action}`);
      return { success: true };
    },
    supportsImeCommit: async () => {
      supportsImeCommitCalls++;
      calls.push("supportsImeCommit");
      return options.supportsImeCommit ?? true;
    },
    supportsImeKeyEvents: async () => options.supportsImeKeyEvents ?? true,
    supportsKeyboardProfiles: async () => options.supportsKeyboardProfiles ?? true,
    setKeyboardProfile: async (id) => {
      calls.push(`setKeyboardProfile:${id}`);
      return options.setKeyboardProfile?.(id) ?? { success: true, previousProfileId: "direct" };
    },
    commitViaIme: async (text, priorImeId, _signal, delivery) => {
      calls.push(`commitViaIme:${text}:${priorImeId ?? "none"}`);
      commitViaImeCalls.push({ text, priorImeId });
      commitDeliveries.push(delivery);
      return options.commitViaIme ? options.commitViaIme(text, priorImeId) : { success: true };
    },
  };
  return {
    client,
    calls,
    commitViaImeCalls,
    commitDeliveries,
    getSupportsImeCommitCalls: () => supportsImeCommitCalls,
  };
}

function createAdbFactory(adb: FakeAdbExecutor): AdbClientFactory {
  return { create: () => adb };
}

describe("SendKeys", () => {
  test("executes commands in order, stops on failure, and observes once", async () => {
    const calls: string[] = [];
    const executor: SendKeysCommandExecutor = {
      type: mock(async (command) => {
        calls.push(`type:${command.text}`);
        return {
          index: -1,
          action: "type",
          success: true,
          textLength: command.text.length,
          operation: command.operation ?? "insert",
          requestedMode: command.mode ?? "auto",
          resolvedMode: "eventAll",
        };
      }),
      key: mock(async (command) => {
        calls.push(`key:${command.key}`);
        return { index: -1, action: "key", key: command.key, success: false, error: "blocked" };
      }),
      clear: mock(async () => {
        calls.push("clear");
        return { success: true };
      }),
    };
    const observer = createObserver();
    const sendKeys = new SendKeys(androidDevice, undefined, {
      executor,
      observer,
      focuser: {
        focus: async () => {
          calls.push("focus");
          return { success: true };
        },
      },
      timestampProvider: {
        now: async () => {
          calls.push("timestamp");
          return 1234;
        },
      },
    });

    const result = await sendKeys.execute(
      [{ action: "type", text: "secret" }, { action: "key", key: "tab" }, { action: "clear" }],
      { text: "First name" },
    );

    expect(calls).toEqual(["timestamp", "focus", "type:secret", "key:tab"]);
    expect(result.success).toBe(false);
    expect(result.completedCommands).toBe(1);
    expect(result.failedIndex).toBe(1);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).not.toHaveProperty("text");
    expect(observer.calls).toBe(1);
    expect(observer.options).toEqual([
      { signal: undefined, skipWaitForFresh: false, minTimestamp: 1234 },
    ]);
  });

  test("accepts a hierarchy pushed before command delivery returns", async () => {
    let deviceTime = 1000;
    const pushedObservation = { timestamp: 1001 } as ObserveResult;
    const sendKeys = new SendKeys(androidDevice, undefined, {
      timestampProvider: { now: async () => deviceTime },
      executor: {
        type: async () => {
          deviceTime = 1002;
          return { index: -1, action: "type", success: true };
        },
        key: async () => {
          throw new Error("unexpected key");
        },
        clear: async () => {
          throw new Error("unexpected clear");
        },
      },
      observer: {
        execute: async (options) => {
          expect(options?.minTimestamp).toBeLessThanOrEqual(pushedObservation.timestamp);
          return pushedObservation;
        },
      },
    });

    const result = await sendKeys.execute([{ action: "type", text: "updated" }]);
    expect(result.success).toBe(true);
    expect(result.observation).toBe(pushedObservation);
  });

  test("does not execute commands when initial targeting fails", async () => {
    const observer = createObserver();
    const type = mock(async () => {
      throw new Error("must not execute");
    });
    const sendKeys = new SendKeys(androidDevice, undefined, {
      observer,
      focuser: { focus: async () => ({ success: false, error: "field missing" }) },
      timestampProvider: { now: async () => 1234 },
      executor: {
        type,
        key: mock(async () => {
          throw new Error("must not execute");
        }),
        clear: mock(async () => {
          throw new Error("must not execute");
        }),
      },
    });

    const result = await sendKeys.execute([{ action: "type", text: "value" }], {
      text: "missing",
    });

    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      failedIndex: 0,
      error: "field missing",
    });
    expect(type).not.toHaveBeenCalled();
    expect(observer.calls).toBe(1);
    expect(observer.options).toEqual([
      { signal: undefined, skipWaitForFresh: false, minTimestamp: undefined },
    ]);
  });

  test("rejects invalid imeKeyEvents anywhere in a targeted batch before focus or commands", async () => {
    const calls: string[] = [];
    const sendKeys = new SendKeys(androidDevice, undefined, {
      observer: createObserver(),
      timestampProvider: { now: async () => 1234 },
      focuser: {
        focus: async () => {
          calls.push("focus");
          return { success: true };
        },
      },
      executor: {
        type: async () => {
          calls.push("type");
          return { index: -1, action: "type", success: true };
        },
        key: async () => {
          calls.push("key");
          return { index: -1, action: "key", key: "tab", success: true };
        },
        clear: async () => {
          calls.push("clear");
          return { success: true };
        },
      },
    });

    const result = await sendKeys.execute(
      [
        { action: "type", text: "valid", mode: "imeKeyEvents" },
        { action: "type", text: "é", mode: "imeKeyEvents" },
      ],
      { text: "Email" },
    );

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      failedIndex: 1,
      error: expect.stringContaining("printable ASCII"),
    });
    expect(result.commands.every((command) => !command.partialApplication)).toBe(true);
  });
});

describe("DefaultSendKeysCommandExecutor", () => {
  const commitImeId = "dev.jasonpearson.automobile.ctrlproxy/.ime.CtrlProxyIme";
  const priorImeId = "com.example.keyboard/.Ime";

  test("auto mode routes plain and formatting text through IME for insert and replace", async () => {
    for (const [operation, text] of [
      ["insert", "plain"],
      ["replace", "plain"],
      ["insert", "note `x`"],
      ["replace", "note `x`"],
    ] as const) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: `${priorImeId}\n`, stderr: "" },
        { stdout: `${commitImeId}\n`, stderr: "" },
      ]);
      const textClient = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation()),
        { textClient: textClient.client },
      );

      const result = await executor.type({ action: "type", text, operation });

      expect(result.resolvedMode).toBe("ime");
      expect(textClient.commitViaImeCalls).toEqual([{ text, priorImeId }]);
      expect(
        adb.getExecutedCommands().every((command) => !command.startsWith("shell input keyevent")),
      ).toBe(true);
    }
  });

  test("auto IME falls back to the previous delivery modes when commit is unavailable", async () => {
    for (const [operation, mode] of [
      ["insert", "eventAll"],
      ["replace", "a11y"],
    ] as const) {
      const adb = new FakeAdbExecutor();
      const textClient = createTextClient({ supportsImeCommit: false });
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation()),
        { textClient: textClient.client },
      );

      const result = await executor.type({ action: "type", text: "note `x`", operation });

      expect(result).toMatchObject({ success: true, resolvedMode: mode });
      expect(textClient.commitViaImeCalls).toEqual([]);
      if (mode === "eventAll") {
        expect(adb.getExecutedCommands().length).toBeGreaterThan(0);
      } else {
        expect(textClient.calls).toContain("replace:note `x`");
      }
    }
  });

  test("explicit IME key events require capability and use event delivery", async () => {
    const supported = createTextClient();
    const supportedAdb = new FakeAdbExecutor();
    supportedAdb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: `${priorImeId}\n`, stderr: "" },
      { stdout: `${commitImeId}\n`, stderr: "" },
    ]);
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(supportedAdb),
      createObserver(focusedAndroidObservation()),
      { textClient: supported.client },
    );
    const result = await executor.type({ action: "type", text: "Ab!", mode: "imeKeyEvents" });
    expect(result).toMatchObject({ success: true, resolvedMode: "imeKeyEvents" });
    expect(supported.commitDeliveries).toEqual(["keyEvents"]);

    const unsupported = createTextClient({ supportsImeKeyEvents: false });
    const adb = new FakeAdbExecutor();
    const unsupportedExecutor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: unsupported.client },
    );
    const rejected = await unsupportedExecutor.type({
      action: "type",
      text: "Ab!",
      mode: "imeKeyEvents",
    });
    expect(rejected).toMatchObject({
      success: false,
      error: expect.stringContaining("unavailable"),
    });
    expect(unsupported.commitDeliveries).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each(["é", "😀", "a😀", "line\nbreak", "a\tb", "ASCII then é"])(
    "imeKeyEvents replacement rejects %j before any mutation",
    async (text) => {
      const adb = new FakeAdbExecutor();
      const textClient = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation("original")),
        { textClient: textClient.client },
      );
      const result = await executor.type({
        action: "type",
        text,
        operation: "replace",
        mode: "imeKeyEvents",
      });
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("printable ASCII"),
      });
      expect(result.partialApplication).toBeUndefined();
      expect(textClient.calls).toEqual([]);
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test("imeKeyEvents ASCII and empty replacements still commit and clear", async () => {
    for (const text of ["Ab!", ""]) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: priorImeId, stderr: "" },
        { stdout: commitImeId, stderr: "" },
      ]);
      const textClient = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation("original")),
        { textClient: textClient.client },
      );
      expect(
        await executor.type({ action: "type", text, operation: "replace", mode: "imeKeyEvents" }),
      ).toMatchObject({ success: true });
      expect(textClient.calls).toContain("clear");
      expect(textClient.commitDeliveries).toEqual(["keyEvents"]);
    }
  });

  test("ime mode still accepts Unicode replacement text", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("original")),
      { textClient: textClient.client },
    );
    expect(
      await executor.type({ action: "type", text: "a😀", operation: "replace", mode: "ime" }),
    ).toMatchObject({ success: true });
    expect(textClient.calls).toContain("clear");
    expect(textClient.commitViaImeCalls[0]?.text).toBe("a😀");
  });

  test("explicit modes take precedence over trigger text and do not auto-fallback", async () => {
    const explicitImeClient = createTextClient({ supportsImeCommit: false });
    const explicitImeExecutor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: explicitImeClient.client },
    );
    const imeResult = await explicitImeExecutor.type({
      action: "type",
      text: "note `x`",
      mode: "ime",
    });
    expect(imeResult).toMatchObject({ success: false, resolvedMode: "ime" });

    const explicitA11yClient = createTextClient();
    const explicitA11yExecutor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: explicitA11yClient.client },
    );
    const a11yResult = await explicitA11yExecutor.type({
      action: "type",
      text: "note `x`",
      mode: "a11y",
    });
    expect(a11yResult).toMatchObject({ success: true, resolvedMode: "a11y" });
    expect(explicitA11yClient.calls).toContain("insert:note `x`");
  });

  test("ime mode activates the companion IME, commits with the prior id, and restores it", async () => {
    const events: string[] = [];
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: `${priorImeId}\n`, stderr: "" },
      { stdout: `${commitImeId}\n`, stderr: "" },
    ]);
    const executeCommand = adb.executeCommand.bind(adb);
    adb.executeCommand = async (command, ...options) => {
      events.push(`adb:${command}`);
      return executeCommand(command, ...options);
    };
    const textClient = createTextClient({
      commitViaIme: async (text, prior) => {
        events.push(`commit:${text}:${prior ?? "none"}`);
        return { success: true };
      },
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    const result = await executor.type({ action: "type", text: "*bold*", mode: "ime" });

    expect(result).toMatchObject({ success: true, resolvedMode: "ime" });
    expect(textClient.getSupportsImeCommitCalls()).toBe(1);
    expect(textClient.commitViaImeCalls).toEqual([{ text: "*bold*", priorImeId }]);
    expect(events).toEqual([
      "adb:shell settings get secure default_input_method",
      "adb:shell ime list -s",
      `adb:shell ime enable ${commitImeId}`,
      `adb:shell ime set ${commitImeId}`,
      "adb:shell settings get secure default_input_method",
      `commit:*bold*:${priorImeId}`,
      `adb:shell ime set ${priorImeId}`,
      `adb:shell ime disable ${commitImeId}`,
    ]);
  });

  test("ime mode preserves a companion keyboard that was already enabled", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell ime list -s", {
      stdout: `${priorImeId}\n${commitImeId}\n`,
      stderr: "",
    });
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: createTextClient().client },
    );

    expect((await executor.type({ action: "type", text: "value", mode: "ime" })).success).toBe(
      true,
    );
    expect(adb.getExecutedCommands()).not.toContain(`shell ime enable ${commitImeId}`);
    expect(adb.getExecutedCommands()).not.toContain(`shell ime disable ${commitImeId}`);
    expect(adb.getExecutedCommands()).toContain(`shell ime set ${priorImeId}`);
  });

  test("ime disable failures do not fail a successful commit", async () => {
    for (const failure of ["stderr", "throw"] as const) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: `${priorImeId}\n`, stderr: "" },
        { stdout: `${commitImeId}\n`, stderr: "" },
      ]);
      if (failure === "stderr") {
        adb.setCommandResponse("shell ime disable", { stdout: "", stderr: "disable failed" });
      } else {
        adb.setCommandError("shell ime disable", new Error("disable failed"));
      }
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(),
        { textClient: createTextClient().client },
      );

      const result = await executor.type({ action: "type", text: "value", mode: "ime" });

      expect(result).toMatchObject({ success: true, resolvedMode: "ime" });
      expect(adb.getExecutedCommands()).toContain(`shell ime disable ${commitImeId}`);
    }
  });

  test("ime mode disables a temporarily enabled IME when there was no prior default", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: "null\n", stderr: "" },
      { stdout: `${commitImeId}\n`, stderr: "" },
    ]);
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({ action: "type", text: "value", mode: "ime" });

    expect(result).toMatchObject({ success: true, resolvedMode: "ime" });
    expect(adb.getExecutedCommands()).not.toContain("shell ime set null");
    expect(adb.getExecutedCommands()).not.toContain(`shell ime set ${priorImeId}`);
    expect(adb.getExecutedCommands()).toContain(`shell ime disable ${commitImeId}`);
  });

  test("ime mode fails closed before switching when the command is not advertised", async () => {
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient({ supportsImeCommit: false });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    const result = await executor.type({ action: "type", text: "value", mode: "ime" });

    expect(result).toMatchObject({
      success: false,
      resolvedMode: "ime",
      error: expect.stringContaining("IME commit is not available"),
    });
    expect(textClient.getSupportsImeCommitCalls()).toBe(1);
    expect(textClient.commitViaImeCalls).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("per-call profile is set before commit and restored afterward", async () => {
    const events: string[] = [];
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      setKeyboardProfile: async (id) => {
        events.push(`profile:${id}`);
        return { success: true, previousProfileId: "direct" };
      },
      commitViaIme: async () => {
        events.push("commit");
        return { success: true };
      },
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    const result = await executor.type({
      action: "type",
      text: "value",
      keyboardProfile: "gboard",
    });
    expect(result).toMatchObject({ success: true, resolvedMode: "ime" });
    expect(events).toEqual(["profile:gboard", "commit", "profile:direct"]);
  });

  test("per-call profile skips restoration when already active", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      setKeyboardProfile: async () => ({ success: true, previousProfileId: "gboard" }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    expect(
      (await executor.type({ action: "type", text: "value", keyboardProfile: "gboard" })).success,
    ).toBe(true);
    expect(textClient.calls.filter((call) => call.startsWith("setKeyboardProfile"))).toEqual([
      "setKeyboardProfile:gboard",
    ]);
  });

  test("profile restoration failure does not mask a successful commit", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      setKeyboardProfile: async (id) => {
        if (id === "direct") {
          throw new Error("restore failed");
        }
        return { success: true, previousProfileId: "direct" };
      },
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    expect(
      (await executor.type({ action: "type", text: "value", keyboardProfile: "gboard" })).success,
    ).toBe(true);
    expect(adb.getExecutedCommands()).toContain(`shell ime set ${priorImeId}`);
  });

  test("unsupported profile command fails before adb mutation", async () => {
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient({ supportsKeyboardProfiles: false });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    const result = await executor.type({
      action: "type",
      text: "value",
      keyboardProfile: "gboard",
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("does not support keyboard profiles"),
    });
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(textClient.commitViaImeCalls).toEqual([]);
  });

  test("profile with explicit non-IME mode returns validation error", async () => {
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    const result = await executor.type({
      action: "type",
      text: "value",
      mode: "a11y",
      keyboardProfile: "gboard",
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("requires mode: ime"),
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("ime mode restores the prior IME when commit rejects", async () => {
    const events: string[] = [];
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const executeCommand = adb.executeCommand.bind(adb);
    adb.executeCommand = async (command, ...options) => {
      events.push(`adb:${command}`);
      return executeCommand(command, ...options);
    };
    const textClient = createTextClient({
      commitViaIme: async () => {
        events.push("commit:rejected");
        throw new Error("commit rejected");
      },
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    const result = await executor.type({ action: "type", text: "value", mode: "ime" });

    expect(result).toMatchObject({ success: false, resolvedMode: "ime", error: "commit rejected" });
    expect(textClient.commitViaImeCalls).toEqual([{ text: "value", priorImeId }]);
    expect(events.at(-3)).toBe("commit:rejected");
    expect(events.at(-2)).toBe(`adb:shell ime set ${priorImeId}`);
    expect(events.at(-1)).toBe(`adb:shell ime disable ${commitImeId}`);
  });

  test("unacknowledged cancellation retains the IME and blocks later switches", async () => {
    const device = { ...androidDevice, deviceId: "ime-unsafe-test" };
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      commitViaIme: async () => ({ success: false, partialApplication: true, sessionUnsafe: true }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      device,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    try {
      expect(await executor.type({ action: "type", text: "value", mode: "ime" })).toMatchObject({
        success: false,
        partialApplication: true,
      });
      expect(adb.getExecutedCommands()).not.toContain(`shell ime set ${priorImeId}`);
      expect(adb.getExecutedCommands()).not.toContain(`shell ime disable ${commitImeId}`);
      await expect(withAndroidImeLock(device.deviceId, async () => {})).rejects.toThrow("unknown");
    } finally {
      clearAndroidImeQuarantine(device.deviceId);
    }
  });

  test("failed IME replacement reports partial application after clearing", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      commitViaIme: async () => ({ success: false, error: "deadline exceeded" }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
      mode: "ime",
    });

    expect(result).toMatchObject({ success: false, partialApplication: true });
    expect(textClient.calls).toContain("clear");
    expect(adb.getExecutedCommands()).toContain(`shell ime set ${priorImeId}`);
  });

  test("serializes overlapping ime-mode calls on one device so capture/restore never interleave (#7464)", async () => {
    const device: BootedDevice = { ...androidDevice, deviceId: "emulator-overlap-7464" };
    const events: string[] = [];
    const adb = new FakeAdbExecutor();
    // Two full commits: each reads default_input_method twice (capture + verify).
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const executeCommand = adb.executeCommand.bind(adb);
    adb.executeCommand = async (command, ...options) => {
      events.push(`adb:${command}`);
      return executeCommand(command, ...options);
    };
    let releaseFirst!: () => void;
    const firstCommitGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const textClient = createTextClient({
      commitViaIme: async (text) => {
        events.push(`commit:${text}`);
        if (text === "first") {
          await firstCommitGate;
        }
        events.push(`commit-done:${text}`);
        return { success: true };
      },
    });
    const makeExecutor = () =>
      new DefaultSendKeysCommandExecutor(device, createAdbFactory(adb), createObserver(), {
        textClient: textClient.client,
      });
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) {
          return;
        }
        await defaultTimer.sleep(5);
      }
      throw new Error("condition not met in time");
    };

    const first = makeExecutor().type({ action: "type", text: "first", mode: "ime" });
    // Call 1 holds the per-device lock and parks at its commit.
    await waitFor(() => events.includes("commit:first"));
    const snapshotAtBlock = [...events];

    const second = makeExecutor().type({ action: "type", text: "second", mode: "ime" });
    // Give call 2 every chance to progress; the lock must keep it from doing anything.
    for (let i = 0; i < 5; i++) {
      await defaultTimer.sleep(5);
    }
    expect(events).toEqual(snapshotAtBlock);

    releaseFirst();
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);

    // No interleave: call 2 does nothing until call 1 has fully restored.
    const firstRestoreIdx = events.indexOf(`adb:shell ime set ${priorImeId}`);
    const secondCaptureIdx = events.indexOf(
      "adb:shell settings get secure default_input_method",
      firstRestoreIdx,
    );
    expect(firstRestoreIdx).toBeGreaterThan(0);
    expect(secondCaptureIdx).toBeGreaterThan(firstRestoreIdx);
    expect(events.indexOf("commit:second")).toBeGreaterThan(events.indexOf("commit-done:first"));
  });

  test("eventOnly replacement rejects unavailable text before mutation but accepts empty text", async () => {
    for (const text of [undefined, ""]) {
      const adb = new FakeAdbExecutor();
      const { client, calls } = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(
          focusedAndroidObservation("", { text, class: "custom.Editor", editable: true }),
        ),
        { textClient: client },
      );
      const result = await executor.type({
        action: "type",
        text: "a",
        operation: "replace",
        mode: "eventOnly",
      });
      expect(result.success).toBe(text === "");
      expect(calls).toEqual([]);
      if (text === undefined) {
        expect(result.error).toContain("text length");
        expect(adb.getExecutedCommands()).toEqual([]);
      } else {
        expect(adb.getExecutedCommands()).toContain("shell input keyevent KEYCODE_A");
        expect(adb.getExecutedCommands()).not.toContain("shell input keyevent KEYCODE_DEL");
      }
    }
  });

  test("iOS delivery exceptions report the XCUITest mechanism", async () => {
    const { client } = createTextClient();
    client.insert = async () => {
      throw new Error("runner unavailable");
    };
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );
    const result = await executor.type({ action: "type", text: "value", mode: "eventLast" });
    expect(result).toMatchObject({
      success: false,
      requestedMode: "eventLast",
      resolvedMode: "xcuiTypeText",
      error: "runner unavailable",
    });
  });

  test("preserves partial-application metadata from accessibility insertion", async () => {
    const { client } = createTextClient();
    client.insert = async () => ({
      success: false,
      error: "Text was inserted, but caret restoration failed; do not retry",
      partialApplication: true,
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.type({ action: "type", text: "value", mode: "a11y" });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "Text was inserted, but caret restoration failed; do not retry",
    });
  });

  test("explicit eventAll uses key events and accessibility-inserts unsupported runs", async () => {
    const adb = new FakeAdbExecutor();
    const observer = createObserver(focusedAndroidObservation());
    const { client, calls } = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      observer,
      { textClient: client },
    );

    const result = await executor.type({ action: "type", text: "a🙂", mode: "eventAll" });

    expect(result).toMatchObject({
      success: true,
      operation: "insert",
      requestedMode: "eventAll",
      resolvedMode: "eventAll",
      textLength: 2,
    });
    expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
    expect(calls).toEqual(["insert:🙂"]);
  });

  test("marks a late eventAll insertion failure as partially applied", async () => {
    const adb = new FakeAdbExecutor();
    const { client } = createTextClient();
    client.insert = async () => ({ success: false, error: "insert rejected" });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: client },
    );

    const result = await executor.type({ action: "type", text: "a🙂", mode: "eventAll" });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "insert rejected",
    });
    expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
  });

  test("marks a late eventAll key dispatch exception as partially applied", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("KEYCODE_B", new Error("dispatch rejected"));
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({ action: "type", text: "ab", mode: "eventAll" });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "dispatch rejected",
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
    ]);
  });

  test("marks an eventOnly dispatch exception after replacement clearing as partial", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("KEYCODE_B", new Error("dispatch rejected"));
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("old")),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({
      action: "type",
      text: "ab",
      operation: "replace",
      mode: "eventOnly",
    });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "dispatch rejected",
    });
    expect(adb.getExecutedCommands()).toContain("shell input keyevent KEYCODE_A");
    expect(adb.getExecutedCommands()).toContain("shell input keyevent KEYCODE_B");
  });

  test("marks a replacement clear failure after a delete as partially applied", async () => {
    const adb = new FakeAdbExecutor();
    const executeCommand = adb.executeCommand.bind(adb);
    let deleteCount = 0;
    adb.executeCommand = async (command, ...options) => {
      if (command === "shell input keyevent KEYCODE_DEL" && ++deleteCount === 2) {
        throw new Error("delete rejected");
      }
      return executeCommand(command, ...options);
    };
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("old")),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
      mode: "eventOnly",
    });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "delete rejected",
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL",
    ]);
  });

  test("does not mark a replacement clear failure before its first delete as partial", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("KEYCODE_DEL", new Error("delete rejected"));
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("old")),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
      mode: "eventOnly",
    });

    expect(result).toMatchObject({ success: false, error: "delete rejected" });
    expect(result).not.toHaveProperty("partialApplication");
  });

  test("accepts focused custom editable controls that expose text actions", async () => {
    const adb = new FakeAdbExecutor();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(
        focusedAndroidObservation("", {
          class: "com.example.CustomEditable",
          actions: ["set_text", "set_selection"],
        }),
      ),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({ action: "type", text: "a", mode: "eventAll" });

    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
  });

  test("eventAll resolves to a11y when no character has a key event", async () => {
    const adb = new FakeAdbExecutor();
    const { client, calls } = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.type({
      action: "type",
      text: "🙂",
      operation: "replace",
      mode: "eventAll",
    });

    expect(result).toMatchObject({
      success: true,
      requestedMode: "eventAll",
      resolvedMode: "a11y",
    });
    expect(calls).toEqual(["replace:🙂"]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("Android event modes reject an unfocused field before mutation", async () => {
    for (const mode of ["eventLast", "eventAll", "eventOnly"] as const) {
      const adb = new FakeAdbExecutor();
      const { client, calls } = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(),
        { textClient: client },
      );

      const result = await executor.type({
        action: "type",
        text: "a",
        mode,
      });

      expect(result).toMatchObject({
        success: false,
        error: "Android event delivery requires a focused editable field",
      });
      expect(calls).toEqual([]);
      expect(adb.getExecutedCommands()).toEqual([]);
    }
  });

  test("replace a11y remains atomic and reports the selected mode", async () => {
    const adb = new FakeAdbExecutor();
    const { client, calls } = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
      mode: "a11y",
    });

    expect(result).toMatchObject({ success: true, resolvedMode: "a11y" });
    expect(calls).toEqual(["replace:replacement"]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("semantic keys ignore modifiers while raw keys preserve them", async () => {
    const adb = new FakeAdbExecutor();
    const { client, calls } = createTextClient();
    const press = mock(async () => ({ success: true }));
    const inputKey: SendKeysInputKey = { press };
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: client, inputKey },
    );

    await executor.key({ action: "key", key: "next", modifiers: ["shift"] });
    await executor.key({ action: "key", key: "tab", modifiers: ["shift"] });

    expect(calls).toEqual(["ime:next"]);
    expect(press).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledWith("tab", undefined, undefined, ["shift"]);
  });

  test("rejects Android semantic keys without a focused editable field", async () => {
    const { client, calls } = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.key({ action: "key", key: "done" });

    expect(result).toMatchObject({
      success: false,
      error: "Android event delivery requires a focused editable field",
    });
    expect(calls).toEqual([]);
  });

  test("iOS accepts every mode and reports its XCUITest mechanism", async () => {
    for (const mode of ["a11y", "eventLast", "eventAll", "eventOnly", "ime"] as const) {
      const adb = new FakeAdbExecutor();
      const { client, calls } = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        iosDevice,
        createAdbFactory(adb),
        createObserver(),
        { textClient: client },
      );

      const result = await executor.type({
        action: "type",
        text: "value",
        operation: "replace",
        mode,
      });

      expect(result).toMatchObject({
        success: true,
        requestedMode: mode,
        resolvedMode: "xcuiTypeText",
      });
      expect(calls).toEqual(["clear", "insert:value"]);
    }
  });

  test("marks a failed iOS replacement insert as partially applied after clearing", async () => {
    const { client, calls } = createTextClient();
    client.insert = async (text) => {
      calls.push(`insert:${text}`);
      return { success: false, error: "insert rejected" };
    };
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
    });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "insert rejected",
      resolvedMode: "xcuiTypeText",
    });
    expect(calls).toEqual(["clear", "insert:replacement"]);
  });

  test("does not insert an iOS replacement after cancellation during clear", async () => {
    const controller = new AbortController();
    const { client, calls } = createTextClient();
    client.clear = async () => {
      calls.push("clear");
      controller.abort();
      return { success: true };
    };
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );

    await expect(
      executor.type(
        { action: "type", text: "replacement", operation: "replace" },
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(calls).toEqual(["clear"]);
  });
});
