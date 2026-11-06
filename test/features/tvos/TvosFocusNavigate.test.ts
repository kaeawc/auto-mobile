import { beforeEach, describe, expect, test } from "bun:test";
import {
  FocusNavigate,
  type FocusKeyPresser,
  type FocusNavigateDirection,
  type FocusNavigateOptions,
  type FocusNavigateResult,
  type FocusObserver,
  type FocusScreen,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import {
  createTvosFocusKeyPresser,
  tvosFocusNavigate,
} from "../../../src/features/tvos/TvosFocusNavigate";
import type { TvosCommand, TvosRunnerClient } from "../../../src/features/tvos/TvosRunnerClient";
import { TvosRunnerRegistry } from "../../../src/features/tvos/TvosRunnerRegistry";
import type { TvosHierarchy } from "../../../src/features/tvos/TvosHierarchy";
import { SelectorDpadTargetResolver } from "../../../src/features/action/DpadTargetResolver";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { ElementBounds } from "../../../src/models/ElementBounds";
import { ActionableError } from "../../../src/models/ActionableError";
import type { Element } from "../../../src/models/Element";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FocusAwareFakeTvosRunnerClient } from "../../fakes/FocusAwareFakeTvosRunnerClient";

const targetResolver = new SelectorDpadTargetResolver(new ResolverElementSelector());

// Hand-reconstructed layout shared by both platforms: a 3x2 grid of 100px tiles.
const COLS = 3;
const ROWS = 2;
const LABELS = ["Home", "Movies", "Music", "Games", "Settings", "Search"];

function tileBounds(index: number) {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    left: 100 + col * 100,
    top: 100 + row * 100,
    right: 200 + col * 100,
    bottom: 200 + row * 100,
  };
}

/** Focus state shared by both platform fakes: arrows move within the grid unless blocked. */
class GridModel {
  focusIndex: number | null;
  /** Tiles whose entry is blocked, so a move toward them leaves focus in place. */
  readonly blocked = new Set<number>();
  readonly moves: FocusNavigateDirection[] = [];
  /** Tiles that were focused when select (enter on Android TV) was pressed. */
  readonly selections: string[] = [];

  constructor(start: number | null) {
    this.focusIndex = start;
  }

  select(): void {
    this.selections.push(this.focusIndex === null ? "none" : LABELS[this.focusIndex]);
  }

  move(direction: FocusNavigateDirection): void {
    this.moves.push(direction);
    if (this.focusIndex === null) {
      this.focusIndex = 0;
      return;
    }
    const col = this.focusIndex % COLS;
    const row = Math.floor(this.focusIndex / COLS);
    const [nextCol, nextRow] = {
      left: [col - 1, row],
      right: [col + 1, row],
      up: [col, row - 1],
      down: [col, row + 1],
    }[direction];
    const next = nextRow * COLS + nextCol;
    if (
      nextCol >= 0 &&
      nextCol < COLS &&
      nextRow >= 0 &&
      nextRow < ROWS &&
      !this.blocked.has(next)
    ) {
      this.focusIndex = next;
    }
  }
}

const ARROWS: Partial<Record<InputKeyName, FocusNavigateDirection>> = {
  arrow_up: "up",
  arrow_down: "down",
  arrow_left: "left",
  arrow_right: "right",
};

/** Android TV: an observer and D-pad presser over the grid. */
class AndroidGrid implements FocusObserver, FocusKeyPresser {
  constructor(private readonly grid: GridModel) {}

  async read(): Promise<FocusScreen> {
    const elements: Element[] = LABELS.map((text, index) => ({
      bounds: tileBounds(index),
      text,
      "resource-id": `app:id/tile_${index}`,
    }));
    const focused = this.grid.focusIndex === null ? null : elements[this.grid.focusIndex];
    return { focused, elements };
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    if (key === "enter") {
      this.grid.select();
      return { success: true };
    }
    this.grid.move(ARROWS[key]!);
    return { success: true };
  }
}

/** Apple TV: a runner that serves the grid as a tvOS hierarchy and moves on remote presses. */
class TvosGridRunner implements TvosRunnerClient {
  readonly commands: TvosCommand[] = [];

  constructor(private readonly grid: GridModel) {}

  isUsable(): boolean {
    return true;
  }

  async request(command: TvosCommand, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    this.commands.push(command);
    if (command.type === "request_press_button" && command.action === "select") {
      this.grid.select();
    } else if (command.type === "request_press_button") {
      this.grid.move(command.action as FocusNavigateDirection);
    }
    return command.type === "request_hierarchy" ? this.snapshot() : undefined;
  }

  async hierarchy(signal?: AbortSignal): Promise<TvosHierarchy> {
    return (await this.request({ type: "request_hierarchy" }, signal)) as TvosHierarchy;
  }

  close(): void {}

  private snapshot(): TvosHierarchy {
    return {
      hierarchy: {
        className: "Window",
        bounds: { left: 0, top: 0, right: 1920, bottom: 1080 },
        node: LABELS.map((text, index) => ({
          className: "Button",
          bounds: tileBounds(index),
          text,
          "resource-id": `tile_${index}`,
          focused: index === this.grid.focusIndex ? "true" : "false",
        })),
      },
      updatedAt: 1,
      packageName: "com.example.tv",
      screenWidth: 1920,
      screenHeight: 1080,
    } as TvosHierarchy;
  }
}

interface Harness {
  grid: GridModel;
  run(options: FocusNavigateOptions): Promise<FocusNavigateResult>;
}

const PLATFORMS: Array<[string, (grid: GridModel, timer: FakeTimer) => Harness]> = [
  [
    "Android TV",
    (grid, timer) => {
      const fake = new AndroidGrid(grid);
      return { grid, run: (options) => new FocusNavigate(fake, fake, timer).execute(options) };
    },
  ],
  [
    "tvOS",
    (grid, timer) => {
      const runners = new TvosRunnerRegistry();
      runners.register("apple-tv", new TvosGridRunner(grid));
      return { grid, run: (options) => tvosFocusNavigate("apple-tv", options, timer, runners) };
    },
  ],
];

describe.each(PLATFORMS)("focusNavigate contract on %s", (_platform, create) => {
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
  });

  const harness = (start: number | null) => create(new GridModel(start), timer);
  const texts = (result: FocusNavigateResult) => result.path.map((entry) => entry.text);

  test("returns focused with no presses when focus already matches", async () => {
    const { grid, run } = harness(1);
    const result = await run({ until: { text: "movies" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 0 });
    expect(texts(result)).toEqual(["Movies"]);
    expect(grid.moves).toEqual([]);
  });

  test("steers toward the target, re-reading focus after every press", async () => {
    const { grid, run } = harness(0);
    const result = await run({ until: { resourceId: "tile_5" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 3 });
    expect(grid.moves).toEqual(["right", "down", "right"]);
    expect(texts(result)).toEqual(["Home", "Movies", "Settings", "Search"]);
    expect(result.focusedElement?.text).toBe("Search");
  });

  test("an explicit direction overrides steering", async () => {
    const { grid, run } = harness(0);
    const result = await run({ until: { text: "Music" }, direction: "right" });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 2 });
    expect(grid.moves).toEqual(["right", "right"]);
  });

  test("presses down to land focus when nothing is focused", async () => {
    const { grid, run } = harness(null);
    const result = await run({ until: { text: "Home" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 1 });
    expect(grid.moves).toEqual(["down"]);
  });

  test("tries the other axis when the best direction does not move focus", async () => {
    const { grid, run } = harness(0);
    grid.blocked.add(3);
    const result = await run({ until: { text: "Settings" } });
    expect(result).toMatchObject({ success: true, status: "focused" });
    expect(grid.moves).toEqual(["down", "right", "down"]);
  });

  test("escapes around a blocked direction through the other arrows", async () => {
    const { grid, run } = harness(0);
    grid.blocked.add(1);
    const result = await run({ until: { text: "Music" } });
    expect(result).toMatchObject({ success: true, status: "focused" });
    expect(grid.moves[0]).toBe("right");
  });

  test("ends stuck when every arrow from the focused element leaves focus unchanged", async () => {
    const { grid, run } = harness(0);
    grid.blocked.add(1);
    grid.blocked.add(3);
    const result = await run({ until: { text: "Music" } });
    expect(result).toMatchObject({ success: false, status: "stuck", steps: 4 });
    expect([...grid.moves].sort()).toEqual(["down", "left", "right", "up"]);
    expect(result.focusedElement?.text).toBe("Home");
    expect(result.message).toContain("Observe before retrying");
  });

  test("an explicit direction ends stuck after two unmoved presses", async () => {
    const { grid, run } = harness(0);
    const result = await run({ until: { text: "Search" }, direction: "left" });
    expect(result).toMatchObject({ success: false, status: "stuck", steps: 2 });
    expect(grid.moves).toEqual(["left", "left"]);
  });

  test("ends max_steps when the budget runs out", async () => {
    const { grid, run } = harness(0);
    const result = await run({ until: { text: "Search" }, maxSteps: 1 });
    expect(result).toMatchObject({ success: false, status: "max_steps", steps: 1 });
    expect(result.message).toContain("Reached maxSteps (1)");
    expect(grid.moves).toEqual(["right"]);
  });

  test("settles between presses", async () => {
    const { run } = harness(0);
    await run({ until: { text: "Music" }, settleMs: 50 });
    expect(timer.getSleepHistory()).toEqual([50, 50]);
  });

  test("rejects an empty target without pressing", async () => {
    const { grid, run } = harness(0);
    await expect(run({ until: {} })).rejects.toBeInstanceOf(ActionableError);
    expect(grid.moves).toEqual([]);
  });

  test("with select, presses select once the target is focused", async () => {
    const { grid, run } = harness(0);
    const result = await run({ until: { text: "Search" }, select: true });
    expect(result).toMatchObject({ success: true, status: "focused", selected: true });
    expect(grid.selections).toEqual(["Search"]);
  });

  test("with select, a failed walk does not press select", async () => {
    const { grid, run } = harness(0);
    const result = await run({ until: { text: "Search" }, maxSteps: 1, select: true });
    expect(result).toMatchObject({ success: false, status: "max_steps", selected: false });
    expect(grid.selections).toEqual([]);
  });

  test("without select, focus lands and nothing is selected", async () => {
    const { grid, run } = harness(0);
    const result = await run({ until: { text: "Search" } });
    expect(result.success).toBe(true);
    expect(result.selected).toBeUndefined();
    expect(grid.selections).toEqual([]);
  });

  test("an aborted signal stops before pressing", async () => {
    const { grid, run } = harness(0);
    const controller = new AbortController();
    controller.abort();
    await expect(run({ until: { text: "Search" }, signal: controller.signal })).rejects.toThrow();
    expect(grid.moves).toEqual([]);
  });
});

describe("tvOS focusNavigate over the captured runner hierarchy", () => {
  const hierarchy: TvosCommand = { type: "request_hierarchy" };
  const press = (action: FocusNavigateDirection): TvosCommand => ({
    type: "request_press_button",
    action,
  });

  function arrange(client: FocusAwareFakeTvosRunnerClient) {
    const runners = new TvosRunnerRegistry();
    runners.register("apple-tv", client);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    return (options: FocusNavigateOptions) =>
      tvosFocusNavigate("apple-tv", options, timer, runners);
  }

  test("reads the hierarchy after each remote press and stops on the target", async () => {
    const client = new FocusAwareFakeTvosRunnerClient();
    const result = await arrange(client)({ until: { resourceId: "B21" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 2 });
    expect(client.commands).toEqual([
      hierarchy,
      press("down"),
      hierarchy,
      press("down"),
      hierarchy,
    ]);
    expect(result.path.map((entry) => entry.resourceId)).toEqual(["B01", "B11", "B21"]);
  });

  test("follows where focus actually lands when the focus engine remembers a column", async () => {
    const client = new FocusAwareFakeTvosRunnerClient();
    // The first down lands on the remembered B12 instead of the geometric neighbour B11.
    client.afterPress = () => {
      client.focus("B12");
      client.afterPress = undefined;
    };
    const result = await arrange(client)({ until: { resourceId: "B22" } });
    expect(result).toMatchObject({ success: true, status: "focused", steps: 2 });
    expect(result.path.map((entry) => entry.resourceId)).toEqual(["B01", "B12", "B22"]);
    expect(client.commands).toEqual([
      hierarchy,
      press("down"),
      hierarchy,
      press("down"),
      hierarchy,
    ]);
  });

  test("reports stuck in a focus trap", async () => {
    const client = new FocusAwareFakeTvosRunnerClient();
    client.ignorePresses = true;
    const result = await arrange(client)({ until: { resourceId: "B22" } });
    expect(result).toMatchObject({ success: false, status: "stuck", steps: 4 });
    // Every remote direction is tried once, each followed by a fresh hierarchy read.
    expect(client.commands.filter((_, index) => index % 2 === 0)).toEqual(Array(5).fill(hierarchy));
    const pressed = client.commands
      .filter((command) => command.type === "request_press_button")
      .map((command) => command.action);
    expect(pressed.slice(0, 2)).toEqual(["down", "right"]);
    expect([...pressed].sort()).toEqual(["down", "left", "right", "up"]);
  });

  test("requires a connected runner", async () => {
    const timer = new FakeTimer();
    await expect(
      tvosFocusNavigate("apple-tv", { until: { text: "B01" } }, timer, new TvosRunnerRegistry()),
    ).rejects.toThrow("Start and connect the tvos XCUITest runner");
  });

  test("pins a label target to the element tapOn would tap on the runner hierarchy", async () => {
    const client = new FocusAwareFakeTvosRunnerClient();
    const pinned: Array<ElementBounds | null | undefined> = [];
    const result = await arrange(client)({
      until: { label: "B21" },
      firstMatch: true,
      pinTarget: (screen) => {
        const bounds = screen.hierarchy
          ? targetResolver.resolve(screen, { label: "B21" })
          : undefined;
        pinned.push(bounds);
        return bounds;
      },
    });
    expect(result).toMatchObject({ success: true, status: "focused" });
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.every((bounds) => bounds !== undefined && bounds !== null)).toBe(true);
  });

  test("the remote presser sends enter as the select button", async () => {
    const commands: TvosCommand[] = [];
    const presser = createTvosFocusKeyPresser({
      request: async (command) => {
        commands.push(command);
        return undefined;
      },
    });
    expect(await presser.press("enter")).toEqual({ success: true });
    expect(commands).toEqual([{ type: "request_press_button", action: "select" }]);
  });

  test("the remote presser refuses keys that are not directions or select", async () => {
    const commands: TvosCommand[] = [];
    const presser = createTvosFocusKeyPresser({
      request: async (command) => {
        commands.push(command);
        return undefined;
      },
    });
    expect(await presser.press("tab")).toEqual({
      success: false,
      error: "tvOS focusNavigate cannot press tab.",
    });
    expect(commands).toEqual([]);
  });
});
