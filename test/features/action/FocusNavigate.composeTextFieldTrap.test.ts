import { describe, expect, test } from "bun:test";
import {
  FocusNavigate,
  type FocusKeyboardHider,
  type FocusKeyPresser,
  type FocusObserver,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { Element } from "../../../src/models/Element";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * #17441 (manual-test mt0091d, Android TV emulator API 36, Compose for TV fixture): with "mo"
 * typed into the Search screen's `search_field` and the IME up, back hides the keyboard but
 * up/down/left/right all leave focus on the field; only TAB (keyevent 61) moves focus, to
 * `card_movies_01`. The fake device below replays that evidence.
 */
const searchField: Element = {
  bounds: { left: 96, top: 120, right: 1824, bottom: 216 },
  "resource-id": "search_field",
  class: "android.widget.EditText",
  text: "mo",
  focusable: true,
  focused: true,
};
const movieCard: Element = {
  bounds: { left: 96, top: 320, right: 416, bottom: 500 },
  "resource-id": "card_movies_01",
  focusable: true,
};
const playerCard: Element = {
  bounds: { left: 96, top: 600, right: 416, bottom: 780 },
  text: "Player",
  focusable: true,
};

/** The same trap on a classic View EditText, identified by its package-qualified id. */
const viewSearchField: Element = { ...searchField, "resource-id": "com.example.tv:id/search" };

interface TvDeviceOptions {
  field: Element;
  /** Whether TAB moves focus off the field (the #17441 evidence); D-pad arrows never do. */
  tabLeaves: boolean;
  imeVisible: boolean;
}

class TvDevice implements FocusObserver, FocusKeyPresser, FocusKeyboardHider {
  readonly keys: string[] = [];
  private focused: Element;
  private ime: boolean;

  constructor(private readonly options: TvDeviceOptions) {
    this.focused = options.field;
    this.ime = options.imeVisible;
  }

  async read() {
    return {
      focused: this.focused,
      elements: [this.options.field, movieCard, playerCard],
      imeVisible: this.ime,
    };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.keys.push(key);
    if (this.focused === this.options.field) {
      if (key === "tab" && this.options.tabLeaves) {
        this.focused = movieCard;
      }
    } else if (key === "arrow_down") {
      this.focused = this.focused === movieCard ? playerCard : this.focused;
    }
    return { success: true };
  }

  async hideKeyboard(): Promise<{ success: boolean }> {
    this.keys.push("back");
    this.ime = false;
    return { success: true };
  }
}

function navigator(device: TvDevice): FocusNavigate {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new FocusNavigate(device, device, timer, device);
}

describe("FocusNavigate Compose TV text-field trap (#17441)", () => {
  test("back, then every direction, then tab leaves the Compose field and reaches the target", async () => {
    const device = new TvDevice({ field: searchField, tabLeaves: true, imeVisible: true });

    const result = await navigator(device).execute({ until: { label: "Player" } });

    expect(result.status).toBe("focused");
    expect(result.blockedBy).toBeUndefined();
    const back = device.keys.indexOf("back");
    const tab = device.keys.indexOf("tab");
    expect(back).toBeGreaterThan(0);
    // Tab only after the hidden-keyboard retry showed the arrows still do not move focus.
    expect(tab).toBeGreaterThan(back + 1);
    expect(device.keys.slice(back + 1, tab)).toContain("arrow_down");
    expect(device.keys.filter((key) => key === "tab")).toHaveLength(1);
    expect(result.path.map((entry) => entry.resourceId ?? entry.text).slice(-2)).toEqual([
      "card_movies_01",
      "Player",
    ]);
  });

  test("without the keyboard shown, a Compose field escapes with tab alone", async () => {
    const device = new TvDevice({ field: searchField, tabLeaves: true, imeVisible: false });

    const result = await navigator(device).execute({ until: { label: "Player" } });

    expect(result.status).toBe("focused");
    expect(device.keys).not.toContain("back");
    expect(device.keys.filter((key) => key === "tab")).toHaveLength(1);
  });

  test("a Compose field that tab does not free either reports both escapes without advising down", async () => {
    const device = new TvDevice({ field: searchField, tabLeaves: false, imeVisible: true });

    const result = await navigator(device).execute({ until: { label: "Player" } });

    expect(result.status).toBe("stuck");
    expect(result.blockedBy).toBe("editable");
    expect(result.escapes).toEqual(["back", "tab"]);
    expect(result.message).toContain('the editable text field "search_field"');
    expect(result.message).toContain("pressing back then tab and every direction again");
    expect(result.message).not.toContain("pressButton down");
  });

  test("a View EditText gets back, never tab, and no D-pad advice (#17741)", async () => {
    const device = new TvDevice({ field: viewSearchField, tabLeaves: true, imeVisible: true });

    const result = await navigator(device).execute({ until: { label: "Player" } });

    expect(result.status).toBe("stuck");
    expect(result.escapes).toEqual(["back"]);
    expect(device.keys).not.toContain("tab");
    expect(result.message).not.toContain("pressButton down");
    expect(result.message).toContain("No D-pad direction moves focus out of this field");
  });

  test("a View EditText with no keyboard says tab would type into it", async () => {
    const device = new TvDevice({ field: viewSearchField, tabLeaves: true, imeVisible: false });

    const result = await navigator(device).execute({ until: { label: "Player" } });

    expect(result.escapes).toEqual([]);
    expect(device.keys).not.toContain("tab");
    expect(result.message).toContain("tab would type into it");
  });
});
