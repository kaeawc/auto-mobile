import { describe, expect, test } from "bun:test";
import { Keyboard, type KeyboardOpenClient } from "../../../src/features/action/Keyboard";
import { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  A11yActionResult,
  AccessibilityHierarchy,
  AccessibilityNodeSelector,
  FocusedInputActionTarget,
  HierarchyDelegateContext,
} from "../../../src/features/observe/android/types";
import type { InsertTextState } from "../../../src/features/observe/android/ctrlProxyProtocol";
import type { SendKeysTextClient } from "../../../src/features/action/SendKeys";
import type { ViewHierarchyResult } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeKeyboardHierarchyProvider } from "../../fakes/FakeKeyboardHierarchyProvider";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness } from "./SendKeysTestHarness";

// The Playground Compose "Basic Text Field" captured on emulator-5600 (API 36, Gboard).
import capturedImeOpen from "../../fixtures/android-ime-window/playground-gboard-api36.json";

const PACKAGE = "dev.jasonpearson.automobile.playground";
const IME_WINDOW_TYPE = 2;

const convert = (): ViewHierarchyResult =>
  new CtrlProxyHierarchy({
    timer: new FakeTimer(),
  } as HierarchyDelegateContext).convertToViewHierarchyResult(
    structuredClone(capturedImeOpen) as AccessibilityHierarchy,
  );

const keyboardClosed = (): ViewHierarchyResult => {
  const captured = convert();
  return {
    ...captured,
    windows: captured.windows?.filter((window) => window.type !== IME_WINDOW_TYPE),
  };
};

/**
 * One Compose text field behind both tools: the CtrlProxy slice `keyboard open` uses and the
 * insert-state read `sendKeys eventLast` proves its caret from. The click models the defect of
 * #10152 (it parks the caret at the end of the text); `set_selection` is the restore.
 */
class SharedComposeField implements KeyboardOpenClient {
  readonly selectionRestores: Array<{ start: number; end: number; expectedPackage?: string }> = [];
  restoreAccepted = true;

  constructor(
    public text: string,
    public start: number,
    public end: number = start,
  ) {}

  state(): InsertTextState {
    return {
      text: this.text,
      isShowingHintText: false,
      selectionStart: this.start,
      selectionEnd: this.end,
    };
  }

  insertAtCaret(inserted: string): void {
    const from = Math.min(this.start, this.end);
    const to = Math.max(this.start, this.end);
    this.text = this.text.slice(0, from) + inserted + this.text.slice(to);
    this.start = this.end = from + inserted.length;
  }

  async supportsNodeActionSelectors(): Promise<boolean> {
    return true;
  }

  async requestNodeAction(_action: string, _selector: AccessibilityNodeSelector) {
    return { success: false, action: "click", totalTimeMs: 1 } satisfies A11yActionResult;
  }

  async requestFocusedInputAction(
    action: "click" | "set_selection",
    focused: FocusedInputActionTarget = {},
  ): Promise<A11yActionResult> {
    if (action === "click") {
      this.start = this.end = this.text.length;
      return { success: true, action, totalTimeMs: 1 };
    }
    this.selectionRestores.push({
      ...focused.selection!,
      expectedPackage: focused.expectedPackage,
    });
    if (!this.restoreAccepted) {
      return { success: false, action, totalTimeMs: 1, error: "restore refused" };
    }
    this.start = focused.selection!.start;
    this.end = focused.selection!.end;
    return { success: true, action, totalTimeMs: 1 };
  }

  async requestInsertTextState(): Promise<{ success: boolean; state?: InsertTextState }> {
    return { success: true, state: this.state() };
  }
}

function openKeyboard(field: SharedComposeField) {
  const adb = new FakeAdbExecutor();
  const hierarchy = new FakeKeyboardHierarchyProvider();
  hierarchy.setResults([keyboardClosed(), convert()]);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const factory: AdbClientFactory = { create: () => adb };
  return new Keyboard(
    { deviceId: "emulator-5600", platform: "android", name: "emulator" },
    factory,
    hierarchy,
    timer,
    undefined,
    undefined,
    undefined,
    field,
  ).execute("open");
}

/** A sendKeys executor whose text client inserts into, and reads the state of, the same field. */
function sendKeysOn(field: SharedComposeField) {
  const h = createSendKeysHarness(android);
  h.adb.setAndroidApiLevel(34);
  const inserts: string[] = [];
  const client: SendKeysTextClient = h.client;
  client.insert = async (text) => {
    inserts.push(text);
    field.insertAtCaret(text);
    // Compose reports the caret as not placed even when it sits right after the text.
    return { success: true, caretPlaced: false };
  };
  client.readInsertTextState = async () => field.state();
  const keyCommands = () =>
    h.adb.getExecutedCommands().filter((command) => command.startsWith("shell input keyevent"));
  return { ...h, inserts, keyCommands };
}

describe("keyboard open followed by sendKeys eventLast on the same Compose field (#10152, #9887)", () => {
  test("the caret restored by open is the caret eventLast proves: one restore, no stray text", async () => {
    // The user left the caret at the start of "abc".
    const field = new SharedComposeField("abc", 0);

    const opened = await openKeyboard(field);

    expect(opened.message).toBe(
      "Keyboard opened (the click used to show it moved the caret from 0-0 to 3-3; restored to 0-0)",
    );
    expect(field.selectionRestores).toEqual([{ start: 0, end: 0, expectedPackage: PACKAGE }]);

    const h = sendKeysOn(field);
    const result = await h.executor.type({ action: "type", text: "XY0", mode: "eventLast" });

    expect(result).toMatchObject({ success: true, resolvedMode: "eventLast" });
    expect(result.warning).toBeUndefined();
    // The prefix went in where open put the caret back, and only the tail was a key event.
    expect(h.inserts).toEqual(["XY"]);
    expect(field.text).toBe("XYabc");
    expect(h.keyCommands()).toEqual(["shell input keyevent KEYCODE_0"]);
    // sendKeys has no selection primitive: still exactly the one restore from keyboard open.
    expect(field.selectionRestores).toHaveLength(1);
  });

  test("a restore that was refused leaves the caret at the end, and eventLast proves that caret instead", async () => {
    const field = new SharedComposeField("abc", 0);
    field.restoreAccepted = false;

    const opened = await openKeyboard(field);
    expect(opened.message).toContain("restoring it failed: restore refused");

    const h = sendKeysOn(field);
    const result = await h.executor.type({ action: "type", text: "XY0", mode: "eventLast" });

    expect(result).toMatchObject({ success: true });
    expect(h.inserts).toEqual(["XY"]);
    expect(field.text).toBe("abcXY");
    expect(h.keyCommands()).toEqual(["shell input keyevent KEYCODE_0"]);
    expect(field.selectionRestores).toHaveLength(1);
  });

  test("a selected range is restored by open and replaced by the eventLast prefix", async () => {
    const field = new SharedComposeField("abcd", 1, 3);

    const opened = await openKeyboard(field);
    expect(opened.message).toContain("restored to 1-3");

    const h = sendKeysOn(field);
    const result = await h.executor.type({ action: "type", text: "Q0", mode: "eventLast" });

    expect(result).toMatchObject({ success: true });
    expect(field.text).toBe("aQd");
    expect(field.selectionRestores).toHaveLength(1);
  });
});
