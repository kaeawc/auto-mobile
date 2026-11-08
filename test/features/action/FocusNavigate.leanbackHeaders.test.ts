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

/** Captured screens only: RIGHT enters the row, whose first card then retains focus. */
class LeanbackDevice implements Pick<ObserveScreen, "execute">, FocusKeyPresser {
  readonly keys: InputKeyName[] = [];
  private hierarchy = headers;

  constructor(private readonly canEnter = true) {}

  async execute(): Promise<ObserveResult> {
    return { viewHierarchy: this.hierarchy } as ObserveResult;
  }

  async press(key: InputKeyName): Promise<{ success: boolean }> {
    this.keys.push(key);
    if (key === "arrow_right" && this.canEnter) {
      this.hierarchy = content;
    }
    return { success: true };
  }
}

function harness(canEnter = true) {
  const device = new LeanbackDevice(canEnter);
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
    expect(device.keys).toEqual(["arrow_down", "arrow_down"]);
  });

  test("returns stuck after one RIGHT that leaves the header focused", async () => {
    const { device, timer, navigator } = harness(false);
    const result = await navigator.execute({ until: { text: "Featured 02" } });
    expect(device.keys).toEqual(["arrow_right"]);
    expect(result.status).toBe("stuck");
    expect(result.steps).toBe(1);
    expect(result.message).toBe(
      "Focus did not move after 1 press; the target was not focused. Observe before retrying.",
    );
    expect(timer.getSleepHistory()).toEqual([200]);
  });
});
