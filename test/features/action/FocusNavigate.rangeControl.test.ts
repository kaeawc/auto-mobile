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
import { FakeTimer } from "../../fakes/FakeTimer";

// Hand-built (#17209 review): a settings column whose rows hold range controls. Not a parser
// fixture: the observer hands FocusNavigate Elements.
const KEY_DIRECTIONS: Partial<Record<InputKeyName, FocusNavigateDirection>> = {
  arrow_up: "up",
  arrow_down: "down",
  arrow_left: "left",
  arrow_right: "right",
};

interface Node {
  element: () => Element;
  moves: Partial<Record<FocusNavigateDirection, string>>;
  /** Directions the node takes as a value change instead of moving focus. */
  adjusts?: readonly FocusNavigateDirection[];
  /** Where tab moves focus from this node. */
  tab?: string;
  /** False: the node is not on screen unless focused (a recycled focus slot, #18393). */
  shownUnfocused?: boolean;
}

class FakeSettingsColumn implements FocusObserver, FocusKeyPresser {
  readonly presses: InputKeyName[] = [];
  private readonly values = new Map<string, number>();
  valuePresses = 0;

  constructor(
    public focus: string,
    private readonly nodes: Record<string, Node>,
    private readonly extras: () => Element[] = () => [],
  ) {}

  get value(): number {
    return this.valueOf(this.focus);
  }

  valueOf(id: string): number {
    return this.values.get(id) ?? 50;
  }

  async read(): Promise<FocusScreen> {
    const shown = Object.entries(this.nodes).filter(
      ([id, node]) => id === this.focus || node.shownUnfocused !== false,
    );
    return {
      focused: this.nodes[this.focus].element(),
      elements: [...shown.map(([, node]) => node.element()), ...this.extras()],
    };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.presses.push(key);
    const direction = KEY_DIRECTIONS[key];
    const node = this.nodes[this.focus];
    if (!direction) {
      this.focus = key === "tab" ? (node.tab ?? this.focus) : this.focus;
      return { success: true };
    }
    if (node.adjusts?.includes(direction)) {
      this.valuePresses += 1;
      const step = direction === "right" || direction === "up" ? 1 : -1;
      this.values.set(this.focus, this.value + step);
      return { success: true };
    }
    this.focus = node.moves[direction] ?? this.focus;
    return { success: true };
  }
}

function row(text: string, top: number): Element {
  return {
    text,
    focusable: true,
    clickable: true,
    bounds: { left: 0, top, right: 1000, bottom: top + 100 },
  };
}

describe("FocusNavigate around range controls (#17209)", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  test("a focused row holding a progress bar is walked past with arrows", async () => {
    // The row itself reports no range; only the smaller ProgressBar inside it does.
    const home = new FakeSettingsColumn(
      "storage",
      {
        storage: { element: () => row("Storage", 100), moves: { down: "about" } },
        about: { element: () => row("About", 200), moves: { up: "storage", down: "done" } },
        done: { element: () => row("Done", 300), moves: { up: "about" } },
      },
      () => [
        {
          class: "android.widget.ProgressBar",
          "range-info": "current:40.0,min:0.0,max:100.0",
          bounds: { left: 20, top: 160, right: 980, bottom: 180 },
        },
      ],
    );
    const result = await new FocusNavigate(home, home, timer).execute({ until: { text: "Done" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 2 });
    expect(home.presses).toEqual(["arrow_down", "arrow_down"]);
  });

  test("a SeekBar whose up and down move focus is left by an arrow, its value unchanged", async () => {
    // A View SeekBar: left/right adjust, down moves focus. The target sits to its right in the
    // same band but is reached with down, so right is tried first, changes the value, and is
    // undone with left.
    const seekBar = (): Element => ({
      "resource-id": "volume",
      class: "android.widget.SeekBar",
      focusable: true,
      "range-info": `current:${home.valueOf("volume")}.0,min:0.0,max:100.0`,
      bounds: { left: 0, top: 100, right: 1000, bottom: 200 },
    });
    const home: FakeSettingsColumn = new FakeSettingsColumn("volume", {
      volume: {
        element: seekBar,
        moves: { down: "done" },
        adjusts: ["left", "right"],
      },
      done: {
        element: () => ({
          text: "Done",
          focusable: true,
          bounds: { left: 1500, top: 120, right: 1700, bottom: 180 },
        }),
        moves: { up: "volume" },
      },
    });
    const result = await new FocusNavigate(home, home, timer).execute({ until: { text: "Done" } });
    expect(result).toMatchObject({ success: true, status: "focused" });
    expect(home.presses).toContain("arrow_down");
    expect(home.presses).not.toContain("tab");
    expect(home.valueOf("volume")).toBe(50);
    expect(home.presses.slice(0, 2)).toEqual(["arrow_right", "arrow_left"]);
  });

  test("a walk through two sliders that take every arrow gets one tab out of each (#18393)", async () => {
    const slider = (id: string, top: number) => (): Element => ({
      "resource-id": id,
      class: "android.widget.SeekBar",
      focusable: true,
      "range-info": `current:${home.valueOf(id)}.0,min:0.0,max:100.0`,
      bounds: { left: 0, top, right: 1000, bottom: top + 100 },
    });
    const every: FocusNavigateDirection[] = ["up", "down", "left", "right"];
    const home: FakeSettingsColumn = new FakeSettingsColumn("volume", {
      volume: { element: slider("volume", 100), moves: {}, adjusts: every, tab: "brightness" },
      brightness: { element: slider("brightness", 200), moves: {}, adjusts: every, tab: "done" },
      done: { element: () => row("Done", 300), moves: {} },
    });
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { text: "Done" },
      maxSteps: 40,
    });
    expect(result).toMatchObject({ success: true, status: "focused" });
    expect(home.presses.filter((key) => key === "tab")).toHaveLength(2);
    expect(home.valueOf("volume")).toBe(50);
    expect(home.valueOf("brightness")).toBe(50);
  });

  test("a slider that tab does not leave still ends stuck after one tab (#18393)", async () => {
    const home: FakeSettingsColumn = new FakeSettingsColumn("volume", {
      volume: {
        element: () => ({
          "resource-id": "volume",
          class: "android.widget.SeekBar",
          focusable: true,
          "range-info": `current:${home.valueOf("volume")}.0,min:0.0,max:100.0`,
          bounds: { left: 0, top: 100, right: 1000, bottom: 200 },
        }),
        moves: {},
        adjusts: ["up", "down", "left", "right"],
      },
      done: { element: () => row("Done", 300), moves: {} },
    });
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { text: "Done" },
      maxSteps: 40,
    });
    expect(result).toMatchObject({ success: false, status: "stuck" });
    expect(result.message).toContain("pressing tab did not move focus out of it either");
    expect(home.presses.filter((key) => key === "tab")).toHaveLength(1);
  });

  test("a recycled focus slot showing another range control reads as a move, not a value change (#18393)", async () => {
    // One focus slot reused by Volume then Brightness: same resource id, class and bounds,
    // different label and value. Down moves to the next control; the target sits past both.
    const slot = (label: string, value: number) => (): Element => ({
      "resource-id": "setting_slider",
      class: "android.widget.SeekBar",
      "content-desc": label,
      focusable: true,
      "range-info": `current:${value}.0,min:0.0,max:100.0`,
      bounds: { left: 0, top: 100, right: 1000, bottom: 200 },
    });
    const home = new FakeSettingsColumn("volume", {
      volume: {
        element: slot("Volume", 30),
        moves: { down: "brightness" },
        adjusts: ["left", "right"],
        shownUnfocused: false,
      },
      brightness: {
        element: slot("Brightness", 80),
        moves: { up: "volume", down: "done" },
        adjusts: ["left", "right"],
        shownUnfocused: false,
      },
      done: { element: () => row("Done", 400), moves: { up: "brightness" } },
    });
    const result = await new FocusNavigate(home, home, timer).execute({ until: { text: "Done" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 2 });
    expect(home.presses).toEqual(["arrow_down", "arrow_down"]);
  });

  test("a recycled range slot that is the target is not undone (#18393)", async () => {
    const slot = (label: string, value: number) => (): Element => ({
      "resource-id": "setting_slider",
      class: "android.widget.SeekBar",
      "content-desc": label,
      focusable: true,
      "range-info": `current:${value}.0,min:0.0,max:100.0`,
      bounds: { left: 0, top: 100, right: 1000, bottom: 200 },
    });
    const home = new FakeSettingsColumn("volume", {
      volume: { element: slot("Volume", 30), moves: { down: "brightness" }, shownUnfocused: false },
      brightness: {
        element: slot("Brightness", 80),
        moves: { up: "volume" },
        shownUnfocused: false,
      },
      below: { element: () => row("Display", 400), moves: {} },
    });
    const result = await new FocusNavigate(home, home, timer).execute({
      until: { contentDesc: "Brightness" },
      direction: "down",
    });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 1 });
    expect(home.presses).toEqual(["arrow_down"]);
  });

  test("a slider announcing its value in its own label is still undone (#18393)", async () => {
    const home: FakeSettingsColumn = new FakeSettingsColumn("volume", {
      volume: {
        element: () => ({
          "resource-id": "volume",
          class: "android.widget.SeekBar",
          "content-desc": `Volume ${home.valueOf("volume")}%`,
          focusable: true,
          "range-info": `current:${home.valueOf("volume")}.0,min:0.0,max:100.0`,
          bounds: { left: 0, top: 100, right: 1000, bottom: 200 },
        }),
        moves: { down: "done" },
        adjusts: ["left", "right"],
      },
      done: {
        element: () => ({
          text: "Done",
          focusable: true,
          bounds: { left: 1500, top: 120, right: 1700, bottom: 180 },
        }),
        moves: { up: "volume" },
      },
    });
    const result = await new FocusNavigate(home, home, timer).execute({ until: { text: "Done" } });
    expect(result).toMatchObject({ success: true, status: "focused" });
    expect(home.presses.slice(0, 2)).toEqual(["arrow_right", "arrow_left"]);
    expect(home.valueOf("volume")).toBe(50);
  });

  test("a focused scrollable container with a range child walks toward its contained target (#18393)", async () => {
    const home = new FakeSettingsColumn(
      "list",
      {
        list: {
          element: () => ({
            "resource-id": "settings_list",
            class: "androidx.recyclerview.widget.RecyclerView",
            scrollable: true,
            focusable: true,
            bounds: { left: 0, top: 0, right: 1000, bottom: 1000 },
          }),
          moves: { down: "done" },
        },
        done: { element: () => row("Done", 500), moves: { up: "list" } },
      },
      () => [
        {
          class: "android.widget.SeekBar",
          "range-info": "current:40.0,min:0.0,max:100.0",
          bounds: { left: 20, top: 160, right: 980, bottom: 180 },
        },
      ],
    );
    const result = await new FocusNavigate(home, home, timer).execute({ until: { text: "Done" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 1 });
    expect(home.presses).toEqual(["arrow_down"]);
  });
});
