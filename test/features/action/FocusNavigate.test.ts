import { beforeEach, describe, expect, test } from "bun:test";
import {
  FocusNavigate,
  directionToward,
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

  constructor(start: number | null) {
    this.focusIndex = start;
  }

  async read(): Promise<FocusScreen> {
    return {
      focused: this.focusIndex === null ? null : tile(this.focusIndex),
      elements: LABELS.map((_, index) => tile(index)),
    };
  }

  async press(key: InputKeyName): Promise<{ success: boolean; error?: string }> {
    if (this.failPress) {
      return { success: false, error: this.failPress };
    }
    this.presses.push(key);
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

  test("exits stuck after two presses leave focus unchanged", async () => {
    const grid = new FakeGrid(0);
    grid.blocked.add(1);
    const result = await navigator(grid).execute({ until: { text: "Music" } });
    expect(result).toMatchObject({ success: false, status: "stuck", steps: 2 });
    expect(result.focusedElement?.text).toBe("Home");
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
