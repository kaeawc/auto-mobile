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
