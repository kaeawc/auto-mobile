import { describe, expect, test } from "bun:test";
import {
  FocusNavigate,
  type FocusKeyboardHider,
  type FocusKeyPresser,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { Element } from "../../../src/models/Element";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * #17741 (manual-test mt0093a, Android TV emulator API 36): the TV fixture Search screen's
 * `search_field`, IME up, read with no Compose host above it so it counts as a View field. Back
 * hid the keyboard, then down, up, left and right all left focus on the field, and the advised
 * `pressButton down` did not free it either. The fake device replays that flow: it refuses every
 * arrow and tab on the field, and back only hides the keyboard.
 */
const searchField: Element = {
  bounds: { left: 96, top: 54, right: 1056, bottom: 154 },
  "resource-id": "search_field",
  class: "android.widget.EditText",
  "content-desc": "Search titles",
  focusable: true,
  focused: true,
};
const playerCard: Element = {
  bounds: { left: 96, top: 600, right: 416, bottom: 780 },
  text: "Player",
  focusable: true,
};

/** The read's tree: the field under a plain View root, no `ComposeView` ancestor. */
const hierarchy: ViewHierarchyResult = {
  hierarchy: {
    node: {
      $: { class: "android.widget.FrameLayout", bounds: "[0,0][1920,1080]" },
      node: [
        {
          $: {
            class: "android.widget.EditText",
            "resource-id": "search_field",
            bounds: "[96,54][1056,154]",
            focused: "true",
          },
        },
      ],
    },
  },
};

const ARROWS = ["arrow_up", "arrow_down", "arrow_left", "arrow_right"] as const;

class Mt0093aDevice implements FocusObserver, FocusKeyPresser, FocusKeyboardHider {
  readonly keys: string[] = [];
  private ime: boolean;
  private readonly targetOnScreen: boolean;

  constructor(imeVisible: boolean, { targetOnScreen = true }: { targetOnScreen?: boolean } = {}) {
    this.ime = imeVisible;
    this.targetOnScreen = targetOnScreen;
  }

  async read(): Promise<FocusScreen> {
    return {
      focused: searchField,
      elements: this.targetOnScreen ? [searchField, playerCard] : [searchField],
      imeVisible: this.ime,
      hierarchy,
    };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.keys.push(key);
    return { success: true };
  }

  async hideKeyboard(): Promise<{ success: boolean }> {
    this.keys.push("back");
    this.ime = false;
    return { success: true };
  }
}

function navigate(
  device: Mt0093aDevice,
  { withHider = true, direction }: { withHider?: boolean; direction?: "up" } = {},
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const navigator = withHider
    ? new FocusNavigate(device, device, timer, device)
    : new FocusNavigate(device, device, timer);
  return navigator.execute({ until: { label: "Player" }, ...(direction ? { direction } : {}) });
}

/** Every D-pad direction a message tells the caller to press. */
function advisedArrows(message: string | undefined): string[] {
  return [...(message ?? "").matchAll(/pressButton (up|down|left|right)\b/g)].map((m) => m[1]);
}

describe("FocusNavigate View text-field trap advice (#17741)", () => {
  test("after back and every direction failed, the result advises no D-pad move", async () => {
    const device = new Mt0093aDevice(true);

    const result = await navigate(device);

    expect(result.status).toBe("stuck");
    expect(result.blockedBy).toBe("editable");
    expect(result.escapes).toEqual(["back"]);
    // Tab could type into a View field, so it is never pressed there.
    expect(device.keys).not.toContain("tab");
    // The captured flow: every arrow was pressed after back without moving focus.
    const afterBack = device.keys.slice(device.keys.indexOf("back") + 1);
    expect(afterBack).toEqual(expect.arrayContaining([...ARROWS]));
    expect(result.focusedElement?.resourceId).toBe("search_field");
    expect(advisedArrows(result.message)).toEqual([]);
    expect(result.message).toContain("pressing back and every direction again did not move focus");
    expect(result.message).toContain("No D-pad direction moves focus out of this field");
    expect(result.message).toContain("press pressButton back to leave the screen");
  });

  test("with no keyboard shown, the arrows already tried are not advised again", async () => {
    const device = new Mt0093aDevice(false);

    const result = await navigate(device);

    expect(result.blockedBy).toBe("editable");
    expect(result.escapes).toEqual([]);
    expect(device.keys).toEqual(expect.arrayContaining([...ARROWS]));
    expect(advisedArrows(result.message)).toEqual([]);
    expect(result.message).toContain("tab would type into it");
    expect(result.message).toContain("No D-pad direction moves focus out of this field");
  });

  test("without a keyboard hider, only hiding the keyboard is advised before leaving", async () => {
    const device = new Mt0093aDevice(true);

    const result = await navigate(device, { withHider: false });

    expect(result.blockedBy).toBe("ime");
    expect(result.escapes).toEqual([]);
    expect(device.keys).not.toContain("back");
    expect(advisedArrows(result.message)).toEqual([]);
    expect(result.message).toContain("Hide the keyboard with pressButton back and observe");
    expect(result.message).toContain("press pressButton back to leave the screen");
  });

  test("a fixed-direction walk is told the arrows it never pressed before leaving", async () => {
    const device = new Mt0093aDevice(true);

    const result = await navigate(device, { direction: "up" });

    expect(result.status).toBe("stuck");
    expect(result.escapes).toEqual(["back"]);
    expect(device.keys).not.toContain("arrow_down");
    expect(result.message).toContain("pressing back and up again did not move focus");
    expect(result.message).toContain(
      "Press pressButton down, left or right (not yet pressed from this field) and observe; if focus still does not leave it, press pressButton back to leave the screen",
    );
    expect(result.message).not.toContain("every direction");
    expect(result.message).not.toContain("No D-pad direction moves focus");
  });

  test("a target absent from the read names the one refused arrow and the untried ones", async () => {
    const device = new Mt0093aDevice(false, { targetOnScreen: false });

    const result = await navigate(device);

    expect(result.status).toBe("stuck");
    expect(result.blockedBy).toBe("editable");
    // With no match in the read the walk scans down only, so one refusal ends it.
    expect(device.keys).toEqual(["arrow_down"]);
    expect(result.message).toContain("pressing down does not leave it and tab would type into it");
    expect(result.message).not.toContain("arrow keys do not leave it");
    expect(advisedArrows(result.message)).toEqual(["up"]);
    expect(result.message).toContain("Press pressButton up, left or right (not yet pressed");
    expect(result.message).not.toContain("No D-pad direction moves focus");
  });

  test("a target absent from the read after back names only the arrows refused since", async () => {
    const device = new Mt0093aDevice(true, { targetOnScreen: false });

    const result = await navigate(device);

    expect(result.escapes).toEqual(["back"]);
    expect(device.keys).toEqual(["arrow_down", "back", "arrow_down"]);
    expect(result.message).toContain("pressing back and down again did not move focus");
    expect(result.message).not.toContain("every direction");
    expect(result.message).toContain("Press pressButton up, left or right (not yet pressed");
  });

  test("all four arrows refused after back: every direction is reported and the screen left", async () => {
    const device = new Mt0093aDevice(true);

    const result = await navigate(device);

    const afterBack = device.keys.slice(device.keys.indexOf("back") + 1);
    expect([...new Set(afterBack)].sort()).toEqual([...ARROWS].sort());
    expect(result.message).toContain("pressing back and every direction again did not move focus");
    expect(result.message).not.toContain("not yet pressed");
    expect(result.message).toContain("No D-pad direction moves focus out of this field");
    expect(result.message).toContain("press pressButton back to leave the screen");
  });
});
