import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  SendKeys,
  segmentGraphemes,
  type SendKeysCommand,
} from "../../../src/features/action/SendKeys";
import {
  android,
  createSendKeysHarness,
  ios,
  observer,
  smallCorpus as corpus,
} from "./SendKeysTestHarness";

function expectWellFormedInserts(inserted: string[]): void {
  for (const text of inserted) {
    expect(text.isWellFormed()).toBe(true);
  }
}

describe("sendKeys unsafe caret across commands", () => {
  function harness(caretPlaced: false | undefined) {
    const h = createSendKeysHarness(android);
    const insert = h.client.insert;
    h.client.insert = async (text, options) => ({
      ...(await insert(text, options)),
      ...(text === "é" ? { caretPlaced } : {}),
    });
    const sendKeys = new SendKeys(android, undefined, {
      executor: h.executor,
      observer,
      timestampProvider: { now: async () => 1 },
      timer: new FakeTimer(),
    });
    return { ...h, sendKeys };
  }
  const unsafe: SendKeysCommand = { action: "type", text: "é", mode: "eventAll" };
  const ascii: SendKeysCommand = { action: "type", text: "abc", mode: "eventAll" };

  test("carries unsafe caret to the next eventAll type command", async () => {
    const h = harness(false);
    expect(await h.sendKeys.execute([unsafe, ascii])).toMatchObject({ success: true });
    expectWellFormedInserts(h.inserted);
    expect(h.deliveries).toEqual([
      { kind: "insert", text: "é" },
      { kind: "insert", text: "abc" },
    ]);
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });

  for (const reset of [
    { action: "clear" },
    { action: "key", key: "arrow_right" },
    { action: "key", key: "next" },
  ] satisfies SendKeysCommand[]) {
    test(`resets unsafe caret on ${reset.action === "key" ? reset.key : reset.action}`, async () => {
      const h = harness(false);
      expect(await h.sendKeys.execute([unsafe, reset, ascii])).toMatchObject({ success: true });
      expect(h.inserted).toEqual(["é"]);
      expectWellFormedInserts(h.inserted);
      expect(h.deliveries.slice(-1)).toEqual([{ kind: "inputText", text: "abc" }]);
    });
  }

  test("resets unsafe caret on replace's clear", async () => {
    const h = harness(false);
    expect(await h.sendKeys.execute([unsafe, { ...ascii, operation: "replace" }])).toMatchObject({
      success: true,
    });
    expect(h.clientCalls).toEqual(["insert:é", "clear"]);
    expectWellFormedInserts(h.inserted);
    expect(h.deliveries.slice(-1)).toEqual([{ kind: "inputText", text: "abc" }]);
  });

  test("resets unsafe caret between sendKeys calls on the same executor", async () => {
    const h = harness(false);
    expect(await h.sendKeys.execute([unsafe])).toMatchObject({ success: true });
    expect(await h.sendKeys.execute([ascii])).toMatchObject({ success: true });
    expect(h.inserted).toEqual(["é"]);
    expectWellFormedInserts(h.inserted);
    expect(h.deliveries.slice(-1)).toEqual([{ kind: "inputText", text: "abc" }]);
  });

  test("old APK with undefined caretPlaced retains subsequent key events", async () => {
    const h = harness(undefined);
    expect(await h.sendKeys.execute([unsafe, ascii])).toMatchObject({ success: true });
    expect(h.inserted).toEqual(["é"]);
    expectWellFormedInserts(h.inserted);
    expect(h.deliveries.slice(-1)).toEqual([{ kind: "inputText", text: "abc" }]);
  });

  for (const mode of ["a11y", "eventLast"] as const) {
    test(`carries unsafe caret from ${mode} inserts into eventAll`, async () => {
      const h = harness(false);
      // eventLast's suffix insert can succeed with an unknown caret after its real tail event.
      const text = mode === "eventLast" ? "xé" : "é";
      expect(await h.sendKeys.execute([{ ...unsafe, text, mode }, ascii])).toMatchObject({
        success: true,
      });
      expect(h.inserted).toEqual(["é", "abc"]);
      expectWellFormedInserts(h.inserted);
      expect(h.deliveries.at(-1)).toEqual({ kind: "insert", text: "abc" });
    });
  }

  for (const mode of ["eventLast", "eventOnly", "imeKeyEvents"] as const) {
    test(`${mode} refuses subsequent text at an unsafe caret without mutation`, async () => {
      const h = harness(false);
      expect(await h.sendKeys.execute([unsafe, { ...ascii, mode }])).toMatchObject({
        success: false,
        completedCommands: 1,
        failedIndex: 1,
        error: expect.stringContaining("caret"),
      });
      expect(h.deliveries).toEqual([{ kind: "insert", text: "é" }]);
      expectWellFormedInserts(h.inserted);
    });
  }
});

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
      expectWellFormedInserts(h.inserted);
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
      expectWellFormedInserts(h.inserted);
      expect(h.deliveries).toEqual([
        { kind: "keyevent", text: "x" },
        { kind: "insert", text: inserted },
        { kind: "keyevent", text: "y" },
      ]);
    }
  });

  for (const [name, cluster] of [
    ["conjoining Hangul jamo", "한"],
    ["surrogate-pair CJK ideograph U+20BB7", "\u{20BB7}"],
  ] as const) {
    test(`Android eventAll inserts ${name} whole alone`, async () => {
      const h = createSendKeysHarness(android);
      expect(
        await h.executor.type({ action: "type", text: cluster, mode: "eventAll" }),
      ).toMatchObject({ success: true });
      expect(h.inserted).toEqual([cluster]);
      expectWellFormedInserts(h.inserted);
      expect(h.deliveries).toEqual([{ kind: "insert", text: cluster }]);
      expect(h.adb.getExecutedCommands()).toEqual([]);
    });

    test(`Android eventAll keeps ${name} whole between ASCII events`, async () => {
      const h = createSendKeysHarness(android);
      expect(
        await h.executor.type({ action: "type", text: `a${cluster}b`, mode: "eventAll" }),
      ).toMatchObject({ success: true });
      expect(h.inserted).toEqual([cluster]);
      expectWellFormedInserts(h.inserted);
      expect(h.deliveries).toEqual([
        { kind: "keyevent", text: "a" },
        { kind: "insert", text: cluster },
        { kind: "keyevent", text: "b" },
      ]);
      expect(h.adb.getExecutedCommands()).toEqual([
        "shell input keyevent KEYCODE_A",
        "shell input keyevent KEYCODE_B",
      ]);
    });
  }

  test("Android eventAll keeps a regional-indicator flag whole between ASCII events", async () => {
    const h = createSendKeysHarness(android);
    const flag = "\u{1F1FA}\u{1F1F8}";
    expect(
      await h.executor.type({ action: "type", text: `a${flag}b`, mode: "eventAll" }),
    ).toMatchObject({ success: true });
    expect(h.inserted).toEqual([flag]);
    expectWellFormedInserts(h.inserted);
    expect(h.deliveries).toEqual([
      { kind: "keyevent", text: "a" },
      { kind: "insert", text: flag },
      { kind: "keyevent", text: "b" },
    ]);
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
    ]);
  });

  test("Android eventAll coalesces two adjacent flags without shifting their pairing", async () => {
    const h = createSendKeysHarness(android);
    const flags = "\u{1F1FA}\u{1F1F8}\u{1F1EF}\u{1F1F5}";
    expect(segmentGraphemes(flags)).toEqual(["\u{1F1FA}\u{1F1F8}", "\u{1F1EF}\u{1F1F5}"]);
    expect(await h.executor.type({ action: "type", text: flags, mode: "eventAll" })).toMatchObject({
      success: true,
    });
    expect(h.inserted).toEqual([flags]);
    expectWellFormedInserts(h.inserted);
    expect(h.deliveries).toEqual([{ kind: "insert", text: flags }]);
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });

  test("Android eventAll coalesces 2,000 non-ASCII clusters into runs between ASCII key events", async () => {
    const h = createSendKeysHarness(android);
    const run = "👨‍👩‍👧👍🏽1️⃣🇺🇸e\u0301".repeat(100);
    const separators = ["a", "b", "c", "d"];
    const text = separators.map((separator) => separator + run).join("");
    expect(segmentGraphemes(text)).toHaveLength(2004);
    expect(await h.executor.type({ action: "type", text, mode: "eventAll" })).toMatchObject({
      success: true,
    });
    // ASCII key-event characters split the input into runs; eventAllInsertRunEnd
    // coalesces each run of non-key-event clusters into one insert.
    expect(h.inserted).toHaveLength(4);
    expect(h.inserted).toEqual(separators.map(() => run));
    expectWellFormedInserts(h.inserted);
    expect(h.adb.getExecutedCommands()).toHaveLength(4);
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
      "shell input keyevent KEYCODE_C",
      "shell input keyevent KEYCODE_D",
    ]);
    expect(h.deliveries.filter((delivery) => delivery.kind === "keyevent")).toHaveLength(4);
    expect(h.deliveries).toEqual(
      separators.flatMap((separator) => [
        { kind: "keyevent", text: separator },
        { kind: "insert", text: run },
      ]),
    );
    expect(h.deliveries.map((delivery) => delivery.text).join("")).toBe(text);
  });

  test("Android eventAll inserts non-ASCII clusters together via the all-a11y fast path", async () => {
    const h = createSendKeysHarness(android);
    const text = "👨‍👩‍👧👍🏽1️⃣🇺🇸e\u0301".repeat(4);
    expect(segmentGraphemes(text)).toHaveLength(20);
    // No cluster has a key-event plan, so the all-a11y fast path calls insertGraphemeRun.
    expect(await h.executor.type({ action: "type", text, mode: "eventAll" })).toMatchObject({
      success: true,
      resolvedMode: "a11y",
    });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted).toEqual([text]);
    expectWellFormedInserts(h.inserted);
    expect(h.deliveries.map((delivery) => delivery.text).join("")).toBe(text);
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });

  test("Android eventAll preserves ASCII-only device commands", async () => {
    const h = createSendKeysHarness(android);
    expect(
      await h.executor.type({ action: "type", text: "Hello, World 42!", mode: "eventAll" }),
    ).toMatchObject({ success: true });
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell getprop ro.build.version.sdk",
      "shell input text 'ello,%s'",
      "shell input text 'orld%s42'",
    ]);
    expect(h.inserted).toEqual(["H", "W", "!"]);
    expectWellFormedInserts(h.inserted);
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
    expectWellFormedInserts(h.inserted);
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
    expectWellFormedInserts(h.inserted);
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
    expectWellFormedInserts(h.inserted);
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
    expectWellFormedInserts(h.inserted);
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

describe("Android eventAll caret and preceding input", () => {
  test("eventAll treats a caret-not-placed warning as success and inserts the rest whole", async () => {
    const h = createSendKeysHarness(android);
    const insert = h.client.insert;
    let calls = 0;
    h.client.insert = async (text, options) => {
      await insert(text, options);
      return ++calls === 1
        ? {
            success: true,
            warning: "caret could not be placed",
            caretPlaced: false,
            resultingTextLength: 5,
          }
        : {
            success: true,
            warning: "remainder warning",
            caretPlaced: false,
            resultingTextLength: 8,
          };
    };
    const result = await h.executor.type({ action: "type", text: "a👍🏽b c", mode: "eventAll" });
    expect(result).toMatchObject({
      success: true,
      warning: "caret could not be placed remainder warning",
    });
    expect(result.partialApplication).toBeUndefined();
    expect(h.deliveries).toEqual([
      { kind: "keyevent", text: "a" },
      { kind: "insert", text: "👍🏽" },
      { kind: "insert", text: "b c" },
    ]);
    expect(h.adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
    expectWellFormedInserts(h.inserted);
  });

  test("eventAll sends remaining text by key events when the caret was placed", async () => {
    const h = createSendKeysHarness(android);
    expect(
      await h.executor.type({ action: "type", text: "a👍🏽b c", mode: "eventAll" }),
    ).toMatchObject({ success: true });
    expect(h.inserted).toEqual(["👍🏽"]);
    expectWellFormedInserts(h.inserted);
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input text 'b%sc'",
    ]);
  });

  test("eventAll sends expectedSuffix after key-event characters and resets it after insertion", async () => {
    for (const [text, expected] of [
      ["x👍🏽y", [{ expectedSuffix: "x" }]],
      ["👍🏽", [undefined]],
      ["ab👍🏽c😀", [{ expectedSuffix: "ab" }, { expectedSuffix: "c" }]],
    ] as const) {
      const h = createSendKeysHarness(android);
      const optionsSeen: Array<{ expectedSuffix?: string } | undefined> = [];
      const insert = h.client.insert;
      h.client.insert = async (value, options) => {
        optionsSeen.push(options);
        return insert(value, options);
      };
      expect(await h.executor.type({ action: "type", text, mode: "eventAll" })).toMatchObject({
        success: true,
      });
      expect(optionsSeen).toEqual([...expected]);
      expectWellFormedInserts(h.inserted);
    }
  });

  test("caret remainder and later commands stay on insertion without an expectedSuffix", async () => {
    const h = createSendKeysHarness(android);
    const seen: Array<{ expectedSuffix?: string } | undefined> = [];
    const insert = h.client.insert;
    h.client.insert = async (text, options) => {
      seen.push(options);
      await insert(text, options);
      return { success: true, caretPlaced: false };
    };
    await h.executor.type({ action: "type", text: "a👍🏽b", mode: "eventAll" });
    expect(seen).toEqual([{ expectedSuffix: "a" }, undefined]);
    await h.executor.type({ action: "type", text: "c", mode: "eventAll" });
    expect(seen).toEqual([{ expectedSuffix: "a" }, undefined, undefined]);
    expect(h.inserted).toEqual(["👍🏽", "b", "c"]);
    expectWellFormedInserts(h.inserted);
    expect(h.adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
  });

  test("eventAll reports a length mismatch as a lengths-only warning", async () => {
    const h = createSendKeysHarness(android);
    h.client.insert = async () => ({ success: true, resultingTextLength: 2 });
    const result = await h.executor.type({
      action: "type",
      operation: "replace",
      text: "ab👍🏽",
      mode: "eventAll",
    });
    expect(result.success).toBe(true);
    expect(result.warning).toContain("2 UTF-16 units in the field, expected 6");
    expect(typeof result.warning).toBe("string");
    expect(result.warning?.includes("👍🏽")).toBe(false);
    expect(result.warning?.includes("ab")).toBe(false);
  });

  test("length comparison uses the final whole remainder insert", async () => {
    const h = createSendKeysHarness(android);
    let calls = 0;
    h.client.insert = async () =>
      ++calls === 1
        ? { success: true, caretPlaced: false, resultingTextLength: 5 }
        : { success: true, resultingTextLength: 6 };
    const result = await h.executor.type({
      action: "type",
      operation: "replace",
      text: "a👍🏽b",
      mode: "eventAll",
    });
    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  for (const scenario of ["equal", "old APK", "insert", "later key event"] as const) {
    test(`eventAll skips length mismatch warning for ${scenario}`, async () => {
      const h = createSendKeysHarness(android);
      h.client.insert = async () => ({
        success: true,
        ...(scenario === "old APK" ? {} : { resultingTextLength: scenario === "equal" ? 6 : 2 }),
      });
      const result = await h.executor.type({
        action: "type",
        mode: "eventAll",
        operation: scenario === "insert" ? "insert" : "replace",
        text: scenario === "later key event" ? "ab👍🏽c" : "ab👍🏽",
      });
      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  }
});

// This fake models the service contract, including lagging accessibility snapshots. It cannot
// establish how Compose/EditText or an actual ACTION_SET_SELECTION behaves on a device.
function createSimulatedField(initial: string, caret = initial.length, placementSucceeds = false) {
  const h = createSendKeysHarness(android);
  const timer = new FakeTimer();
  const field = { text: initial, caret, reported: caret };
  let cached = { text: initial, reported: caret };
  let remembered: { text: string; caret: number; reported: number } | undefined;
  let refreshCount = 0;
  let staleFollowUps = 0;
  let neverReflect = false;
  const baseExecute = h.adb.executeCommand.bind(h.adb);
  h.adb.executeCommand = async (...args) => {
    const result = await baseExecute(...args);
    const key = args[0].match(/^shell input keyevent KEYCODE_([A-Z]|SPACE)$/)?.[1];
    if (key && !result.stderr) {
      const value = key === "SPACE" ? " " : key.toLowerCase();
      field.text = field.text.slice(0, field.caret) + value + field.text.slice(field.caret);
      field.caret += value.length;
      field.reported = field.caret;
      remembered = undefined; // A key event invalidates service continuation state.
      // The accessibility node still exposes the value from before this key event.
    }
    return result;
  };
  h.client.clear = async () => {
    field.text = "";
    field.caret = field.reported = 0;
    cached = { text: "", reported: 0 };
    remembered = undefined;
    return { success: true };
  };
  h.client.replace = async (text) => {
    field.text = text;
    field.caret = field.reported = text.length;
    cached = { text, reported: text.length };
    remembered = undefined;
    return { success: true };
  };
  h.client.insert = async (text, options) => {
    const warnings: string[] = [];
    let polls = 0;
    const refresh = () => {
      refreshCount++;
      // The first refreshed snapshot is also stale. Only subsequent refreshes see the write.
      if (++polls > 1 && !neverReflect) {
        cached = { text: field.text, reported: field.reported };
      }
    };
    const waitFor = (matches: () => boolean) => {
      const deadline = timer.now() + 300;
      while (!matches() && timer.now() < deadline) {
        timer.advanceTime(25);
        refresh();
      }
      return matches();
    };
    refresh(); // Unconditional before the first plan, even without expectedSuffix.
    if (remembered && cached.text !== remembered.text) {
      staleFollowUps++;
      if (!waitFor(() => cached.text === remembered?.text)) {
        warnings.push(
          "The field changed since the previous insert; text did not match within 300ms",
        );
        remembered = undefined;
      }
    }
    if (options?.expectedSuffix) {
      const suffix = options.expectedSuffix;
      if (!waitFor(() => cached.text.slice(0, cached.reported).endsWith(suffix))) {
        warnings.push(
          "Preceding key-event input was not observed within 300ms; earlier input may have been overwritten",
        );
      }
    }
    const insertion =
      remembered?.text === cached.text && remembered.reported === cached.reported
        ? remembered.caret
        : cached.reported;
    const before = { ...cached };
    field.text = cached.text.slice(0, insertion) + text + cached.text.slice(insertion);
    const plannedCaret = insertion + text.length;
    if (placementSucceeds) {
      field.caret = field.reported = plannedCaret;
      remembered = undefined;
      cached = { text: field.text, reported: field.reported };
    } else {
      field.caret = 0; // Any subsequent key event would land at an unknown/wrong position.
      warnings.push("Text was inserted, but the caret could not be placed");
      remembered = { text: field.text, caret: plannedCaret, reported: field.reported };
      cached = before; // Follow-up insert receives a pre-SET_TEXT node until refresh/polling.
    }
    return {
      success: true,
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
      ...(placementSucceeds ? {} : { caretPlaced: false }),
      resultingTextLength: field.text.length,
    };
  };
  return {
    ...h,
    field,
    timer,
    getRefreshCount: () => refreshCount,
    getStaleFollowUps: () => staleFollowUps,
    stopReflecting: () => {
      neverReflect = true;
    },
  };
}

describe("issue 8619 real executor with a simulated field and stale accessibility nodes", () => {
  const rows = [
    { row: 1, initial: "", text: "👍🏽", expected: "👍🏽", mode: "eventAll" },
    { row: 2, initial: "", text: "é", expected: "é", mode: "a11y" },
    { row: 3, initial: "", text: "a👨‍👩‍👧🇯🇵👍🏽é z", expected: "a👨‍👩‍👧🇯🇵👍🏽é z", mode: "eventAll" },
    { row: 4, initial: "é", text: "x👍🏽y", expected: "éx👍🏽y", mode: "eventAll" },
    { row: 5, initial: "hello", caret: 3, text: "🇯🇵", expected: "hel🇯🇵lo", mode: "eventAll" },
    { row: 6, initial: "", text: "a👍🏽é", expected: "a👍🏽é", mode: "eventAll" },
  ] as const;
  for (const row of rows) {
    test(`row ${row.row} preserves the complete field with failed selection placement`, async () => {
      const h = createSimulatedField(row.initial, "caret" in row ? row.caret : row.initial.length);
      const result = await h.executor.type({ action: "type", text: row.text, mode: row.mode });
      expect(result.success).toBe(true);
      expect(result.warning).toContain("caret could not be placed");
      expect(h.field.text).toBe(row.expected);
      expect(h.getRefreshCount()).toBeGreaterThan(0);
      if (row.row === 3 || row.row === 4) {
        expect(h.getStaleFollowUps()).toBe(1);
      }
    });
  }
  test("native EditText can also place its caret successfully", async () => {
    const h = createSimulatedField("", 0, true);
    expect(await h.executor.type({ action: "type", text: "a👍🏽é", mode: "eventAll" })).toMatchObject(
      { success: true },
    );
    expect(h.field.text).toBe("a👍🏽é");
  });
  test("a preceding key event that never appears fails loudly with a warning", async () => {
    const h = createSimulatedField("é");
    h.stopReflecting();
    const result = await h.executor.type({ action: "type", text: "x👍🏽y", mode: "eventAll" });
    expect(h.field.text).not.toBe("éx👍🏽y");
    expect(result.warning).toContain("Preceding key-event input was not observed");
    expect(result.warning).toContain("field changed since the previous insert");
    expect(h.timer.now()).toBe(600);
  });
  test("reported caret move overrides remembered offset on a later command", async () => {
    const h = createSimulatedField("hello", 3);
    await h.executor.type({ action: "type", text: "🇯🇵", mode: "a11y" });
    h.field.caret = h.field.reported = h.field.text.length;
    await h.executor.type({ action: "type", text: "é", mode: "a11y" });
    expect(h.field.text).toBe("hel🇯🇵loé");
  });
});

describe("mixed typing mode warnings and failures", () => {
  test("eventLast fails before its promised real tail event if prefix caret is unknown", async () => {
    const h = createSendKeysHarness(android);
    h.client.insert = async () => ({
      success: true,
      caretPlaced: false,
      warning: "prefix warning",
    });
    expect(
      await h.executor.type({ action: "type", text: "👍🏽xé", mode: "eventLast" }),
    ).toMatchObject({
      success: false,
      partialApplication: true,
      warning: "prefix warning",
      error: expect.stringContaining("eventLast requires a real tail key event"),
    });
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });
  test("eventLast passes key expectation to suffix and accumulates both warnings", async () => {
    const h = createSendKeysHarness(android);
    const optionsSeen: Array<{ expectedSuffix?: string }> = [];
    let calls = 0;
    h.client.insert = async (_text, options) => {
      if (options) {
        optionsSeen.push(options);
      }
      return { success: true, warning: ++calls === 1 ? "prefix warning" : "suffix warning" };
    };
    expect(
      await h.executor.type({ action: "type", text: "👍🏽xé", mode: "eventLast" }),
    ).toMatchObject({
      success: true,
      warning: "prefix warning suffix warning",
    });
    expect(optionsSeen).toEqual([{ expectedSuffix: "x" }]);
  });
  for (const throws of [false, true]) {
    test(`eventAll preserves earlier warnings when remainder ${throws ? "throws" : "fails"}`, async () => {
      const h = createSendKeysHarness(android);
      let calls = 0;
      h.client.insert = async () => {
        if (++calls === 1) {
          return { success: true, caretPlaced: false, warning: "first warning" };
        }
        if (throws) {
          throw new Error("remainder failed");
        }
        return { success: false, warning: "failure warning", error: "remainder failed" };
      };
      expect(
        await h.executor.type({ action: "type", text: "a👍🏽b", mode: "eventAll" }),
      ).toMatchObject({
        success: false,
        partialApplication: true,
        warning: expect.stringContaining("first warning"),
        error: expect.stringContaining("remainder failed"),
      });
    });
    test(`eventLast preserves prefix warning when suffix ${throws ? "throws" : "fails"}`, async () => {
      const h = createSendKeysHarness(android);
      let calls = 0;
      h.client.insert = async () => {
        if (++calls === 1) {
          return { success: true, warning: "prefix warning" };
        }
        if (throws) {
          throw new Error("suffix failed");
        }
        return { success: false, warning: "failure warning", error: "suffix failed" };
      };
      expect(
        await h.executor.type({ action: "type", text: "👍🏽xé", mode: "eventLast" }),
      ).toMatchObject({
        success: false,
        partialApplication: true,
        warning: expect.stringContaining("prefix warning"),
      });
    });
  }
  test("eventAll preserves insertion warnings after a later key event fails", async () => {
    const h = createSendKeysHarness(android);
    h.client.insert = async () => ({ success: true, warning: "insert warning" });
    h.adb.setCommandError("shell input keyevent KEYCODE_X", new Error("key failed"));
    expect(await h.executor.type({ action: "type", text: "👍🏽x", mode: "eventAll" })).toMatchObject({
      success: false,
      warning: "insert warning",
      partialApplication: true,
    });
  });
});

test("auto falling back to eventAll keeps the remainder on insert after a caret warning", async () => {
  const h = createSimulatedField("é");
  h.client.supportsImeCommit = async () => false;
  expect(await h.executor.type({ action: "type", text: "x👍🏽y", mode: "auto" })).toMatchObject({
    success: true,
    resolvedMode: "eventAll",
    warning: expect.stringContaining("caret could not be placed"),
  });
  expect(h.field.text).toBe("éx👍🏽y");
  expect(h.adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_X"]);
});

test("eventLast retains prefix warning when its real tail key event fails", async () => {
  const h = createSendKeysHarness(android);
  h.client.insert = async () => ({ success: true, warning: "prefix warning" });
  h.adb.setCommandError("shell input keyevent KEYCODE_X", new Error("tail failed"));
  expect(await h.executor.type({ action: "type", text: "👍🏽xé", mode: "eventLast" })).toMatchObject({
    success: false,
    partialApplication: true,
    warning: "prefix warning",
    error: "tail failed",
  });
});

describe("pre-dispatch insert baselines", () => {
  test("eventAll captures each run before dispatch and uses the post-insert state", async () => {
    const h = createSendKeysHarness(android);
    let state = { text: "éx", isShowingHintText: false, selectionStart: 2, selectionEnd: 2 };
    const baselines: (typeof state)[] = [];
    h.client.readInsertTextState = async () => {
      baselines.push({ ...state });
      expect(h.adb.getExecutedCommands().filter((c) => c.includes("input keyevent")).length).toBe(
        baselines.length - 1,
      );
      return { ...state };
    };
    h.client.insert = async (text, options) => {
      expect(options?.precedingState).toEqual(baselines[baselines.length - 1]);
      expect(options?.expectedSuffix).toBe("x");
      state = {
        ...state,
        text: state.text + "x" + text,
        selectionStart: state.selectionStart + 1 + text.length,
        selectionEnd: state.selectionEnd + 1 + text.length,
      };
      return { success: true };
    };
    expect(
      await h.executor.type({ action: "type", text: "x😀x😀", mode: "eventAll" }),
    ).toMatchObject({ success: true });
    expect(baselines.map((b) => b.text)).toEqual(["éx", "éxx😀"]);
  });

  test("eventLast captures after the prefix and before its key event", async () => {
    const h = createSendKeysHarness(android);
    const state = { text: "éx", isShowingHintText: false, selectionStart: 2, selectionEnd: 2 };
    h.client.readInsertTextState = async () => {
      expect(h.adb.getExecutedCommands()).toEqual([]);
      return state;
    };
    h.client.insert = async (_text, options) => {
      expect(options).toEqual({ expectedSuffix: "x", precedingState: state });
      expect(h.adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_X"]);
      return { success: true };
    };
    expect(await h.executor.type({ action: "type", text: "x😀", mode: "eventLast" })).toMatchObject(
      { success: true },
    );
  });

  test("unused baselines are neither captured nor forwarded", async () => {
    for (const [text, mode] of [
      ["xx", "eventAll"],
      ["😀", "eventAll"],
      ["x", "eventLast"],
    ] as const) {
      const h = createSendKeysHarness(android);
      h.client.readInsertTextState = async () => {
        throw new Error("unnecessary baseline capture");
      };
      h.client.insert = async (_text, options) => {
        expect(options?.precedingState).toBeUndefined();
        return { success: true };
      };
      expect(await h.executor.type({ action: "type", text, mode })).toMatchObject({
        success: true,
      });
    }
  });

  test("unavailable baseline omits the field and preserves legacy options", async () => {
    const h = createSendKeysHarness(android);
    h.client.readInsertTextState = async () => undefined;
    h.client.insert = async (_text, options) => {
      expect(options).toEqual({ expectedSuffix: "x" });
      return { success: true };
    };
    expect(await h.executor.type({ action: "type", text: "x😀", mode: "eventAll" })).toMatchObject({
      success: true,
    });
  });
});
