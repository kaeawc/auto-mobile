import { beforeEach, describe, expect, test } from "bun:test";
import {
  FocusNavigate,
  type FocusKeyPresser,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { Element } from "../../../src/models/Element";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hand-reconstructed from the #17315 report (Android TV Settings > Languages, tv_1080p): the
// focused row stays at [1200,583][1920,679] while the list scrolls under it, and the row's label
// lives in a child TextView. Not a parser fixture: the observer hands FocusNavigate Elements.
const LANGUAGES = [
  "Deutsch",
  "Emakhuwa",
  "English",
  "Español",
  "Esperanto",
  "Euskara",
  "Eʋegbe",
  "Èdè Yorùbá",
  "Français",
  "Furlan",
];
const ROW_HEIGHT = 96;
const LEFT = 1200;
const RIGHT = 1920;
/** The fixed focus slot is the third visible row. */
const FOCUS_SLOT = 2;
const SLOT_TOP = 583 - FOCUS_SLOT * ROW_HEIGHT;
const VISIBLE_ROWS = 6;

/** A recycler list whose focused row never moves: each DOWN scrolls the next item into the slot. */
class FakeFixedSlotList implements FocusObserver, FocusKeyPresser {
  focusIndex = 1;
  readonly presses: InputKeyName[] = [];

  private rowAt(slot: number): { row: Element; label: Element } | undefined {
    const index = this.focusIndex - FOCUS_SLOT + slot;
    const text = LANGUAGES[index];
    if (text === undefined) {
      return undefined;
    }
    const top = SLOT_TOP + slot * ROW_HEIGHT;
    const bounds = { left: LEFT, top, right: RIGHT, bottom: top + ROW_HEIGHT };
    return {
      row: { bounds, focusable: true, clickable: true, class: "android.widget.LinearLayout" },
      label: {
        bounds: { left: LEFT + 48, top: top + 24, right: RIGHT - 48, bottom: top + 72 },
        "resource-id": "android:id/title",
        text,
        class: "android.widget.TextView",
      },
    };
  }

  async read(): Promise<FocusScreen> {
    const rows = Array.from({ length: VISIBLE_ROWS }, (_, slot) => this.rowAt(slot)).filter(
      (entry) => entry !== undefined,
    );
    const focused = this.rowAt(FOCUS_SLOT)?.row ?? null;
    return { focused, elements: rows.flatMap(({ row, label }) => [row, label]) };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.presses.push(key);
    if (key === "arrow_down" && this.focusIndex < LANGUAGES.length - 1) {
      this.focusIndex += 1;
    }
    return { success: true };
  }
}

describe("FocusNavigate on a fixed-slot recycler list (#17315)", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  test("an explicit direction keeps pressing while the focused row's label changes", async () => {
    const list = new FakeFixedSlotList();
    const result = await new FocusNavigate(list, list, timer).execute({
      until: { text: "Èdè Yorùbá" },
      direction: "down",
    });

    expect(result.status).toBe("focused");
    expect(result.steps).toBe(6);
    expect(result.path.map((entry) => entry.descendantLabel)).toEqual(LANGUAGES.slice(1, 8));
  });

  test("an inferred direction scans down to an off-screen target instead of stopping stuck", async () => {
    const list = new FakeFixedSlotList();
    const result = await new FocusNavigate(list, list, timer).execute({
      until: { text: "Èdè Yorùbá" },
    });

    expect(result.status).toBe("focused");
    expect(result.focusedElement?.descendantLabel).toBe("Èdè Yorùbá");
    expect(list.presses.every((key) => key === "arrow_down")).toBe(true);
  });

  test("a press that leaves the same row focused still counts as not moving", async () => {
    const list = new FakeFixedSlotList();
    list.focusIndex = LANGUAGES.length - 1;
    const result = await new FocusNavigate(list, list, timer).execute({
      until: { text: "Missing" },
      direction: "down",
    });

    expect(result.status).toBe("stuck");
    expect(result.steps).toBe(2);
  });
});
