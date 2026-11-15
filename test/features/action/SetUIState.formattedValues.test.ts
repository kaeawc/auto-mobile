import { beforeEach, describe, expect, test } from "bun:test";
import { SetUIState } from "../../../src/features/action/SetUIState";
import { FieldTypeDetector } from "../../../src/features/action/FieldTypeDetector";
import type { BootedDevice, Element, ObserveResult } from "../../../src/models";
import { buildObserveResult } from "../../helpers/observeFixture";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreenForSetUIState } from "../../fakes/FakeSetUIStateDependencies";

// #18350: app-reformatted values, a checkable time-picker text chip, and
// deterministic errors that must not be retried.
describe("SetUIState formatted values and checkable text chips (#18350)", () => {
  const device: BootedDevice = { name: "emulator", platform: "android", deviceId: "emulator-5554" };
  let fakeObserve: FakeObserveScreenForSetUIState;
  let fakeTimer: FakeTimer;
  let node: Element;
  let calls: string[];

  const observe = (): ObserveResult =>
    buildObserveResult({
      updatedAt: 1,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: { hierarchy: { node: { node: [{ $: { ...node } }] } } },
    });

  /** Simulates the app: `format` rewrites typed text; `onFocus` swaps the node. */
  const createSetUIState = ({
    format = (text: string) => text,
    onFocus,
  }: { format?: (text: string) => string; onFocus?: () => void } = {}) =>
    new SetUIState(device, null, {
      observeScreen: fakeObserve,
      fieldTypeDetector: new FieldTypeDetector(),
      timer: fakeTimer,
      tapOnElement: {
        execute: async (options) => {
          calls.push(`${options.action}:${options.elementId ?? options.text}`);
          if (options.action === "focus") {
            onFocus?.();
          }
          return { success: true, action: options.action, focusVerified: true };
        },
      },
      clearText: {
        execute: async () => {
          calls.push("clear");
          node = { ...node, text: "" };
          return { success: true };
        },
      },
      inputText: {
        execute: async (text: string) => {
          calls.push(`input:${text}`);
          node = { ...node, text: format(text) };
          return { success: true, text };
        },
      },
    });

  beforeEach(() => {
    fakeObserve = new FakeObserveScreenForSetUIState();
    fakeObserve.setResultFactory(observe);
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    calls = [];
  });

  const phoneField = (text: string): Element => ({
    bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
    "resource-id": "com.google.android.contacts:id/phone",
    class: "android.widget.EditText",
    text,
    focusable: "true",
    clickable: "true",
  });

  const formatPhone = (digits: string) =>
    `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;

  test("accepts an app-formatted phone number on the first attempt", async () => {
    node = phoneField("");
    const result = await createSetUIState({ format: formatPhone }).execute({
      fields: [
        { selector: { elementId: "com.google.android.contacts:id/phone" }, value: "4155550142" },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.fields[0]).toMatchObject({
      success: true,
      attempts: 1,
      verified: true,
      normalized: true,
      observed: "(415) 555-0142",
    });
    expect(calls.filter((call) => call.startsWith("input:"))).toEqual(["input:4155550142"]);
  });

  test("does not re-type a field already holding the value in the app's format", async () => {
    node = phoneField("(415) 555-0142");
    const result = await createSetUIState().execute({
      fields: [
        { selector: { elementId: "com.google.android.contacts:id/phone" }, value: "4155550142" },
      ],
    });

    expect(result.fields[0]).toMatchObject({
      success: true,
      skipped: true,
      normalized: true,
      observed: "(415) 555-0142",
    });
    expect(calls).toEqual([]);
  });

  test("still fails a real mismatch, without the normalized marker", async () => {
    node = phoneField("");
    const result = await createSetUIState({ format: () => "(415) 555-0143" }).execute({
      fields: [
        { selector: { elementId: "com.google.android.contacts:id/phone" }, value: "4155550142" },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.fields[0].error).toContain('observed "(415) 555-0143"');
    expect(result.fields[0].normalized).toBeUndefined();
  });

  const minuteChip = (overrides: Partial<Element> = {}): Element => ({
    bounds: { left: 600, top: 400, right: 800, bottom: 560 },
    "resource-id": "com.google.android.deskclock:id/material_minute_text_input",
    class: "com.google.android.material.chip.Chip",
    "content-desc": "0 minutes",
    text: "00",
    checkable: "true",
    checked: "false",
    clickable: "true",
    focusable: "true",
    ...overrides,
  });

  test("focuses and types into a checkable chip that becomes an EditText", async () => {
    node = minuteChip();
    const setUIState = createSetUIState({
      onFocus: () => {
        node = {
          ...node,
          class: "android.widget.EditText",
          checkable: "false",
          focused: "true",
        };
      },
    });
    const result = await setUIState.execute({
      fields: [{ selector: { text: "0 minutes" }, value: "45" }],
    });

    expect(result.success).toBe(true);
    expect(result.fields[0]).toMatchObject({
      success: true,
      attempts: 1,
      fieldType: "text",
      verified: true,
    });
    expect(calls).toEqual([
      "focus:com.google.android.deskclock:id/material_minute_text_input",
      "clear",
      "input:45",
    ]);
  });

  test("refuses a value for a non-editable checkable node once, with a next step", async () => {
    node = minuteChip({ focusable: "false" });
    const result = await createSetUIState().execute({
      fields: [{ selector: { text: "0 minutes" }, value: "45" }],
    });

    expect(result.success).toBe(false);
    expect(result.fields[0].attempts).toBe(1);
    expect(result.fields[0].fieldType).toBe("checkbox");
    expect(result.fields[0].error).toContain("selected is required");
    expect(result.fields[0].error).toContain("sendKeys");
    expect(calls).toEqual([]);
  });

  test("does not retry a text field given no value", async () => {
    node = phoneField("");
    const result = await createSetUIState().execute({
      fields: [{ selector: { elementId: "com.google.android.contacts:id/phone" }, selected: true }],
    });

    expect(result.success).toBe(false);
    expect(result.fields[0].attempts).toBe(1);
    expect(result.fields[0].error).toBe("value is required for text fields");
  });
});
