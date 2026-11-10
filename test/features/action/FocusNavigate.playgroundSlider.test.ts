import { beforeEach, describe, expect, test } from "bun:test";
import {
  FocusNavigate,
  type FocusKeyPresser,
  type FocusNavigateDirection,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { Element } from "../../../src/models/Element";
import type { ElementBounds } from "../../../src/models/ElementBounds";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hand-reconstructed from the #17739 report (Android TV emulator, tv_1080p, Playground home): the
// focused `slider_control` at [44,433][1876,521] announces "Slider with value N percent" through a
// contained label and takes left/right as value changes, `filter_chip_2` sits above it, and the
// bottom bar (Demos, Slides, Settings) is not reachable from the slider with the D-pad. Tab leaving
// the slider follows the #17356 notes; the bottom bar's bounds are illustrative. As in the
// Playground's TapScreen, a `slider_value_text` above the slider and the linear progress
// indicator's content-desc below it repeat the value outside the slider's bounds. Not a parser
// fixture: the observer hands FocusNavigate Elements.
const SLIDER_BOUNDS: ElementBounds = { left: 44, top: 433, right: 1876, bottom: 521 };
const CHIP_BOUNDS: ElementBounds = { left: 227, top: 417, right: 382, bottom: 513 };
const BAR_TOP = 980;

const KEY_DIRECTIONS: Partial<Record<InputKeyName, FocusNavigateDirection>> = {
  arrow_up: "up",
  arrow_down: "down",
  arrow_left: "left",
  arrow_right: "right",
};

type NodeId = "chip" | "slider" | "demos" | "slides" | "settings";

function barItem(text: string, left: number): Element {
  return {
    text,
    focusable: true,
    clickable: true,
    bounds: { left, top: BAR_TOP, right: left + 300, bottom: BAR_TOP + 80 },
  };
}

class FakePlaygroundHome implements FocusObserver, FocusKeyPresser {
  readonly presses: InputKeyName[] = [];
  focus: NodeId = "slider";
  value = 50;
  /** Arrow presses the slider took as value changes. */
  valuePresses = 0;

  constructor(
    private readonly tabLeavesSlider: boolean,
    /** False: left/right are refused outright and the label never changes. */
    private readonly adjustable = true,
  ) {}

  private readonly moves: Record<NodeId, Partial<Record<FocusNavigateDirection, NodeId>>> = {
    chip: { down: "slider" },
    slider: { up: "chip" },
    demos: { right: "slides" },
    slides: { left: "demos", right: "settings" },
    settings: { left: "slides" },
  };

  private element(id: NodeId): Element {
    switch (id) {
      case "chip":
        return {
          "resource-id": "filter_chip_2",
          text: "Chip 2 is selected",
          focusable: true,
          bounds: CHIP_BOUNDS,
        };
      case "slider":
        return {
          "resource-id": "slider_control",
          class: "android.view.View",
          focusable: true,
          bounds: SLIDER_BOUNDS,
        };
      case "demos":
        return barItem("Demos", 400);
      case "slides":
        return barItem("Slides", 800);
      case "settings":
        return barItem("Settings", 1200);
    }
  }

  async read(): Promise<FocusScreen> {
    const sliderLabel: Element = {
      "content-desc": `Slider with value ${this.value} percent`,
      bounds: { left: 64, top: 441, right: 1856, bottom: 513 },
    };
    const tab: Element = {
      text: "Tap",
      focusable: true,
      bounds: { left: 0, top: 128, right: 320, bottom: 224 },
    };
    const ids: NodeId[] = ["chip", "slider", "demos", "slides", "settings"];
    return {
      focused: this.element(this.focus),
      elements: [tab, ...ids.map((id) => this.element(id)), sliderLabel, ...this.valueReadouts()],
    };
  }

  /** The sibling readouts the Playground updates with the slider. */
  private valueReadouts(): Element[] {
    return [
      {
        "resource-id": "slider_value_text",
        text: `Slider Value: ${this.value}%`,
        bounds: { left: 64, top: 393, right: 360, bottom: 425 },
      },
      {
        "resource-id": "linear_progress_indicator",
        "content-desc": `Linear progress indicator showing ${this.value} percent`,
        bounds: { left: 64, top: 600, right: 1856, bottom: 608 },
      },
    ];
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.presses.push(key);
    if (key === "tab") {
      if (this.focus === "slider" && this.tabLeavesSlider) {
        this.focus = "demos";
      }
      return { success: true };
    }
    const direction = KEY_DIRECTIONS[key];
    if (!direction) {
      return { success: true };
    }
    const next = this.moves[this.focus][direction];
    if (next) {
      this.focus = next;
    } else if (
      this.adjustable &&
      this.focus === "slider" &&
      (direction === "left" || direction === "right")
    ) {
      this.valuePresses += 1;
      this.value += direction === "right" ? 1 : -1;
    }
    return { success: true };
  }
}

describe("FocusNavigate past a Playground slider that changes value on left/right (#17739)", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  test("treats the value change as no focus movement and leaves the slider with tab", async () => {
    const home = new FakePlaygroundHome(true);
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { text: "Settings" },
    });
    expect(result).toMatchObject({ success: true, status: "focused" });
    expect(result.steps).toBeLessThan(12);
    expect(home.presses).toContain("tab");
    // Each horizontal arrow is pressed on the slider once, so its value ends where it started.
    expect(home.valuePresses).toBe(2);
    expect(home.value).toBe(50);
  });

  test("ends stuck, not max_steps, naming the slider and the directions it consumed", async () => {
    const home = new FakePlaygroundHome(false);
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { text: "Settings" },
    });
    expect(result).toMatchObject({ success: false, status: "stuck" });
    expect(result.steps).toBeLessThan(30);
    expect(home.presses.filter((key) => key === "tab")).toEqual(["tab"]);
    expect(home.valuePresses).toBeLessThanOrEqual(4);
    expect(result.message).toContain(
      'the focused control "slider_control" consumed left and right',
    );
    expect(result.message).toContain("pressing tab did not move focus out of it either");
  });

  test("a slider whose label never changes still ends stuck without tab", async () => {
    const home = new FakePlaygroundHome(true, false);
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { text: "Settings" },
    });
    expect(result).toMatchObject({ success: false, status: "stuck" });
    expect(home.presses).not.toContain("tab");
  });

  test("a fixed-slot list row with a resource id still reads as moving while its list scrolls", async () => {
    // Hand-built: like #17315's Languages list, but every row carries `app:id/row`. Down scrolls
    // the next item into the fixed focus slot, so the neighbours shift by one slot each press.
    const items = Array.from({ length: 12 }, (_, index) => `Item ${index}`);
    let focusIndex = 0;
    const row = (slot: number): Element | undefined => {
      const text = items[focusIndex + slot - 1];
      const top = 400 + slot * 100;
      return text === undefined
        ? undefined
        : {
            "resource-id": "app:id/row",
            text,
            focusable: true,
            bounds: { left: 100, top, right: 900, bottom: top + 100 },
          };
    };
    const keys: InputKeyName[] = [];
    const list: FocusObserver & FocusKeyPresser = {
      read: async () => ({
        focused: row(1) ?? null,
        elements: [0, 1, 2, 3].map(row).filter((element) => element !== undefined),
      }),
      press: async (key) => {
        keys.push(key);
        if (key === "arrow_down" && focusIndex < items.length - 1) {
          focusIndex += 1;
        }
        return { success: true };
      },
    };
    const result = await new FocusNavigate(list, list, timer).execute({
      until: { text: "Item 6" },
    });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 6 });
    expect(keys).toEqual(Array<InputKeyName>(6).fill("arrow_down"));
  });

  test("a two-slot list with one row outside focus still reads as moving while it scrolls", async () => {
    // Hand-built: only the focused row and the next one are visible, both `app:id/row`. Down
    // scrolls the next item into the fixed focus slot, so the one row outside focus always shows a
    // label that was not on screen before, and the previous neighbour's label lands on focus.
    const items = Array.from({ length: 12 }, (_, index) => `Item ${index}`);
    let focusIndex = 0;
    const row = (slot: number): Element | undefined => {
      const text = items[focusIndex + slot];
      const top = 400 + slot * 100;
      return text === undefined
        ? undefined
        : {
            "resource-id": "app:id/row",
            text,
            focusable: true,
            bounds: { left: 100, top, right: 900, bottom: top + 100 },
          };
    };
    const keys: InputKeyName[] = [];
    const list: FocusObserver & FocusKeyPresser = {
      read: async () => ({
        focused: row(0) ?? null,
        elements: [0, 1].map(row).filter((element) => element !== undefined),
      }),
      press: async (key) => {
        keys.push(key);
        if (key === "arrow_down" && focusIndex < items.length - 1) {
          focusIndex += 1;
        }
        return { success: true };
      },
    };
    const result = await new FocusNavigate(list, list, timer).execute({
      until: { text: "Item 6" },
    });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 6 });
    expect(keys).toEqual(Array<InputKeyName>(6).fill("arrow_down"));
  });

  test("a one-slot list reads as moving while it scrolls (#17773)", async () => {
    // Hand-built: the recycler shows only the focused row, `app:id/row` at fixed bounds, under a
    // static title. Down scrolls the next item into that one slot, so no row is left outside focus
    // and the only label outside it never changes.
    const list = new FakeSlotList(1, ["title"]);
    const result = await new FocusNavigate(list, list, timer).execute({
      until: { text: "Item 6" },
    });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 6 });
    expect(list.keys).toEqual(Array<InputKeyName>(6).fill("arrow_down"));
  });

  test("a one-slot list with nothing else on screen reads as moving (#17773)", async () => {
    const list = new FakeSlotList(1, []);
    const result = await new FocusNavigate(list, list, timer).execute({
      until: { text: "Item 6" },
    });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 6 });
    expect(list.keys).toEqual(Array<InputKeyName>(6).fill("arrow_down"));
  });

  test("a list that repages every visible row in place reads as moving (#17773)", async () => {
    // Hand-built: three `app:id/row` slots under a static title; each down press replaces every
    // row's label at the same bounds, so no label moves to a new place.
    const list = new FakeSlotList(3, ["title"], 3);
    const result = await new FocusNavigate(list, list, timer).execute({
      until: { text: "Item 6" },
    });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 2 });
    expect(list.keys).toEqual(Array<InputKeyName>(2).fill("arrow_down"));
  });
});

/**
 * A recycler of `app:id/row` rows at fixed slots, focus on the first slot. Each down press
 * advances the list by `page` items, so the focused slot always shows the next label.
 */
class FakeSlotList implements FocusObserver, FocusKeyPresser {
  readonly keys: InputKeyName[] = [];
  private readonly items = Array.from({ length: 12 }, (_, index) => `Item ${index}`);
  private first = 0;

  constructor(
    private readonly slots: number,
    private readonly statics: readonly string[],
    private readonly page = 1,
  ) {}

  private row(slot: number): Element | undefined {
    const text = this.items[this.first + slot];
    const top = 400 + slot * 100;
    return text === undefined
      ? undefined
      : {
          "resource-id": "app:id/row",
          text,
          focusable: true,
          bounds: { left: 100, top, right: 900, bottom: top + 100 },
        };
  }

  async read(): Promise<FocusScreen> {
    const statics: Element[] = this.statics.map((text, index) => ({
      "resource-id": `app:id/${text}`,
      text,
      bounds: { left: 100, top: 100 + index * 60, right: 900, bottom: 150 + index * 60 },
    }));
    const rows = Array.from({ length: this.slots }, (_, slot) => this.row(slot)).filter(
      (element) => element !== undefined,
    );
    return { focused: this.row(0) ?? null, elements: [...statics, ...rows] };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.keys.push(key);
    if (key === "arrow_down" && this.first + this.page < this.items.length) {
      this.first += this.page;
    }
    return { success: true };
  }
}
