import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
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
  });

  test("eventAll sends remaining text by key events when the caret was placed", async () => {
    const h = createSendKeysHarness(android);
    expect(
      await h.executor.type({ action: "type", text: "a👍🏽b c", mode: "eventAll" }),
    ).toMatchObject({ success: true });
    expect(h.inserted).toEqual(["👍🏽"]);
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
      "shell input keyevent KEYCODE_SPACE",
      "shell input keyevent KEYCODE_C",
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
    }
  });

  test("caret remainder has no expectedSuffix and a later command resumes ordinary routing", async () => {
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
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_C",
    ]);
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
