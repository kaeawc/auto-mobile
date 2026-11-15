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
}

class FakeSettingsColumn implements FocusObserver, FocusKeyPresser {
  readonly presses: InputKeyName[] = [];
  value = 50;
  valuePresses = 0;

  constructor(
    public focus: string,
    private readonly nodes: Record<string, Node>,
    private readonly extras: () => Element[] = () => [],
  ) {}

  async read(): Promise<FocusScreen> {
    return {
      focused: this.nodes[this.focus].element(),
      elements: [...Object.values(this.nodes).map((node) => node.element()), ...this.extras()],
    };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.presses.push(key);
    const direction = KEY_DIRECTIONS[key];
    const node = this.nodes[this.focus];
    if (!direction) {
      return { success: true };
    }
    if (node.adjusts?.includes(direction)) {
      this.valuePresses += 1;
      this.value += direction === "right" || direction === "up" ? 1 : -1;
      return { success: true };
    }
    this.focus = node.moves[direction] ?? this.focus;
    return { success: true };
  }
}

function row(text: string, top: number): Element {
  return { text, focusable: true, clickable: true, bounds: { left: 0, top, right: 1000, bottom: top + 100 } };
}

describe("FocusNavigate around range controls (#17209)", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  test("a focused row holding a progress bar is walked past with arrows", async () => {
    // The row itself reports no range; only the smaller ProgressBar inside it does.
    const home = new FakeSettingsColumn("storage", {
      storage: { element: () => row("Storage", 100), moves: { down: "about" } },
      about: { element: () => row("About", 200), moves: { up: "storage", down: "done" } },
      done: { element: () => row("Done", 300), moves: { up: "about" } },
    }, () => [
      {
        class: "android.widget.ProgressBar",
        "range-info": "current:40.0,min:0.0,max:100.0",
        bounds: { left: 20, top: 160, right: 980, bottom: 180 },
      },
    ]);
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
      "range-info": `current:${home.value}.0,min:0.0,max:100.0`,
      bounds: { left: 0, top: 100, right: 1000, bottom: 200 },
    });
    const home: FakeSettingsColumn = new FakeSettingsColumn(
      "volume",
      {
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
      },
    );
    const result = await new FocusNavigate(home, home, timer).execute({ until: { text: "Done" } });
    expect(result).toMatchObject({ success: true, status: "focused" });
    expect(home.presses).toContain("arrow_down");
    expect(home.presses).not.toContain("tab");
    expect(home.value).toBe(50);
    expect(home.presses.slice(0, 2)).toEqual(["arrow_right", "arrow_left"]);
  });
});
