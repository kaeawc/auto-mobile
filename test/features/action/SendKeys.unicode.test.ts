import { describe, expect, test } from "bun:test";
import { segmentGraphemes } from "../../../src/features/action/SendKeys";
import { android, createSendKeysHarness, ios, smallCorpus as corpus } from "./SendKeysTestHarness";

describe("sendKeys Unicode delivery", () => {
  test("segments multi-code-point graphemes as complete units", () => {
    expect(segmentGraphemes("xe\u0301y1️⃣👨‍👩‍👧🇺🇸👍🏽😀")).toEqual([
      "x",
      "e\u0301",
      "y",
      "1️⃣",
      "👨‍👩‍👧",
      "🇺🇸",
      "👍🏽",
      "😀",
    ]);
  });
  test("iOS xcuiTypeText forwards each character category as one intact string", async () => {
    for (const text of Object.values(corpus)) {
      const h = createSendKeysHarness(ios);
      expect(await h.executor.type({ action: "type", text, mode: "a11y" })).toMatchObject({
        success: true,
        resolvedMode: "xcuiTypeText",
      });
      expect(h.inserted).toEqual([text]);
    }
  });

  test("Android a11y forwards each character category as one intact string", async () => {
    for (const text of Object.values(corpus)) {
      const h = createSendKeysHarness(android);
      expect(await h.executor.type({ action: "type", text, mode: "a11y" })).toMatchObject({
        success: true,
      });
      expect(h.inserted).toEqual([text]);
    }
  });

  test("Android ime commits each character category verbatim", async () => {
    for (const text of Object.values(corpus)) {
      const h = createSendKeysHarness(android);
      expect(await h.executor.type({ action: "type", text, mode: "ime" })).toMatchObject({
        success: true,
      });
      expect(h.committed).toEqual([text]);
    }
  });

  test("Android eventAll inserts complete non-ASCII graphemes", async () => {
    const cases = [
      [corpus.nonAscii, ["é"]],
      [corpus.emoji, ["😀👨‍👩‍👧"]],
      [corpus.combining, ["e\u0301"]],
      [corpus.cjk, ["日本語"]],
      ["1️⃣", ["1️⃣"]],
      ["👨‍👩‍👧", ["👨‍👩‍👧"]],
      ["🇺🇸", ["🇺🇸"]],
      ["👍🏽", ["👍🏽"]],
      ["😀", ["😀"]],
    ] as const;
    for (const [text, inserts] of cases) {
      const h = createSendKeysHarness(android);
      expect(await h.executor.type({ action: "type", text, mode: "eventAll" })).toMatchObject({
        success: true,
      });
      expect(h.inserted).toEqual(inserts);
      expect(h.adb.getExecutedCommands()).toEqual([]);
    }
  });

  test("Android eventAll keeps a family emoji and combining mark whole between ASCII events", async () => {
    for (const [text, inserted] of [
      ["x👨‍👩‍👧y", "👨‍👩‍👧"],
      ["xe\u0301y", "e\u0301"],
    ] as const) {
      const h = createSendKeysHarness(android);
      expect(await h.executor.type({ action: "type", text, mode: "eventAll" })).toMatchObject({
        success: true,
      });
      expect(h.adb.getExecutedCommands()).toEqual([
        "shell input keyevent KEYCODE_X",
        "shell input keyevent KEYCODE_Y",
      ]);
      expect(h.inserted).toEqual([inserted]);
      expect(h.deliveries).toEqual([
        { kind: "keyevent", text: "x" },
        { kind: "insert", text: inserted },
        { kind: "keyevent", text: "y" },
      ]);
    }
  });

  test("Android eventAll preserves ASCII-only device commands", async () => {
    const h = createSendKeysHarness(android);
    expect(
      await h.executor.type({ action: "type", text: "Hello, World 42!", mode: "eventAll" }),
    ).toMatchObject({ success: true });
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell getprop ro.build.version.sdk",
      "shell input keyevent KEYCODE_E",
      "shell input keyevent KEYCODE_L",
      "shell input keyevent KEYCODE_L",
      "shell input keyevent KEYCODE_O",
      "shell input keyevent KEYCODE_COMMA",
      "shell input keyevent KEYCODE_SPACE",
      "shell input keyevent KEYCODE_O",
      "shell input keyevent KEYCODE_R",
      "shell input keyevent KEYCODE_L",
      "shell input keyevent KEYCODE_D",
      "shell input keyevent KEYCODE_SPACE",
      "shell input keyevent KEYCODE_4",
      "shell input keyevent KEYCODE_2",
    ]);
    expect(h.inserted).toEqual(["H", "W", "!"]);
  });

  test("Android eventAll failure reports the whole failed cluster and committed boundary", async () => {
    const h = createSendKeysHarness(android);
    let insertCalls = 0;
    const insert = h.client.insert;
    h.client.insert = async (text) => {
      insertCalls++;
      return insertCalls === 2 ? { success: false, error: "insert rejected" } : insert(text);
    };
    const result = await h.executor.type({ action: "type", text: "a😀b🇺🇸c", mode: "eventAll" });
    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      committedGraphemes: 3,
      error: expect.stringContaining("U+1F1FA U+1F1F8"),
    });
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
    ]);
    expect(h.inserted).toEqual(["😀"]);
    expect(h.deliveries).toEqual([
      { kind: "keyevent", text: "a" },
      { kind: "insert", text: "😀" },
      { kind: "keyevent", text: "b" },
    ]);
  });

  test("Android eventAll does not count any cluster in a failed multi-cluster insert", async () => {
    const h = createSendKeysHarness(android);
    h.client.insert = async () => ({ success: false, error: "insert rejected" });
    const result = await h.executor.type({ action: "type", text: "a😀🇺🇸b", mode: "eventAll" });
    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      committedGraphemes: 1,
      error: expect.stringContaining("U+1F600, U+1F1FA U+1F1F8"),
    });
    expect(h.adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
    expect(h.inserted).toEqual([]);
  });

  test("Android auto fallback inserts complete ASCII-base graphemes", async () => {
    const h = createSendKeysHarness(android);
    h.client.supportsImeCommit = async () => false;
    expect(await h.executor.type({ action: "type", text: "xe\u0301y" })).toMatchObject({
      success: true,
      resolvedMode: "eventAll",
    });
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_X",
      "shell input keyevent KEYCODE_Y",
    ]);
    expect(h.inserted).toEqual(["e\u0301"]);
  });

  test("Android eventAll sends exact keyevent arguments and never shell-encodes Unicode", async () => {
    const h = createSendKeysHarness(android);
    const text = "a😀b日本";
    expect(await h.executor.type({ action: "type", text, mode: "eventAll" })).toMatchObject({
      success: true,
    });
    const commands = h.adb.getExecutedCommands();
    expect(commands.filter((command) => command.startsWith("shell input keyevent "))).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
    ]);
    expect(h.inserted).toEqual(["😀", "日本"]);
    expect(commands.some((command) => command.startsWith("shell input text "))).toBe(false);
  });

  test("Android eventLast can split an ASCII base from its combining mark", async () => {
    for (const text of [corpus.nonAscii, corpus.emoji, corpus.cjk]) {
      const wholeText = createSendKeysHarness(android);
      expect(
        await wholeText.executor.type({ action: "type", text, mode: "eventLast" }),
      ).toMatchObject({ success: true, resolvedMode: "a11y" });
      expect(wholeText.inserted).toEqual([text]);
    }

    const splitText = createSendKeysHarness(android);
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
      const h = createSendKeysHarness(android);
      expect(await h.executor.type({ action: "type", text, mode: "eventOnly" })).toMatchObject({
        success: false,
        error: expect.stringContaining("cannot type"),
      });
      expect(h.inserted).toEqual([]);
      expect(h.adb.getExecutedCommands()).toEqual([]);
    }
  });
});
