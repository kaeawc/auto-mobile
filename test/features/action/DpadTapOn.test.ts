import { describe, expect, test } from "bun:test";
import {
  DpadTapOn,
  dpadTapOnHoldMs,
  dpadTapOnTarget,
  type DpadSelectHolder,
  type DpadTapOnNavigator,
  type DpadTapOnRequest,
} from "../../../src/features/action/DpadTapOn";
import type {
  FocusKeyPresser,
  FocusNavigateOptions,
  FocusNavigateResult,
} from "../../../src/features/action/FocusNavigate";
import type { InputKeyName } from "../../../src/features/action/InputKey";

const ROW = { text: "Movies", bounds: { left: 0, top: 0, right: 100, bottom: 100 } };

class FakeNavigator implements DpadTapOnNavigator {
  readonly calls: FocusNavigateOptions[] = [];
  constructor(private readonly result: FocusNavigateResult) {}
  async execute(options: FocusNavigateOptions): Promise<FocusNavigateResult> {
    this.calls.push(options);
    return this.result;
  }
}

class FakeKeys implements FocusKeyPresser {
  readonly presses: InputKeyName[] = [];
  constructor(private readonly error?: string) {}
  async press(key: InputKeyName) {
    this.presses.push(key);
    return this.error ? { success: false, error: this.error } : { success: true };
  }
}

const focused: FocusNavigateResult = {
  success: true,
  status: "focused",
  steps: 2,
  path: [ROW],
  focusedElement: ROW,
};

describe("dpadTapOnTarget", () => {
  test("text matches text or content-desc; elementId matches the resource id", () => {
    expect(dpadTapOnTarget({ selector: { text: "Movies" } })).toEqual({ label: "Movies" });
    expect(dpadTapOnTarget({ selector: { elementId: "app:id/row" }, action: "tap" })).toEqual({
      elementId: "app:id/row",
    });
  });

  test("ignores options that only tune a touch tap and keys the registry adds", () => {
    const request = {
      selector: { text: "Movies" },
      platform: "android",
      preTapStability: true,
      retryIfNoChange: false,
      ensureTap: true,
      sibling: false,
      selectionStrategy: "first",
      sessionUuid: "session-1",
    };
    expect(dpadTapOnTarget(request)).toEqual({ label: "Movies" });
  });

  test.each([
    { selector: { testTag: "row" } },
    { selector: { textAny: ["Movies"] } },
    { selector: { accessibilityLink: "Terms" } },
    { selector: { text: "Movies" }, action: "doubleTap" },
    { selector: { text: "Movies" }, duration: 500 },
    { selector: { text: "Movies" }, sibling: true },
    { selector: { text: "Movies" }, index: 1 },
    { selector: { text: "Movies" }, searchUntil: { duration: 1000 } },
    { selector: { text: "Movies" }, container: { elementId: "list" } },
    { selector: { text: "Movies" }, display: "secondary" },
    { selector: { text: "Movies" }, ensureChecked: true },
    { selector: { text: "Movies" }, ensureChecked: false },
    { selector: { text: "Movies" }, selectionStrategy: "random" },
    { selector: { text: "Movies" }, exactText: true },
  ] satisfies DpadTapOnRequest[])("leaves %j to the touch path", (request) => {
    expect(dpadTapOnTarget(request)).toBeUndefined();
  });
});

describe("D-pad long press (#17379)", () => {
  test("longPress stays on the D-pad path and holds for duration, default 1000 ms", () => {
    const request = { selector: { text: "Movies" }, action: "longPress" } as const;
    expect(dpadTapOnTarget(request)).toEqual({ label: "Movies" });
    expect(dpadTapOnHoldMs(request)).toBe(1000);
    expect(dpadTapOnHoldMs({ ...request, duration: 1500 })).toBe(1500);
    expect(dpadTapOnHoldMs({ selector: { text: "Movies" }, action: "tap" })).toBeUndefined();
  });

  test("a tap with a duration still needs touch", () => {
    expect(
      dpadTapOnTarget({ selector: { text: "Movies" }, action: "tap", duration: 500 }),
    ).toBeUndefined();
  });

  test("holds center after focusing instead of pressing enter", async () => {
    const holds: number[] = [];
    const holder: DpadSelectHolder = {
      holdSelect: async (durationMs) => {
        holds.push(durationMs);
        return { success: true };
      },
    };
    const keys = new FakeKeys();
    const result = await new DpadTapOn(new FakeNavigator(focused), keys, undefined, holder).execute(
      { label: "Movies" },
      undefined,
      1000,
    );
    expect(keys.presses).toEqual([]);
    expect(holds).toEqual([1000]);
    expect(result).toMatchObject({ success: true, action: "longPress" });
    expect(result.message).toContain("held center for 1000 ms");
  });

  test("reports a hold that failed", async () => {
    const holder: DpadSelectHolder = {
      holdSelect: async () => ({ success: false, error: "needs API 35" }),
    };
    const result = await new DpadTapOn(
      new FakeNavigator(focused),
      new FakeKeys(),
      undefined,
      holder,
    ).execute({ label: "Movies" }, undefined, 500);
    expect(result).toMatchObject({ success: false, action: "longPress" });
    expect(result.error).toContain("holding center for 500 ms failed: needs API 35");
  });
});

describe("DpadTapOn", () => {
  test("focuses the match, presses enter and reports the focus walk", async () => {
    const navigator = new FakeNavigator(focused);
    const keys = new FakeKeys();
    const result = await new DpadTapOn(navigator, keys).execute({ label: "Movies" });

    expect(navigator.calls).toEqual([{ until: { label: "Movies" }, firstMatch: true }]);
    expect(keys.presses).toEqual(["enter"]);
    expect(result).toEqual({
      success: true,
      action: "tap",
      inputMethod: "dpad",
      focusNavigation: { status: "focused", steps: 2, path: [ROW], focusedElement: ROW },
      message: 'No touchscreen: focused text="Movies" with 2 D-pad presses, then pressed enter',
    });
  });

  test("a resolver pins each read's target to the element a touch tap would pick", async () => {
    const navigator = new FakeNavigator(focused);
    const seen: Array<{ label?: string }> = [];
    const resolver = {
      resolve: (_screen: unknown, target: { label?: string }) => {
        seen.push(target);
        return ROW.bounds;
      },
    };
    await new DpadTapOn(navigator, new FakeKeys(), resolver).execute({ label: "Movies" });
    const pin = navigator.calls[0]?.pinTarget;
    expect(pin?.({ focused: null, elements: [] })).toEqual(ROW.bounds);
    expect(seen).toEqual([{ label: "Movies" }]);
  });

  test("does not press enter when the request is cancelled during the last read", async () => {
    const controller = new AbortController();
    const navigator: DpadTapOnNavigator = {
      execute: async () => {
        controller.abort();
        return focused;
      },
    };
    const keys = new FakeKeys();
    await expect(
      new DpadTapOn(navigator, keys).execute({ label: "Movies" }, controller.signal),
    ).rejects.toThrow();
    expect(keys.presses).toEqual([]);
  });

  test("does not press enter when focus never reaches the match", async () => {
    const keys = new FakeKeys();
    const result = await new DpadTapOn(
      new FakeNavigator({
        success: false,
        status: "stuck",
        steps: 3,
        path: [],
        message: "Focus did not move after 2 presses",
      }),
      keys,
    ).execute({ elementId: "app:id/row" });

    expect(keys.presses).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.focusNavigation.status).toBe("stuck");
    expect(result.error).toContain("D-pad focus did not reach id=app:id/row (stuck)");
  });

  test("reports an enter press that failed", async () => {
    const result = await new DpadTapOn(
      new FakeNavigator(focused),
      new FakeKeys("adb gone"),
    ).execute({ label: "Movies" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("pressing enter failed: adb gone");
  });
});
