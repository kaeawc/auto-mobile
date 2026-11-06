import { describe, expect, test } from "bun:test";
import type { DpadTapOnResult } from "../../src/features/action/DpadTapOn";
import type { FocusNavigateTarget } from "../../src/features/action/FocusNavigate";
import type { BootedDevice, TapOnElementOptions } from "../../src/models";
import type {
  InteractionToolDependencies,
  TapOnDpadFallbackLike,
} from "../../src/server/interactionTools/dependencies";
import { tapOnHandler } from "../../src/server/interactionTools/tapHandlers";
import { tapOnSchema } from "../../src/server/interactionTools/tapSchemas";
import { tapOnResultSchema } from "../../src/server/toolOutputSchemas";

const tv: BootedDevice = { deviceId: "emulator-5554", name: "TV", platform: "android" };

const dpadSuccess: DpadTapOnResult = {
  success: true,
  action: "tap",
  inputMethod: "dpad",
  focusNavigation: { status: "focused", steps: 1, path: [] },
  message: 'No touchscreen: focused text="Movies" with 1 D-pad press, then pressed enter',
};

class FakeDpadFallback implements TapOnDpadFallbackLike {
  probes = 0;
  readonly taps: FocusNavigateTarget[] = [];
  constructor(
    private readonly touchscreen: boolean | null,
    private readonly result: DpadTapOnResult = dpadSuccess,
  ) {}
  async hasTouchscreen() {
    this.probes += 1;
    return this.touchscreen;
  }
  async tap(target: FocusNavigateTarget) {
    this.taps.push(target);
    return this.result;
  }
}

function harness(touchscreen: boolean | null, result?: DpadTapOnResult) {
  const touchTaps: TapOnElementOptions[] = [];
  const fallback = new FakeDpadFallback(touchscreen, result);
  const deps: InteractionToolDependencies = {
    tapOnElementFactory: () => ({
      execute: async (options) => {
        touchTaps.push(options);
        return {
          success: true,
          action: "tap",
          element: { text: "Movies", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
        };
      },
    }),
    tapOnDpadFallbackFactory: () => fallback,
  };
  return { deps, fallback, touchTaps };
}

const args = (raw: Record<string, unknown>) =>
  tapOnSchema.parse({ platform: "android", ...raw }) as Parameters<typeof tapOnHandler>[1];

describe("tapOn on an Android device without a touchscreen", () => {
  test("moves D-pad focus to the match and presses enter instead of touching", async () => {
    const { deps, fallback, touchTaps } = harness(false);
    const response = await tapOnHandler(tv, args({ selector: { text: "Movies" } }), { deps });

    expect(fallback.taps).toEqual([{ label: "Movies" }]);
    expect(touchTaps).toEqual([]);
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({ success: true, inputMethod: "dpad" });
    expect(tapOnResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  test("an elementId selector focuses by element id", async () => {
    const { deps, fallback } = harness(false);
    await tapOnHandler(tv, args({ selector: { elementId: "app:id/row" } }), { deps });
    expect(fallback.taps).toEqual([{ elementId: "app:id/row" }]);
  });

  test("a focus walk that misses marks the response as an error", async () => {
    const miss: DpadTapOnResult = {
      ...dpadSuccess,
      success: false,
      focusNavigation: { status: "stuck", steps: 2, path: [] },
      message: "No touchscreen, and D-pad focus did not reach the target",
      error: "No touchscreen, and D-pad focus did not reach the target",
    };
    const { deps } = harness(false, miss);
    const response = await tapOnHandler(tv, args({ selector: { text: "Movies" } }), { deps });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ success: false, inputMethod: "dpad" });
  });
});

describe("tapOn keeps touching when", () => {
  test.each([
    ["the device has a touchscreen", true],
    ["the touchscreen probe failed", null],
  ] as const)("%s", async (_label, touchscreen) => {
    const { deps, fallback, touchTaps } = harness(touchscreen);
    const response = await tapOnHandler(tv, args({ selector: { text: "Movies" } }), { deps });
    expect(fallback.probes).toBe(1);
    expect(fallback.taps).toEqual([]);
    expect(touchTaps).toHaveLength(1);
    expect(response.structuredContent).not.toHaveProperty("inputMethod");
  });

  test("the request needs a touch tap, without probing the device", async () => {
    const { deps, fallback, touchTaps } = harness(false);
    await tapOnHandler(tv, args({ selector: { text: "Movies" }, sibling: true }), { deps });
    expect(fallback.probes).toBe(0);
    expect(touchTaps).toHaveLength(1);
  });

  test("the device is not Android", async () => {
    const { deps, fallback, touchTaps } = harness(false);
    await tapOnHandler({ ...tv, platform: "ios" }, args({ selector: { text: "Movies" } }), {
      deps,
    });
    expect(fallback.probes).toBe(0);
    expect(touchTaps).toHaveLength(1);
  });

  test("a test fakes only the touch tap", async () => {
    const { deps, touchTaps } = harness(false);
    delete deps.tapOnDpadFallbackFactory;
    await tapOnHandler(tv, args({ selector: { text: "Movies" } }), { deps });
    expect(touchTaps).toHaveLength(1);
  });
});
