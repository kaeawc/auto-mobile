import { beforeEach, describe, expect, test } from "bun:test";
import {
  FocusNavigate,
  directionToward,
  directionsToward,
  elementMatchesTarget,
  type FocusKeyPresser,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { Element } from "../../../src/models/Element";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hand-reconstructed layout (not captured from a TV image): a 2x3 grid of 100px tiles.
const COLS = 3;
const ROWS = 2;
const LABELS = ["Home", "Movies", "Music", "Games", "Settings", "Search"];

function tile(index: number): Element {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    bounds: { left: col * 100, top: row * 100, right: col * 100 + 100, bottom: row * 100 + 100 },
    text: LABELS[index],
    "resource-id": `app:id/tile_${index}`,
  };
}

/** A fake D-pad grid: arrows move focus within bounds, and blocked moves leave it in place. */
class FakeGrid implements FocusObserver, FocusKeyPresser {
  focusIndex: number | null;
  readonly presses: InputKeyName[] = [];
  failPress: string | undefined;
  /** Indices whose entry is blocked, so a press toward them leaves focus unchanged. */
  blocked = new Set<number>();
  /** Custom layout: replaces the grid, with explicit per-element key transitions. */
  elements: Element[] = LABELS.map((_, index) => tile(index));
  moves: Record<number, Partial<Record<InputKeyName, number>>> | undefined;

  constructor(start: number | null) {
    this.focusIndex = start;
  }

  async read(): Promise<FocusScreen> {
    return {
      focused: this.focusIndex === null ? null : (this.elements[this.focusIndex] ?? null),
      elements: this.elements,
    };
  }

  async press(key: InputKeyName): Promise<{ success: boolean; error?: string }> {
    if (this.failPress) {
      return { success: false, error: this.failPress };
    }
    this.presses.push(key);
    if (this.moves && this.focusIndex !== null) {
      this.focusIndex = this.moves[this.focusIndex]?.[key] ?? this.focusIndex;
      return { success: true };
    }
    if (this.focusIndex === null) {
      this.focusIndex = 0;
      return { success: true };
    }
    const col = this.focusIndex % COLS;
    const row = Math.floor(this.focusIndex / COLS);
    const next = {
      arrow_left: [col - 1, row],
      arrow_right: [col + 1, row],
      arrow_up: [col, row - 1],
      arrow_down: [col, row + 1],
    }[key as "arrow_left"] ?? [col, row];
    const [nextCol, nextRow] = next;
    const inBounds = nextCol >= 0 && nextCol < COLS && nextRow >= 0 && nextRow < ROWS;
    const nextIndex = nextRow * COLS + nextCol;
    if (inBounds && !this.blocked.has(nextIndex)) {
      this.focusIndex = nextIndex;
    }
    return { success: true };
  }
}

describe("FocusNavigate", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  const navigator = (grid: FakeGrid) => new FocusNavigate(grid, grid, timer);

  test("returns focused with no presses when focus already matches", async () => {
    const grid = new FakeGrid(1);
    const result = await navigator(grid).execute({ until: { text: "movies" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 0 });
    expect(grid.presses).toEqual([]);
    expect(result.path).toHaveLength(1);
  });

  test("recognises the inline TV Settings child label without pressing keys", async () => {
    const grid = new FakeGrid(0);
    grid.elements = [
      {
        class: "android.widget.LinearLayout",
        "resource-id": "generated:id/row_42",
        clickable: true,
        focusable: true,
        focused: true,
        bounds: { left: 1200, top: 724, right: 1920, bottom: 820 },
      },
      {
        class: "android.widget.TextView",
        text: "Device Preferences",
        bounds: { left: 1240, top: 740, right: 1700, bottom: 800 },
      },
    ];
    grid.moves = { 0: {} };
    const result = await navigator(grid).execute({ until: { text: "Device Preferences" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 0 });
    expect(grid.presses).toEqual([]);
    expect(result.path).toEqual([
      {
        resourceId: "generated:id/row_42",
        bounds: grid.elements[0].bounds,
        descendantLabel: "Device Preferences",
      },
    ]);
    expect(result.focusedElement).toEqual(result.path[0]);
  });

  test.each([
    [{ contentDesc: "CLICK TO SPEAK" }, { "content-desc": "Click to speak" }, "Click to speak"],
    [{ resourceId: "mic_label" }, { "resource-id": "app:id/mic_label" }, "app:id/mic_label"],
  ])(
    "recognises a contained label using direct match semantics: %j",
    async (until, label, expected) => {
      const grid = new FakeGrid(0);
      grid.elements = [
        {
          "resource-id": "com.google.android.tvlauncher:id/mic_orb",
          bounds: { left: 100, top: 100, right: 300, bottom: 300 },
        },
        { ...label, bounds: { left: 120, top: 120, right: 280, bottom: 280 } },
      ];
      grid.moves = { 0: {} };
      const result = await navigator(grid).execute({ until });
      expect(result).toMatchObject({ success: true, status: "focused", steps: 0 });
      expect(result.path[0]).toMatchObject({ descendantLabel: expected });
      expect(result.focusedElement).toEqual(result.path[0]);
      expect(grid.presses).toEqual([]);
    },
  );

  test("does not count a sibling label outside the focused row", async () => {
    const grid = new FakeGrid(0);
    grid.elements = [
      { bounds: { left: 1200, top: 724, right: 1920, bottom: 820 } },
      { text: "Device Preferences", bounds: { left: 1240, top: 740, right: 1700, bottom: 800 } },
      { text: "Network", bounds: { left: 1240, top: 840, right: 1700, bottom: 900 } },
    ];
    grid.moves = { 0: {} };
    const result = await navigator(grid).execute({ until: { text: "Network" }, maxSteps: 0 });
    expect(result).toMatchObject({ success: false, status: "max_steps", steps: 0 });
    expect(grid.presses).toEqual([]);
  });

  test("requires every target field on the same contained node", async () => {
    const grid = new FakeGrid(0);
    grid.elements = [
      { bounds: { left: 100, top: 100, right: 300, bottom: 300 } },
      { text: "Speak", bounds: { left: 120, top: 120, right: 200, bottom: 160 } },
      {
        "resource-id": "app:id/mic_label",
        bounds: { left: 120, top: 170, right: 200, bottom: 210 },
      },
    ];
    const result = await navigator(grid).execute({
      until: { text: "Speak", resourceId: "mic_label" },
      maxSteps: 0,
    });
    expect(result.status).toBe("max_steps");
  });

  test("steers toward the nearest match and reports the path", async () => {
    const grid = new FakeGrid(0);
    const result = await navigator(grid).execute({ until: { text: "Search" } });
    expect(result.status).toBe("focused");
    expect(result.focusedElement?.text).toBe("Search");
    expect(result.steps).toBe(grid.presses.length);
    expect(result.path.map((entry) => entry.text)).toEqual([
      "Home",
      "Movies",
      "Settings",
      "Search",
    ]);
    expect(grid.presses[0]).toBe("arrow_right");
  });

  test("an explicit direction overrides steering", async () => {
    const grid = new FakeGrid(0);
    const result = await navigator(grid).execute({ until: { text: "Games" }, direction: "down" });
    expect(result.status).toBe("focused");
    expect(grid.presses).toEqual(["arrow_down"]);
  });

  test("presses down to land focus when nothing is focused", async () => {
    const grid = new FakeGrid(null);
    const result = await navigator(grid).execute({ until: { resourceId: "tile_0" } });
    expect(result).toMatchObject({ status: "focused", steps: 1 });
    expect(grid.presses).toEqual(["arrow_down"]);
  });

  test("exits stuck once the only direction toward the target did not move focus", async () => {
    const grid = new FakeGrid(0);
    grid.blocked.add(1);
    const result = await navigator(grid).execute({ until: { text: "Music" } });
    expect(result).toMatchObject({ success: false, status: "stuck", steps: 1 });
    expect(result.message).toContain("Focus did not move after 1 press;");
    expect(result.focusedElement?.text).toBe("Home");
  });

  test("an explicit direction still exits stuck after two unmoved presses", async () => {
    const grid = new FakeGrid(0);
    grid.blocked.add(1);
    const result = await navigator(grid).execute({ until: { text: "Music" }, direction: "right" });
    expect(result).toMatchObject({ status: "stuck", steps: 2 });
    expect(grid.presses).toEqual(["arrow_right", "arrow_right"]);
  });

  test("steering sequence for a reachable grid target is unchanged", async () => {
    const grid = new FakeGrid(0);
    await navigator(grid).execute({ until: { text: "Search" } });
    expect(grid.presses).toEqual(["arrow_right", "arrow_down", "arrow_right"]);
  });

  test("exits max_steps when focus keeps moving without reaching the target", async () => {
    const grid = new FakeGrid(0);
    const result = await navigator(grid).execute({
      until: { text: "Nowhere" },
      direction: "right",
      maxSteps: 2,
    });
    expect(result).toMatchObject({ success: false, status: "max_steps", steps: 2 });
    expect(result.path.map((entry) => entry.text)).toEqual(["Home", "Movies", "Music"]);
  });

  test("an unmatchable target on a short row ends stuck before max_steps", async () => {
    const grid = new FakeGrid(0);
    const result = await navigator(grid).execute({
      until: { text: "Nowhere" },
      direction: "right",
    });
    expect(result.status).toBe("stuck");
  });

  test("settles between presses", async () => {
    const grid = new FakeGrid(0);
    await navigator(grid).execute({ until: { text: "Movies" }, settleMs: 321 });
    expect(timer.getSleepHistory()).toEqual([321]);
  });

  test("a failed key press throws an actionable error", async () => {
    const grid = new FakeGrid(0);
    grid.failPress = "adb offline";
    await expect(navigator(grid).execute({ until: { text: "Music" } })).rejects.toThrow(
      "adb offline",
    );
  });

  test("rejects an empty target", async () => {
    await expect(navigator(new FakeGrid(0)).execute({ until: {} })).rejects.toThrow(
      "requires until.text",
    );
  });

  test("an aborted signal stops before observing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      navigator(new FakeGrid(0)).execute({ until: { text: "Music" }, signal: controller.signal }),
    ).rejects.toThrow();
  });
});

function box(text: string, cx: number, cy: number): Element {
  return { text, bounds: { left: cx - 50, top: cy - 25, right: cx + 50, bottom: cy + 25 } };
}

/**
 * TV launcher Home (#15958): focus starts on a one-item row. The target is far right and a little
 * up, so right is a dead end and only up leaves the row.
 */
function launcherGrid(): FakeGrid {
  const grid = new FakeGrid(0);
  grid.elements = [
    box("Add app to favorites", 100, 450),
    box("Search", 300, 270),
    box("Home", 900, 270),
    { ...box("Settings, button", 1600, 270), "content-desc": "Settings, button" },
  ];
  grid.moves = {
    0: { arrow_up: 1 },
    1: { arrow_right: 2, arrow_down: 0 },
    2: { arrow_right: 3, arrow_left: 1 },
    3: { arrow_left: 2 },
  };
  return grid;
}

describe("FocusNavigate blocked directions", () => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  const navigator = (grid: FakeGrid) => new FocusNavigate(grid, grid, timer);

  test("tries up after right is a dead end, then reaches the target", async () => {
    const grid = launcherGrid();
    const result = await navigator(grid).execute({ until: { contentDesc: "Settings, button" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 4 });
    expect(grid.presses).toEqual(["arrow_right", "arrow_up", "arrow_right", "arrow_right"]);
    expect(result.steps).toBe(grid.presses.length);
  });

  test("reports stuck when every direction toward the target is blocked", async () => {
    const grid = launcherGrid();
    grid.moves = { 0: {} };
    const result = await navigator(grid).execute({ until: { text: "Settings, button" } });
    expect(result).toMatchObject({ success: false, status: "stuck", steps: 2 });
    expect(grid.presses).toEqual(["arrow_right", "arrow_up"]);
    expect(result.message).toContain("Focus did not move after 2 presses;");
    expect(result.focusedElement?.text).toBe("Add app to favorites");
  });

  test("blocked directions reset once focus moves to another element", async () => {
    const grid = launcherGrid();
    // Right is blocked on the first element and must be retried on the next one.
    grid.moves = { 0: { arrow_up: 1 }, 1: { arrow_right: 3 }, 3: {} };
    const result = await navigator(grid).execute({ until: { text: "Settings, button" } });
    expect(result.status).toBe("focused");
    expect(grid.presses).toEqual(["arrow_right", "arrow_up", "arrow_right"]);
  });

  test("remembers a dead direction when returning to the same focused element", async () => {
    const grid = launcherGrid();
    grid.moves = { 0: { arrow_up: 1 }, 1: { arrow_right: 0 } };
    const result = await navigator(grid).execute({
      until: { text: "Settings, button" },
      maxSteps: 4,
    });
    expect(grid.presses).toEqual(["arrow_right", "arrow_up", "arrow_right", "arrow_up"]);
    expect(result).toEqual({
      success: false,
      status: "max_steps",
      steps: 4,
      path: [grid.elements[0], grid.elements[1], grid.elements[0], grid.elements[1]],
      focusedElement: grid.elements[1],
      message: "Reached maxSteps (4); the target was not focused. Observe before retrying.",
    });
  });

  test("blocked-direction retries count against maxSteps", async () => {
    const grid = new FakeGrid(0);
    grid.elements = [box("Low", 50, 450), box("High", 50, 50), box("Target", 1050, 250)];
    grid.moves = { 0: { arrow_up: 1 }, 1: { arrow_down: 0 } };
    const result = await navigator(grid).execute({ until: { text: "Target" }, maxSteps: 6 });
    expect(result).toMatchObject({ status: "max_steps", steps: 6 });
    expect(grid.presses).toHaveLength(6);
  });
});

describe("directionsToward", () => {
  test("ranks the dominant axis first and omits axes with no offset", () => {
    expect(directionsToward(tile(0), [tile(5)])).toEqual(["right", "down"]);
    expect(directionsToward(tile(0), [tile(2)])).toEqual(["right"]);
    expect(directionsToward(null, [tile(2)])).toEqual(["down"]);
  });
});

describe("directionToward", () => {
  test("picks the dominant axis toward the nearest match", () => {
    expect(directionToward(tile(4), [tile(1)])).toBe("up");
    expect(directionToward(tile(0), [tile(2)])).toBe("right");
    expect(directionToward(tile(2), [tile(0), tile(5)])).toBe("down");
    expect(directionToward(tile(2), [tile(1)])).toBe("left");
  });

  test("defaults to down without a focus or a match", () => {
    expect(directionToward(null, [tile(1)])).toBe("down");
    expect(directionToward(tile(0), [])).toBe("down");
  });
});

describe("elementMatchesTarget", () => {
  test("matches resource ids exactly or by id suffix, and text case-insensitively", () => {
    expect(elementMatchesTarget(tile(1), { resourceId: "app:id/tile_1" })).toBe(true);
    expect(elementMatchesTarget(tile(1), { resourceId: "tile_1" })).toBe(true);
    expect(elementMatchesTarget(tile(1), { resourceId: "tile_2" })).toBe(false);
    expect(elementMatchesTarget(tile(1), { text: "MOV" })).toBe(true);
    expect(elementMatchesTarget(tile(1), { text: "Movies", resourceId: "tile_2" })).toBe(false);
  });
});
