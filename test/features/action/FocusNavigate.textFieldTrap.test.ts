import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FocusNavigate,
  type FocusKeyboardHider,
  type FocusKeyPresser,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import { createFocusNavigateObserver } from "../../../src/features/action/FocusNavigateObserver";
import { DpadTapOn } from "../../../src/features/action/DpadTapOn";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { Element } from "../../../src/models/Element";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * #17356: an editable field with the IME shown traps D-pad focus. The capture is the Playground
 * Text screen with the focused `Basic Text Field` EditText and the Gboard window (type 2), see
 * test/fixtures/android-focus/README.md. The Android TV Login screen still needs a device capture.
 */
function capturedTextFieldWithIme(): ViewHierarchyResult {
  const raw = readFileSync(
    new URL("../../fixtures/android-focus/playground-text-field-post-tap.json", import.meta.url),
    "utf8",
  );
  return (JSON.parse(raw) as { viewHierarchy: ViewHierarchyResult }).viewHierarchy;
}

/** The same capture after back hid the keyboard: only the input-method window is gone. */
function withoutIme(hierarchy: ViewHierarchyResult): ViewHierarchyResult {
  return { ...hierarchy, windows: (hierarchy.windows ?? []).filter((w) => w.type !== 2) };
}

/** A device where arrows never leave the focused field and back hides the IME. */
class TrappedDevice implements Pick<ObserveScreen, "execute">, FocusKeyPresser, FocusKeyboardHider {
  readonly keys: string[] = [];
  private hierarchy = capturedTextFieldWithIme();

  async execute(): Promise<ObserveResult> {
    return { viewHierarchy: this.hierarchy } as ObserveResult;
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.keys.push(key);
    return { success: true };
  }

  async hideKeyboard(): Promise<{ success: boolean }> {
    this.keys.push("back");
    this.hierarchy = withoutIme(this.hierarchy);
    return { success: true };
  }
}

function timer(): FakeTimer {
  const fake = new FakeTimer();
  fake.enableAutoAdvance();
  return fake;
}

describe("FocusNavigate text-field focus trap (#17356)", () => {
  test("the observer reports the captured IME window", async () => {
    const device = new TrappedDevice();
    const screen = await createFocusNavigateObserver(device).read();
    expect(screen.imeVisible).toBe(true);
    expect(screen.focused?.class).toBe("android.widget.EditText");
  });

  test("hides the keyboard with back, retries every direction, then names the trap", async () => {
    const device = new TrappedDevice();
    const navigator = new FocusNavigate(
      createFocusNavigateObserver(device),
      device,
      timer(),
      device,
    );

    const result = await navigator.execute({ until: { label: "Email" } });

    expect(result.status).toBe("stuck");
    expect(result.blockedBy).toBe("editable");
    expect(result.escapes).toEqual(["back"]);
    // Tab types into an editable field, so it is never pressed there.
    expect(device.keys).not.toContain("tab");
    const back = device.keys.indexOf("back");
    expect(back).toBeGreaterThan(0);
    expect(device.keys.slice(back + 1).length).toBeGreaterThan(0);
    expect(device.keys.filter((key) => key === "back")).toHaveLength(1);
    expect(result.message).toContain("D-pad focus is trapped in the editable text field");
    expect(result.message).toContain("pressing back and every direction again");
  });

  test("without a keyboard hider the trap is reported as the IME and nothing is escaped", async () => {
    const device = new TrappedDevice();
    const navigator = new FocusNavigate(createFocusNavigateObserver(device), device, timer());

    const result = await navigator.execute({ until: { label: "Email" } });

    expect(result.blockedBy).toBe("ime");
    expect(result.escapes).toEqual([]);
    expect(device.keys).not.toContain("tab");
    expect(device.keys).not.toContain("back");
    expect(result.message).toContain(
      "trapped by the on-screen keyboard over the editable text field",
    );
  });

  test("focus that leaves the field once the keyboard is hidden reaches the target", async () => {
    const device = new TrappedDevice();
    const captured = createFocusNavigateObserver(device);
    let imeHidden = false;
    let moved: Element | undefined;
    const observer: FocusObserver = {
      read: async (): Promise<FocusScreen> => {
        const screen = await captured.read();
        return moved ? { ...screen, focused: moved } : screen;
      },
    };
    const keys: FocusKeyPresser = {
      press: async (key) => {
        device.keys.push(key);
        if (imeHidden && !moved) {
          const screen = await captured.read();
          moved = screen.elements.find((element) => element.text === "Email");
        }
        return { success: true };
      },
    };
    const hider: FocusKeyboardHider = {
      hideKeyboard: async () => {
        imeHidden = true;
        return device.hideKeyboard();
      },
    };

    const result = await new FocusNavigate(observer, keys, timer(), hider).execute({
      until: { label: "Email" },
    });

    expect(result.status).toBe("focused");
    expect(result.blockedBy).toBeUndefined();
    expect(device.keys.filter((key) => key === "back")).toHaveLength(1);
  });

  test("tapOn's D-pad failure names the text-field trap", async () => {
    const device = new TrappedDevice();
    const navigator = new FocusNavigate(
      createFocusNavigateObserver(device),
      device,
      timer(),
      device,
    );

    const result = await new DpadTapOn(navigator, device).execute({ label: "Email" });

    expect(result.success).toBe(false);
    expect(result.focusNavigation.blockedBy).toBe("editable");
    expect(result.error).toContain("(stuck): D-pad focus is trapped in the editable text field");
    expect(device.keys).not.toContain("enter");
  });

  describe("fake focus graph", () => {
    const slider: Element = {
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      "resource-id": "app:id/slider_control",
      focusable: true,
    };
    const fab: Element = {
      bounds: { left: 0, top: 200, right: 100, bottom: 250 },
      "resource-id": "app:id/fab_add",
      focusable: true,
    };

    function graph(imeVisible: boolean | undefined) {
      const pressed: string[] = [];
      const state = { focused: slider, ime: imeVisible };
      const observer: FocusObserver = {
        read: async () => ({
          focused: state.focused,
          elements: [slider, fab],
          ...(state.ime !== undefined ? { imeVisible: state.ime } : {}),
        }),
      };
      const keys: FocusKeyPresser = {
        press: async (key) => {
          pressed.push(key);
          if (key === "tab") {
            state.focused = fab;
          }
          return { success: true };
        },
      };
      const hider: FocusKeyboardHider = {
        hideKeyboard: async () => {
          pressed.push("back");
          state.ime = false;
          return { success: true };
        },
      };
      return { pressed, observer, keys, hider };
    }

    test("a non-editable focus under the IME escapes with back, then tab", async () => {
      const { pressed, observer, keys, hider } = graph(true);
      const result = await new FocusNavigate(observer, keys, timer(), hider).execute({
        until: { resourceId: "app:id/fab_add" },
      });
      expect(result.status).toBe("focused");
      expect(pressed.slice(-2)).toEqual(["back", "tab"]);
    });

    test("a stuck walk with no IME and no editable focus is unchanged", async () => {
      const { pressed, observer, keys, hider } = graph(undefined);
      const result = await new FocusNavigate(observer, keys, timer(), hider).execute({
        until: { resourceId: "app:id/fab_add" },
      });
      expect(result.status).toBe("stuck");
      expect(result.blockedBy).toBeUndefined();
      expect(result.escapes).toBeUndefined();
      expect(pressed).not.toContain("back");
      expect(pressed).not.toContain("tab");
      expect(result.message).toMatch(/^Focus did not move/);
    });
  });
});
