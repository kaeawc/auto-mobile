import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FocusNavigate, type FocusKeyPresser } from "../../../src/features/action/FocusNavigate";
import { createFocusNavigateObserver } from "../../../src/features/action/FocusNavigateObserver";
import type { InputKeyName } from "../../../src/features/action/InputKey";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeTimer } from "../../fakes/FakeTimer";

function capture(name: string): ViewHierarchyResult {
  return (
    JSON.parse(
      readFileSync(
        new URL(`../../fixtures/android-focus/leanback-${name}.json`, import.meta.url),
        "utf8",
      ),
    ) as { viewHierarchy: ViewHierarchyResult }
  ).viewHierarchy;
}

const headers = capture("headers-pane-focused");
const content = capture("row-content-focused");

type Node = Record<string, unknown>;

function eachNode(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => eachNode(child, visit));
    return;
  }
  if (node && typeof node === "object") {
    const record = node as Node;
    visit(record);
    eachNode(record.node, visit);
    eachNode(record.children, visit);
  }
}

/** The captured headers pane with only the focus flag moved to header `index` (D-pad down). */
function headersFocusedAt(source: ViewHierarchyResult, index: number): ViewHierarchyResult {
  const copy = structuredClone(source);
  let header = 0;
  eachNode(copy.hierarchy, (node) => {
    if (String(node["resource-id"]).endsWith(":id/row_header")) {
      if (header === index) {
        node.focused = "true";
      } else {
        delete node.focused;
      }
      header += 1;
    }
  });
  return copy;
}

/** The captured headers pane with its `browse_headers*` container ids renamed, nothing else. */
function withoutLeanbackContainers(source: ViewHierarchyResult): ViewHierarchyResult {
  return JSON.parse(
    JSON.stringify(source).replaceAll(":id/browse_headers", ":id/side_menu"),
  ) as ViewHierarchyResult;
}

/** The captured headers pane with its headers grid marked scrollable (more headers below). */
function withScrollableHeaders(source: ViewHierarchyResult): ViewHierarchyResult {
  const copy = structuredClone(source);
  eachNode(copy.hierarchy, (node) => {
    if (String(node["resource-id"]).endsWith(":id/browse_headers")) {
      node.scrollable = "true";
    }
  });
  return copy;
}

const HEADER_COUNT = 3;

/**
 * Captured screens only: down moves focus to the next of the three captured headers and is
 * refused on the last; RIGHT enters the row, whose first card then retains focus.
 */
class LeanbackDevice implements Pick<ObserveScreen, "execute">, FocusKeyPresser {
  readonly keys: InputKeyName[] = [];
  private header = 0;
  private entered = false;

  constructor(
    private readonly canEnter = true,
    private readonly pane: ViewHierarchyResult = headers,
  ) {}

  async execute(): Promise<ObserveResult> {
    const viewHierarchy = this.entered ? content : headersFocusedAt(this.pane, this.header);
    return { viewHierarchy } as ObserveResult;
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.keys.push(key);
    if (this.entered) {
      return { success: true };
    }
    if (key === "arrow_right" && this.canEnter) {
      this.entered = true;
    } else if (key === "arrow_down" && this.header < HEADER_COUNT - 1) {
      this.header += 1;
    }
    return { success: true };
  }
}

function harness(canEnter = true, pane: ViewHierarchyResult = headers) {
  const device = new LeanbackDevice(canEnter, pane);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observer = createFocusNavigateObserver(device);
  return { device, timer, observer, navigator: new FocusNavigate(observer, device, timer) };
}

/** Move only focus in the real content capture; the transient grid also shifts left to 100. */
function contentFocusedAt(label?: string, scrollable = true): ViewHierarchyResult {
  const copy = structuredClone(content);
  eachNode(copy.hierarchy, (node) => {
    delete node.focused;
    if (String(node["resource-id"]).endsWith(":id/container_list")) {
      node.scrollable = String(scrollable);
      if (!label) {
        node.focused = "true";
        node.bounds = [100, 0, 1920, 1080];
      }
    }
    if (label && node.clickable === "true") {
      eachNode(node.node, (child) => {
        if (child.text === label) {
          node.focused = "true";
        }
      });
    }
  });
  return copy;
}

/** RIGHT enters through a transient grid; later keys move among captured cards and rows. */
class LeanbackRowEntry implements Pick<ObserveScreen, "execute">, FocusKeyPresser {
  readonly keys: InputKeyName[] = [];
  readonly selected: string[] = [];
  private entered = false;
  private row = "Featured";
  private column = 1;
  private remainingTransientReads: number;

  constructor(transientReads = 1) {
    this.remainingTransientReads = transientReads;
  }

  async execute(): Promise<ObserveResult> {
    let viewHierarchy = headers;
    if (this.entered) {
      viewHierarchy =
        this.remainingTransientReads-- > 0 ? contentFocusedAt() : contentFocusedAt(this.label);
    }
    return { viewHierarchy } as ObserveResult;
  }

  private get label(): string {
    return `${this.row} ${String(this.column).padStart(2, "0")}`;
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.keys.push(key);
    if (!this.entered && key === "arrow_right") {
      this.entered = true;
    } else if (this.entered && this.remainingTransientReads <= 0) {
      if (key === "arrow_right") {
        this.column = Math.min(5, this.column + 1);
      }
      if (key === "arrow_left") {
        this.column = Math.max(1, this.column - 1);
      }
      if (key === "arrow_down") {
        this.row = "Movies";
      }
      if (key === "arrow_up") {
        this.row = "Featured";
      }
      if (key === "enter") {
        this.selected.push(this.label);
      }
    }
    return { success: true };
  }
}

describe("FocusNavigate Leanback row entry (#17563)", () => {
  test.each([true, false])(
    "a focused grid cannot borrow a card label (scrollable: %s)",
    async (scrollable) => {
      const device = {
        execute: async () =>
          ({ viewHierarchy: contentFocusedAt(undefined, scrollable) }) as ObserveResult,
        press: async () => ({ success: true }),
      };
      const result = await new FocusNavigate(
        createFocusNavigateObserver(device),
        device,
        new FakeTimer(),
      ).execute({ until: { text: "Featured 02" }, maxSteps: 0, select: true });
      expect(result).toMatchObject({ status: "max_steps", success: false, selected: false });
      expect(result.focusedElement?.resourceId).toEndWith(":id/container_list");
    },
  );

  test.each([
    ["Featured 01", 1, ["arrow_right"]],
    ["Featured 02", 1, ["arrow_right", "arrow_right"]],
    ["Featured 05", 1, Array(5).fill("arrow_right")],
    ["Movies 04", 1, ["arrow_right", "arrow_down", "arrow_right", "arrow_right", "arrow_right"]],
    ["Featured 02", 10, undefined],
  ] as const)(
    "reaches the %s card after %i transient reads before selecting",
    async (label, reads, keys) => {
      const device = new LeanbackRowEntry(reads);
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const observer = createFocusNavigateObserver(device);
      const result = await new FocusNavigate(observer, device, timer).execute({
        until: { text: label },
        select: true,
        maxSteps: keys?.length,
      });
      const settled = await observer.read();
      expect(result).toMatchObject({ success: true, status: "focused", selected: true });
      expect(result.focusedElement?.descendantLabel).toBe(label);
      expect(result.focusedElement?.bounds).toEqual(settled.focused?.bounds);
      expect(result.focusedElement?.resourceId).toBeUndefined();
      expect(device.selected).toEqual([label]);
      expect(device.keys.filter((key) => key === "enter")).toHaveLength(1);
      if (label !== "Featured 01") {
        expect(result.steps).toBeGreaterThan(1);
      }
      if (keys) {
        expect(device.keys).toEqual([...keys, "enter"]);
      }
      expect(timer.getSleepHistory().every((ms) => ms === 200)).toBe(true);
      expect(timer.getSleepHistory().length).toBeGreaterThanOrEqual(result.steps + 1);
    },
  );

  test("repeated transient reads do not trip explicit-direction stuck detection", async () => {
    const device = new LeanbackRowEntry(10);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const result = await new FocusNavigate(
      createFocusNavigateObserver(device),
      device,
      timer,
    ).execute({
      until: { text: "Featured 02" },
      direction: "right",
      select: true,
    });
    expect(result).toMatchObject({ status: "focused", selected: true });
    expect(device.selected).toEqual(["Featured 02"]);
    expect(device.keys.slice(0, -1).every((key) => key === "arrow_right")).toBe(true);
  });

  test("a container that never settles stays bounded without selecting", async () => {
    const device = new LeanbackRowEntry(Infinity);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const result = await new FocusNavigate(
      createFocusNavigateObserver(device),
      device,
      timer,
    ).execute({
      until: { text: "Featured 02" },
      maxSteps: 8,
      select: true,
    });
    expect(result).toMatchObject({ status: "max_steps", steps: 8, selected: false });
    expect(device.keys).toEqual(Array(8).fill("arrow_right"));
    expect(device.selected).toEqual([]);
    expect(timer.getSleepHistory().length).toBeLessThanOrEqual(24);
  });
});

describe("FocusNavigate Leanback headers (#17513)", () => {
  test("enters the content pane before steering toward an absent card", async () => {
    const { device, timer, observer, navigator } = harness();
    const initial = await observer.read();
    expect(initial.focused?.["resource-id"]).toEndWith(":id/row_header");
    expect(initial.elements.some((element) => element.text === "Featured 02")).toBe(false);

    // No third capture: stop after the next press toward Featured 02, without inventing nodes.
    const result = await navigator.execute({ until: { text: "Featured 02" }, maxSteps: 2 });

    expect(device.keys).toEqual(["arrow_right", "arrow_right"]);
    expect(result.status).toBe("max_steps");
    expect(result.path).toHaveLength(2);
    expect(result.focusedElement?.descendantLabel).toBe("Featured 01");
    expect(timer.getSleepHistory()).toEqual([200, 200]);
  });

  test("steers toward a visible header without entering the content pane first", async () => {
    const { device, navigator } = harness();
    await navigator.execute({ until: { text: "Movies" }, maxSteps: 1 });
    expect(device.keys).toEqual(["arrow_down"]);
  });

  test("an explicit down direction never enters the content pane", async () => {
    const { device, navigator } = harness();
    const result = await navigator.execute({ until: { text: "Featured 02" }, direction: "down" });
    expect(result.status).toBe("stuck");
    expect(device.keys).toEqual(["arrow_down", "arrow_down", "arrow_down", "arrow_down"]);
  });

  test("a refused RIGHT falls through to the down scan over the headers", async () => {
    const { device, timer, navigator } = harness(false);
    const result = await navigator.execute({ until: { text: "Featured 02" } });
    expect(device.keys).toEqual([
      "arrow_right",
      "arrow_down",
      "arrow_right",
      "arrow_down",
      "arrow_right",
      "arrow_down",
    ]);
    expect(result.status).toBe("stuck");
    expect(result.steps).toBe(6);
    expect(result.path.map((entry) => entry.text)).toEqual(["Featured", "Movies", "Shows"]);
    expect(timer.getSleepHistory()).toHaveLength(6);
  });

  test("a row_header outside renamed browse_headers containers scans down without RIGHT", async () => {
    const { device, navigator } = harness(true, withoutLeanbackContainers(headers));
    const result = await navigator.execute({ until: { text: "Featured 02" } });
    expect(device.keys).toEqual(["arrow_down", "arrow_down", "arrow_down"]);
    expect(result.status).toBe("stuck");
  });

  test("a scrollable headers grid is scanned down for an off-screen header before RIGHT", async () => {
    const { device, navigator } = harness(true, withScrollableHeaders(headers));
    const result = await navigator.execute({ until: { text: "Kids" }, maxSteps: 4 });
    expect(device.keys).toEqual(["arrow_down", "arrow_down", "arrow_down", "arrow_right"]);
    expect(result.status).toBe("max_steps");
  });
});
