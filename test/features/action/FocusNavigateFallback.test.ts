import { beforeEach, describe, expect, test } from "bun:test";
import {
  FOCUS_NAVIGATE_STALL_PRESSES,
  FocusNavigate,
  directionsWithFallbacks,
  type FocusKeyPresser,
  type FocusNavigateDirection,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { Element } from "../../../src/models/Element";
import { FakeTimer } from "../../fakes/FakeTimer";

const KEY_DIRECTIONS: Partial<Record<InputKeyName, FocusNavigateDirection>> = {
  arrow_up: "up",
  arrow_down: "down",
  arrow_left: "left",
  arrow_right: "right",
};

interface FakeNode {
  element: Element;
  moves?: Partial<Record<FocusNavigateDirection, string>>;
  /** Replaces the element when a press does not move focus off it (a slider changing value). */
  swallow?: (element: Element, direction: FocusNavigateDirection) => Element;
}

/**
 * A fake focus graph: each node lists where each arrow sends focus, and an arrow it does not list
 * leaves focus in place. `visible` decides which nodes one read shows (a scrolled list).
 */
class FakeFocusGraph implements FocusObserver, FocusKeyPresser {
  readonly presses: FocusNavigateDirection[] = [];

  constructor(
    readonly nodes: Record<string, FakeNode>,
    public focus: string,
    private readonly visible: (focus: string) => readonly string[] = () => Object.keys(nodes),
  ) {}

  async read(): Promise<FocusScreen> {
    return {
      focused: this.nodes[this.focus].element,
      elements: this.visible(this.focus).map((id) => this.nodes[id].element),
    };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    const direction = KEY_DIRECTIONS[key];
    if (!direction) {
      return { success: true };
    }
    this.presses.push(direction);
    const node = this.nodes[this.focus];
    const next = node.moves?.[direction];
    if (next) {
      this.focus = next;
    } else if (node.swallow) {
      node.element = node.swallow(node.element, direction);
    }
    return { success: true };
  }
}

function box(text: string, cx: number, cy: number): Element {
  return {
    text,
    focusable: true,
    bounds: { left: cx - 50, top: cy - 25, right: cx + 50, bottom: cy + 25 },
  };
}

const LIST_LENGTH = 40;
const LIST_SLOTS = [200, 400, 600, 800];

/**
 * Hand-built TV layout (not captured from a device): a left rail (Home, Search), a long vertical
 * list in the content area that scrolls under its last visible slot, and a bottom bar (Slides,
 * Settings) below it. Settings sits under the list, so down is always the way toward it. Down inside the list only leaves it after the last item; left from any
 * item goes to the rail, and down from the rail reaches the bottom bar.
 */
function listAboveBottomBar(): FakeFocusGraph {
  const nodes: Record<string, FakeNode> = {
    home: { element: box("Home", 100, 300), moves: { down: "search", right: "item0" } },
    search: { element: box("Search", 100, 500), moves: { up: "home", down: "slides" } },
    slides: { element: box("Slides", 200, 1000), moves: { up: "search", right: "settings" } },
    settings: { element: box("Settings", 450, 1000), moves: { left: "slides", up: "search" } },
  };
  Array.from({ length: LIST_LENGTH }, (_, index) => {
    const slot = LIST_SLOTS[Math.min(index, LIST_SLOTS.length - 1)];
    nodes[`item${index}`] = {
      element: box(`Item ${index}`, 500, slot),
      moves: {
        left: "search",
        ...(index > 0 ? { up: `item${index - 1}` } : {}),
        down: index < LIST_LENGTH - 1 ? `item${index + 1}` : "slides",
      },
    };
  });
  const statics = ["home", "search", "slides", "settings"];
  return new FakeFocusGraph(nodes, "item0", (focus) =>
    focus.startsWith("item") ? [...statics, focus] : statics,
  );
}

/**
 * Hand-built settings screen: a rail (Home, Demos) and a content column whose slider sits level
 * with Demos and consumes left/right to change its value.
 */
function sliderBesideRail(changesValue: boolean): FakeFocusGraph {
  let value = 50;
  return new FakeFocusGraph(
    {
      home: { element: box("Home", 100, 300), moves: { down: "demos", right: "brightness" } },
      demos: { element: box("Demos", 100, 500), moves: { up: "home", right: "slider" } },
      brightness: { element: box("Brightness", 900, 300), moves: { left: "home", down: "slider" } },
      slider: {
        element: box(`${value}%`, 900, 500),
        moves: { up: "brightness", down: "reset" },
        swallow: (element, direction) => {
          if (!changesValue) {
            return element;
          }
          value += direction === "right" ? 5 : -5;
          return { ...element, text: `${value}%` };
        },
      },
      reset: { element: box("Reset", 900, 700), moves: { up: "slider" } },
    },
    "slider",
  );
}

describe("FocusNavigate direction fallback (#17209)", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  const navigator = (graph: FakeFocusGraph) => new FocusNavigate(graph, graph, timer);

  test("leaves a long list for the rail once down stops closing distance to the bottom bar", async () => {
    const graph = listAboveBottomBar();
    const result = await navigator(graph).execute({ until: { text: "Settings" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 9 });
    // Three presses reach the last slot, three more only scroll the list before down stalls.
    expect(graph.presses).toEqual([
      ...Array<FocusNavigateDirection>(3 + FOCUS_NAVIGATE_STALL_PRESSES).fill("down"),
      "left",
      "down",
      "right",
    ]);
    expect(result.path.map((entry) => entry.text).slice(-3)).toEqual([
      "Search",
      "Slides",
      "Settings",
    ]);
  });

  test("an explicit direction still only presses that direction", async () => {
    const graph = listAboveBottomBar();
    const result = await navigator(graph).execute({
      until: { text: "Settings" },
      direction: "down",
      maxSteps: 12,
    });
    expect(result).toMatchObject({ success: false, status: "max_steps", steps: 12 });
    expect(new Set(graph.presses)).toEqual(new Set(["down"]));
  });

  test("goes around a slider that swallows left without moving focus", async () => {
    const graph = sliderBesideRail(false);
    const result = await navigator(graph).execute({ until: { text: "Demos" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 4 });
    expect(graph.presses).toEqual(["left", "up", "left", "down"]);
  });

  test("goes around a slider whose value changes on every left press", async () => {
    const graph = sliderBesideRail(true);
    const result = await navigator(graph).execute({ until: { text: "Demos" } });
    expect(result).toMatchObject({ success: true, status: "focused" });
    expect(graph.presses).toEqual([
      ...Array<FocusNavigateDirection>(FOCUS_NAVIGATE_STALL_PRESSES).fill("left"),
      "up",
      "left",
      "down",
    ]);
  });

  test("an unreachable target on screen ends stuck within the step budget", async () => {
    const graph = new FakeFocusGraph(
      {
        top: { element: box("Top", 500, 200), moves: { down: "bottom" } },
        bottom: { element: box("Bottom", 500, 400), moves: { up: "top" } },
        // On screen but not focusable from either button.
        banner: { element: { ...box("Banner", 500, 900), focusable: false } },
      },
      "top",
    );
    const result = await navigator(graph).execute({ until: { text: "Banner" } });
    expect(result).toMatchObject({ success: false, status: "stuck" });
    expect(result.steps).toBeLessThan(30);
    expect(result.message).toContain("Every D-pad direction from the focused element was tried");
    // Each direction is pressed at most once from each element.
    expect(graph.presses).toEqual(["down", "down", "left", "right", "up", "left", "right", "up"]);
  });

  test("a target that is not on screen scans down only, as before", async () => {
    const graph = new FakeFocusGraph(
      {
        a: { element: box("A", 500, 200), moves: { down: "b", right: "c" } },
        b: { element: box("B", 500, 400), moves: { up: "a", right: "c" } },
        c: { element: box("C", 900, 400), moves: { left: "b" } },
      },
      "a",
    );
    const result = await navigator(graph).execute({ until: { text: "Elsewhere" } });
    expect(result).toMatchObject({ success: false, status: "stuck", steps: 2 });
    expect(graph.presses).toEqual(["down", "down"]);
  });
});

describe("directionsWithFallbacks", () => {
  test("keeps the directions toward the target first, then perpendicular, then away", () => {
    expect(directionsWithFallbacks(["down"])).toEqual(["down", "left", "right", "up"]);
    expect(directionsWithFallbacks(["right", "up"])).toEqual(["right", "up", "down", "left"]);
    expect(directionsWithFallbacks(["left", "down"])).toEqual(["left", "down", "up", "right"]);
  });
});
