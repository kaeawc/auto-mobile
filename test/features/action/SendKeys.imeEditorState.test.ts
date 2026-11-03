import { expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models";
import { SendKeys, type SendKeysObserver } from "../../../src/features/action/SendKeys";
import { sendKeysResultSchema } from "../../../src/server/toolOutputSchemas/actions";
import {
  imeEditorWarnings,
  readImeEditorState,
  withImeEditorWarnings,
} from "../../../src/features/action/sendkeys/ImeEditorState";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness, focused } from "./SendKeysTestHarness";

function frame(focus: string | false = "composer", keyboard = true): ObserveResult {
  return {
    ...focused,
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            class: "android.widget.EditText",
            focused: focus === false ? "false" : "true",
            "resource-id": focus || "composer",
            text: "日本語😀",
          },
        },
      },
      windows: [{ id: 1, type: keyboard ? 2 : 1 }],
    },
  };
}

test("IME editor warning decision distinguishes lost, moved and retained focus", () => {
  const before = readImeEditorState(frame());
  expect(imeEditorWarnings(before, frame(false))).toEqual([
    expect.stringContaining("focused editor lost focus"),
  ]);
  expect(imeEditorWarnings(before, frame("other"))).toEqual([
    expect.stringContaining("focused editor changed"),
  ]);
  expect(imeEditorWarnings(before, frame())).toEqual([]);
});

test("IME editor warning requires known keyboard visibility and readable focus", () => {
  expect(imeEditorWarnings(readImeEditorState(frame()), frame("composer", false))).toEqual([
    expect.stringContaining("keyboard became hidden"),
  ]);
  const unavailable = { ...focused, viewHierarchy: undefined };
  expect(imeEditorWarnings(readImeEditorState(frame()), unavailable)).toEqual([]);
  expect(imeEditorWarnings(readImeEditorState(unavailable), frame(false, false))).toEqual([]);
  expect(
    imeEditorWarnings(readImeEditorState(frame()), {
      ...frame(false, false),
      viewHierarchy: { ...frame(false, false).viewHierarchy!, ctrlProxyIncomplete: true },
    }),
  ).toEqual([]);
  expect(
    imeEditorWarnings(readImeEditorState(frame()), {
      ...frame(),
      viewHierarchy: { ...frame().viewHierarchy!, windows: [{ id: 1 }] },
    }),
  ).toEqual([]);
  expect(imeEditorWarnings(readImeEditorState(frame(false, false)), frame(false, false))).toEqual(
    [],
  );
});

test("IME warnings are additive to existing result fields and optional in the output schema", () => {
  const result = {
    success: true,
    completedCommands: 1,
    commands: [{ index: 0, action: "type", success: true, backend: "autoMobileIme" }],
    warning: "existing verification guidance",
    observation: frame(false),
  } satisfies import("../../../src/features/action/SendKeys").SendKeysResult;
  const warned = withImeEditorWarnings(result, readImeEditorState(frame()));
  expect(warned).toMatchObject(result);
  expect(warned.warnings).toHaveLength(1);
  expect(sendKeysResultSchema.parse(warned).warnings).toEqual(warned.warnings);
  expect(sendKeysResultSchema.parse({ commands: [] })).not.toHaveProperty("warnings");
});

let serial = 0;
function harness(after: ObserveResult, baselineUnavailable = false) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let committed = false;
  const reads: Parameters<SendKeysObserver["execute"]>[0][] = [];
  const observer: SendKeysObserver = {
    execute: async (options) => {
      reads.push(options);
      if (baselineUnavailable && reads.length === 1) {
        throw new Error("diagnostic hierarchy unavailable");
      }
      return committed && !options?.hierarchyOnly ? after : frame();
    },
  };
  const device = { ...android, deviceId: `ime-editor-16428-${++serial}` };
  const h = createSendKeysHarness(device, observer, timer);
  const commit = h.client.commitViaIme;
  h.client.commitViaIme = async (...args) => {
    const result = await commit(...args);
    committed = true;
    return result;
  };
  const action = new SendKeys(device, h.adbFactory, {
    executor: h.executor,
    observer,
    timer,
    timestampProvider: { now: async () => 1 },
  });
  return { ...h, action, timer, reads };
}

test("sendKeys warns when IME typing loses focus without changing delivery", async () => {
  const h = harness(frame(false));
  const result = await h.action.execute([{ action: "type", text: "日本語😀", mode: "ime" }]);
  expect(result).toMatchObject({ success: true, completedCommands: 1 });
  expect(result.warnings).toEqual([expect.stringContaining("focused editor lost focus")]);
  expect(result.warnings?.[0]).toContain("visible key taps");
  expect(h.committed).toEqual(["日本語😀"]);
  expect(h.inserted).toEqual([]);
  expect(h.timer.getSleepHistory()).toEqual([]);
  expect(
    h.adb.getExecutedCommands().filter((command) => command.startsWith("shell ime set ")),
  ).toHaveLength(1);
});

test("sendKeys omits warnings when the editor keeps focus and keyboard visibility", async () => {
  const h = harness(frame());
  const result = await h.action.execute([{ action: "type", text: "日本語😀", mode: "ime" }]);
  expect(result.success).toBe(true);
  expect(result).not.toHaveProperty("warnings");
});

test("sendKeys reports a visible-to-hidden keyboard even when focus remains", async () => {
  const h = harness(frame("composer", false));
  const result = await h.action.execute([{ action: "type", text: "日本語😀", mode: "ime" }]);
  expect(result.warnings).toEqual([expect.stringContaining("keyboard became hidden")]);
});

test("auto IME typing reuses the password-routing observation for its baseline", async () => {
  const h = harness(frame(false));
  const result = await h.action.execute([{ action: "type", text: "日本語😀" }]);
  expect(result.warnings).toEqual([expect.stringContaining("focused editor lost focus")]);
  // Existing password pre-check, commit verification, and terminal read only.
  expect(h.reads).toHaveLength(3);
});

test("explicit IME commands share one baseline and retain the single activation span", async () => {
  const h = harness(frame());
  await h.action.execute([
    { action: "type", text: "日本語😀", mode: "ime" },
    { action: "type", text: "日本語😀", mode: "ime" },
  ]);
  expect(h.reads).toHaveLength(4);
  expect(h.reads[0]).toMatchObject({ hierarchyOnly: true, skipScreenshot: true });
  expect(h.timer.getSleepHistory()).toEqual([]);
  expect(
    h.adb.getExecutedCommands().filter((command) => command.startsWith("shell ime set ")),
  ).toHaveLength(1);
});

test("an explicit key that can dismiss or move focus does not blame IME typing", async () => {
  const h = harness(frame(false, false));
  const result = await h.action.execute([
    { action: "type", text: "日本語😀", mode: "ime" },
    { action: "key", key: "enter" },
  ]);
  expect(result).not.toHaveProperty("warnings");
});

test("an unavailable diagnostic baseline does not prevent an IME commit", async () => {
  const h = harness(frame(), true);
  const result = await h.action.execute([{ action: "type", text: "日本語😀", mode: "ime" }]);
  expect(result.success).toBe(true);
  expect(result).not.toHaveProperty("warnings");
  expect(h.committed).toEqual(["日本語😀"]);
  expect(h.timer.getSleepHistory()).toEqual([]);
});
