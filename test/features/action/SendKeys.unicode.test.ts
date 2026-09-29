import { describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import {
  DefaultSendKeysCommandExecutor,
  type SendKeysObserver,
  type SendKeysTextClient,
} from "../../../src/features/action/SendKeys";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const android: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const ios: BootedDevice = { deviceId: "ios-sim", name: "iPhone", platform: "ios" };
const focused: ObserveResult = {
  timestamp: 1,
  viewHierarchy: {
    hierarchy: { node: { $: { focused: "true", class: "android.widget.EditText" } } },
  },
} as ObserveResult;
const observer: SendKeysObserver = { execute: async () => focused };
const corpus = {
  nonAscii: "é",
  emoji: "😀👨‍👩‍👧",
  combining: "e\u0301",
  cjk: "日本語",
};
const commitImeId = "dev.jasonpearson.automobile.ctrlproxy/.ime.CtrlProxyIme";
const priorImeId = "com.example.keyboard/.Ime";

function harness(device: BootedDevice) {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: priorImeId, stderr: "" },
    { stdout: commitImeId, stderr: "" },
  ]);
  const inserted: string[] = [];
  const replaced: string[] = [];
  const committed: string[] = [];
  const client: SendKeysTextClient = {
    insert: async (text) => {
      inserted.push(text);
      return { success: true };
    },
    replace: async (text) => {
      replaced.push(text);
      return { success: true };
    },
    clear: async () => ({ success: true }),
    ime: async () => ({ success: true }),
    supportsImeCommit: async () => true,
    supportsImeKeyEvents: async () => true,
    supportsKeyboardProfiles: async () => true,
    setKeyboardProfile: async () => ({ success: true, previousProfileId: "direct" }),
    commitViaIme: async (text) => {
      committed.push(text);
      return { success: true };
    },
  };
  const adbFactory: AdbClientFactory = { create: () => adb };
  return {
    adb,
    inserted,
    replaced,
    committed,
    executor: new DefaultSendKeysCommandExecutor(device, adbFactory, observer, {
      textClient: client,
      inputKey: { press: async () => ({ success: true }) },
    }),
  };
}

describe("sendKeys Unicode delivery (current behavior)", () => {
  test("iOS xcuiTypeText forwards each character category as one intact string", async () => {
    for (const text of Object.values(corpus)) {
      const h = harness(ios);
      expect(await h.executor.type({ action: "type", text, mode: "a11y" })).toMatchObject({
        success: true,
        resolvedMode: "xcuiTypeText",
      });
      expect(h.inserted).toEqual([text]);
    }
  });

  test("Android a11y forwards each character category as one intact string", async () => {
    for (const text of Object.values(corpus)) {
      const h = harness(android);
      expect(await h.executor.type({ action: "type", text, mode: "a11y" })).toMatchObject({
        success: true,
      });
      expect(h.inserted).toEqual([text]);
    }
  });

  test("Android ime commits each character category verbatim", async () => {
    for (const text of Object.values(corpus)) {
      const h = harness(android);
      expect(await h.executor.type({ action: "type", text, mode: "ime" })).toMatchObject({
        success: true,
      });
      expect(h.committed).toEqual([text]);
    }
  });

  test("Android eventAll sends ASCII bases as key events and unsupported runs as inserts", async () => {
    const cases = [
      [corpus.nonAscii, ["é"]],
      [corpus.emoji, ["😀👨‍👩‍👧"]],
      [corpus.combining, ["\u0301"]],
      [corpus.cjk, ["日本語"]],
      ["1️⃣", ["️⃣"]],
    ] as const;
    for (const [text, inserts] of cases) {
      const h = harness(android);
      expect(await h.executor.type({ action: "type", text, mode: "eventAll" })).toMatchObject({
        success: true,
      });
      expect(h.inserted).toEqual(inserts);
    }
  });

  test("Android eventLast can split an ASCII base from its combining mark", async () => {
    for (const text of [corpus.nonAscii, corpus.emoji, corpus.cjk]) {
      const wholeText = harness(android);
      expect(
        await wholeText.executor.type({ action: "type", text, mode: "eventLast" }),
      ).toMatchObject({ success: true, resolvedMode: "a11y" });
      expect(wholeText.inserted).toEqual([text]);
    }

    const splitText = harness(android);
    expect(
      await splitText.executor.type({ action: "type", text: corpus.combining, mode: "eventLast" }),
    ).toMatchObject({ success: true });
    expect(splitText.inserted).toEqual(["\u0301"]);
    expect(
      splitText.adb.getExecutedCommands().some((command) => command.includes("KEYCODE_E")),
    ).toBe(true);
  });

  test("Android eventOnly rejects all non-ASCII categories before mutation", async () => {
    for (const text of Object.values(corpus)) {
      const h = harness(android);
      expect(await h.executor.type({ action: "type", text, mode: "eventOnly" })).toMatchObject({
        success: false,
        error: expect.stringContaining("cannot type"),
      });
      expect(h.inserted).toEqual([]);
      expect(h.adb.getExecutedCommands()).toEqual([]);
    }
  });
});
