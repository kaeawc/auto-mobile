import { beforeEach, describe, expect, test } from "bun:test";
import { Keyboard } from "../../../src/features/action/Keyboard";
import { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../src/features/observe/android/types";
import type { InsertTextState } from "../../../src/features/observe/android/ctrlProxyProtocol";
import type { BootedDevice, Element, ViewHierarchyResult } from "../../../src/models";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { stableNodeSelectorForElement } from "../../../src/features/talkback/TalkBackTapStrategy";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeKeyboardHierarchyProvider } from "../../fakes/FakeKeyboardHierarchyProvider";
import { FakeKeyboardOpenClient } from "../../fakes/FakeKeyboardOpenClient";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured on emulator-5600 (API 36, Gboard): the Playground Compose "Basic Text Field" is the
// focused EditText with only a synthetic view-id (no resource id, test tag or unique id), and the
// IME window (type 2) spans [0,1517][1080,2400] on a 1080x2400 screen (#10152).
import capturedImeOpen from "../../fixtures/android-ime-window/playground-gboard-api36.json";

const IME_WINDOW_TYPE = 2;
const FIELD_CENTER = "shell input tap 540 1188";

const device: BootedDevice = { deviceId: "emulator-5600", platform: "android", name: "emulator" };

const convert = (): ViewHierarchyResult =>
  new CtrlProxyHierarchy({
    timer: new FakeTimer(),
  } as HierarchyDelegateContext).convertToViewHierarchyResult(
    structuredClone(capturedImeOpen) as AccessibilityHierarchy,
  );

/** The captured screen with the IME removed: the field is focused and the keyboard is closed. */
const closedWithFocusedComposeField = (overrides: Partial<ViewHierarchyResult> = {}) => {
  const captured = convert();
  return {
    ...captured,
    windows: captured.windows?.filter((window) => window.type !== IME_WINDOW_TYPE),
    ...overrides,
  };
};

/** The captured screen with the IME window at settled bounds. */
const settledKeyboard = () => convert();

/** Bounds read while the keyboard slid in, from the a2.out run of #10152 (top 2362, bottom 3245). */
const slidingKeyboard = (): ViewHierarchyResult => {
  const captured = convert();
  return {
    ...captured,
    windows: captured.windows?.map((window) =>
      window.type === IME_WINDOW_TYPE
        ? { ...window, bounds: { left: 0, top: 2362, right: 1080, bottom: 3245 } }
        : window,
    ),
  };
};

const caret = (start: number, end = start): InsertTextState => ({
  text: "abc",
  isShowingHintText: false,
  selectionStart: start,
  selectionEnd: end,
});

const refused = {
  success: false,
  action: "click",
  totalTimeMs: 1,
  error: "Accessibility action is unavailable: click",
  dispatched: true,
  acknowledged: true,
} as const;

describe("Keyboard open on a Compose text field with no stable selector (#10152)", () => {
  let adb: FakeAdbExecutor;
  let hierarchy: FakeKeyboardHierarchyProvider;
  let client: FakeKeyboardOpenClient;
  let timer: FakeTimer;

  const open = () => {
    const factory: AdbClientFactory = { create: () => adb };
    return new Keyboard(
      device,
      factory,
      hierarchy,
      timer,
      undefined,
      undefined,
      undefined,
      client,
    ).execute("open");
  };

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    hierarchy = new FakeKeyboardHierarchyProvider();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    client = new FakeKeyboardOpenClient();
  });

  test("the captured field really has no selector the node-click route could use", () => {
    const field = closedWithFocusedComposeField();
    const focused = new DefaultElementFinder().findFocusedTextInput(field);

    expect(focused?.["view-id"]).toStartWith("s2-");
    expect(stableNodeSelectorForElement(focused as Element)).toBeUndefined();
    expect(focused?.actions).toContain("click");
    expect(field.screenHeight).toBe(2400);
    expect(field.windows?.some((window) => window.type === IME_WINDOW_TYPE)).toBe(false);
  });

  test("shows the keyboard by clicking the focused input: no selector click, no tap", async () => {
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);
    client.queueInsertStates(caret(0), caret(0));

    const result = await open();

    expect(result).toMatchObject({ success: true, open: true, message: "Keyboard opened" });
    expect(client.nodeActions).toEqual([]);
    expect(client.focusedInputActions).toEqual([{ action: "click" }]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a click that leaves the caret at the start is reported as plain success", async () => {
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);
    client.queueInsertStates(caret(0), caret(0));

    const result = await open();

    expect(result.message).toBe("Keyboard opened");
    expect(client.focusedInputActions.map((call) => call.action)).toEqual(["click"]);
  });

  test("a click that moved the caret to the end restores it and confirms by read-back", async () => {
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);
    client.queueInsertStates(caret(0), caret(3), caret(0));

    const result = await open();

    expect(result.success).toBe(true);
    expect(result.message).toBe(
      "Keyboard opened (the click used to show it moved the caret from 0-0 to 3-3; restored to 0-0)",
    );
    expect(client.focusedInputActions).toEqual([
      { action: "click" },
      { action: "set_selection", selection: { start: 0, end: 0 } },
    ]);
    expect(client.caretReadCount).toBe(3);
  });

  test("restores a selected range, not just a caret", async () => {
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);
    client.queueInsertStates(caret(1, 2), caret(3), caret(1, 2));

    const result = await open();

    expect(result.message).toContain("restored to 1-2");
    expect(client.focusedInputActions.at(-1)?.selection).toEqual({ start: 1, end: 2 });
  });

  test("never reports an unmoved caret when the restore was refused", async () => {
    client.restoreResult = {
      success: false,
      action: "set_selection",
      totalTimeMs: 1,
      error: "Accessibility action is unavailable: set_selection",
    };
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);
    client.queueInsertStates(caret(0), caret(3));

    const result = await open();

    expect(result.success).toBe(true);
    expect(result.message).toBe(
      "Keyboard opened (the click used to show it moved the caret from 0-0 to 3-3; restoring it failed: Accessibility action is unavailable: set_selection)",
    );
  });

  test("a restore that the read-back shows did not hold says the caret is still moved", async () => {
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);
    client.queueInsertStates(caret(0), caret(3), caret(3));

    const result = await open();

    expect(result.message).toBe(
      "Keyboard opened (the click used to show it moved the caret from 0-0 to 3-3; restoring it did not hold, the caret is at 3-3)",
    );
  });

  test("a restore that cannot be read back is reported as unconfirmed, not as restored", async () => {
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);
    client.queueInsertStates(caret(0), caret(3), undefined);

    const result = await open();

    expect(result.message).toBe(
      "Keyboard opened (the click used to show it moved the caret from 0-0 to 3-3; restore was sent but the caret could not be read back to confirm it)",
    );
  });

  test("with no caret read before the click nothing is claimed either way", async () => {
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);
    client.queueInsertStates(undefined, caret(3));

    const result = await open();

    expect(result.message).toBe("Keyboard opened");
    expect(client.focusedInputActions).toEqual([{ action: "click" }]);
  });

  test("falls back to a tap at the field centre when the focused-input click is refused", async () => {
    client.focusedClickResult = refused;
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);
    client.queueInsertStates(caret(0), caret(3), caret(0));

    const result = await open();

    expect(adb.wasCommandExecuted(FIELD_CENTER)).toBe(true);
    expect(result.message).toBe(
      "Keyboard opened (the tap used to show it moved the caret from 0-0 to 3-3; restored to 0-0)",
    );
  });

  test("an old runner that cannot address the focused input falls back to the tap", async () => {
    client.focusedClickResult = {
      success: false,
      action: "click",
      totalTimeMs: 1,
      error: "A resource-id or stable node selector is required for accessibility actions",
      dispatched: true,
      acknowledged: true,
    };
    hierarchy.setResults([closedWithFocusedComposeField(), settledKeyboard()]);

    const result = await open();

    expect(result.success).toBe(true);
    expect(adb.wasCommandExecuted(FIELD_CENTER)).toBe(true);
  });

  test("a focused-input click that was dispatched but never acknowledged is not followed by a tap", async () => {
    client.focusedClickResult = {
      success: false,
      action: "click",
      totalTimeMs: 5000,
      error: "Action timeout after 5000ms",
      dispatched: true,
      acknowledged: false,
    };
    hierarchy.setResults([closedWithFocusedComposeField()]);

    const result = await open();

    expect(result.success).toBe(false);
    expect(result.error).toContain("Keyboard open outcome is indeterminate");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  describe("a field whose bounds are off the screen", () => {
    // The captured field centre is y=1188; a 1000 px tall screen puts it below the display.
    const offScreen = () => closedWithFocusedComposeField({ screenHeight: 1000 });

    test("is never tapped: the open fails and says how to recover", async () => {
      client.focusedClickResult = refused;
      hierarchy.setResults([offScreen()]);

      const result = await open();

      expect(result.success).toBe(false);
      expect(result.open).toBe(false);
      expect(result.error).toContain("The focused text input is off screen");
      expect(result.error).toContain("[84,1115][996,1262] on a 1080x1000 screen");
      expect(result.error).toContain("no tap was sent");
      expect(result.error).toContain("swipeOn");
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test("can still be opened through the click, which uses no coordinates", async () => {
      hierarchy.setResults([offScreen(), settledKeyboard()]);

      const result = await open();

      expect(result.success).toBe(true);
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  });

  describe("keyboard bounds while the IME slides in", () => {
    test("waits for on-screen bounds instead of reporting the animation frame", async () => {
      hierarchy.setResults([closedWithFocusedComposeField(), slidingKeyboard(), settledKeyboard()]);

      const result = await open();

      expect(result.bounds).toEqual([{ left: 0, top: 1517, right: 1080, bottom: 2400 }]);
      expect(result.message).toBe("Keyboard opened");
      expect(timer.getSleepHistory()).toEqual([100]);
    });

    test("never reports bounds that stayed past the screen edge", async () => {
      hierarchy.setResults([closedWithFocusedComposeField()]);
      hierarchy.setDefaultResult(slidingKeyboard());

      const result = await open();

      expect(result.success).toBe(true);
      expect(result.open).toBe(true);
      expect(result.bounds).toBeUndefined();
      expect(result.message).toContain("bounds were still past the screen edge");
    });

    test("bounds are reported unchanged when the screen size is unknown", async () => {
      const { screenHeight, screenWidth, ...unsized } = slidingKeyboard();
      void screenHeight;
      void screenWidth;
      hierarchy.setResults([closedWithFocusedComposeField(), unsized]);

      const result = await open();

      expect(result.bounds).toEqual([{ left: 0, top: 2362, right: 1080, bottom: 3245 }]);
      expect(result.message).toBe("Keyboard opened");
    });
  });
});
