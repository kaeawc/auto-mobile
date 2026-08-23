import { describe, expect, test } from "bun:test";
import type { Element, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

function makeElement(): Element {
  return {
    text: "Submit",
    "resource-id": "com.app:id/submit_btn",
    class: "android.widget.Button",
    bounds: { left: 10, top: 20, right: 110, bottom: 70 },
  } as Element;
}

function makeHierarchy(marker: string): ViewHierarchyResult {
  return { hierarchy: { node: { marker } } } as unknown as ViewHierarchyResult;
}

function createTapOnElement(): { tap: TapOnElement; timer: FakeTimer } {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    {
      name: "test-device",
      platform: "android",
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    { timer },
  );
  return { tap, timer };
}

describe("retryTapIfNoChange", () => {
  test("does not retry when hierarchy changed after tap", async () => {
    const { tap } = createTapOnElement();
    const preHierarchy = makeHierarchy("before");
    const postHierarchy = makeHierarchy("after");

    (tap as any).refreshViewHierarchy = async () => postHierarchy;

    let tapCallCount = 0;
    (tap as any).executeAndroidTap = async () => {
      tapCallCount++;
    };

    const preTapHash = (tap as any).hashViewHierarchy(preHierarchy);

    await (tap as any).retryTapIfNoChange(
      preTapHash,
      { x: 60, y: 45 },
      "tap",
      0,
      makeElement(),
      {},
      false,
      { width: 1080, height: 1920 },
    );

    expect(tapCallCount).toBe(0);
  });

  test("retries tap when hierarchy unchanged after tap", async () => {
    const { tap } = createTapOnElement();
    const hierarchy = makeHierarchy("same-state");

    (tap as any).refreshViewHierarchy = async () => hierarchy;

    let tapCallCount = 0;
    (tap as any).executeAndroidTap = async () => {
      tapCallCount++;
    };

    const preTapHash = (tap as any).hashViewHierarchy(hierarchy);

    await (tap as any).retryTapIfNoChange(
      preTapHash,
      { x: 60, y: 45 },
      "tap",
      0,
      makeElement(),
      {},
      false,
      { width: 1080, height: 1920 },
    );

    expect(tapCallCount).toBe(1);
  });

  test("skips retry when post-tap hierarchy refresh returns null (likely activity transition)", async () => {
    const { tap } = createTapOnElement();
    const preHierarchy = makeHierarchy("before");

    (tap as any).refreshViewHierarchy = async () => null;

    let tapCallCount = 0;
    (tap as any).executeAndroidTap = async () => {
      tapCallCount++;
    };

    const preTapHash = (tap as any).hashViewHierarchy(preHierarchy);

    await (tap as any).retryTapIfNoChange(
      preTapHash,
      { x: 60, y: 45 },
      "tap",
      0,
      makeElement(),
      {},
      false,
      { width: 1080, height: 1920 },
    );

    expect(tapCallCount).toBe(0);
  });

  test("sleeps before checking and before retrying", async () => {
    const { tap, timer } = createTapOnElement();
    const hierarchy = makeHierarchy("same-state");

    (tap as any).refreshViewHierarchy = async () => hierarchy;
    (tap as any).executeAndroidTap = async () => {};

    const sleepDurations: number[] = [];
    const origSleep = timer.sleep.bind(timer);
    timer.sleep = async (ms: number) => {
      sleepDurations.push(ms);
      return origSleep(ms);
    };

    const preTapHash = (tap as any).hashViewHierarchy(hierarchy);

    await (tap as any).retryTapIfNoChange(
      preTapHash,
      { x: 60, y: 45 },
      "tap",
      0,
      makeElement(),
      {},
      false,
      { width: 1080, height: 1920 },
    );

    expect(sleepDurations).toEqual([300, 100]);
  });
});

describe("retryTapIfNoChange passes isTalkBackEnabled to executeAndroidTap", () => {
  for (const talkBackEnabled of [true, false]) {
    test(`passes isTalkBackEnabled=${talkBackEnabled} through to retry tap`, async () => {
      const { tap } = createTapOnElement();
      const hierarchy = makeHierarchy("same-state");

      (tap as any).refreshViewHierarchy = async () => hierarchy;

      let capturedIsTalkBackEnabled: boolean | undefined;
      (tap as any).executeAndroidTap = async (
        _action: string,
        _x: number,
        _y: number,
        _dur: number,
        _el: Element,
        _signal: unknown,
        _opts: unknown,
        isTalkBack: boolean,
      ) => {
        capturedIsTalkBackEnabled = isTalkBack;
      };

      const preTapHash = (tap as any).hashViewHierarchy(hierarchy);

      await (tap as any).retryTapIfNoChange(
        preTapHash,
        { x: 60, y: 45 },
        "tap",
        0,
        makeElement(),
        {},
        talkBackEnabled,
        { width: 1080, height: 1920 },
      );

      expect(capturedIsTalkBackEnabled).toBe(talkBackEnabled);
    });
  }
});

describe("ensureTap flag expansion", () => {
  test("ensureTap enables both preTapStability and retryIfNoChange", async () => {
    const { tap } = createTapOnElement();

    let capturedOptions: Record<string, unknown> | undefined;
    (tap as any).validateOptions = (opts: Record<string, unknown>) => {
      capturedOptions = opts;
      return "abort-for-test";
    };

    await tap.execute({
      text: "Submit",
      action: "tap",
      ensureTap: true,
    } as any);

    expect(capturedOptions!.preTapStability).toBe(true);
    expect(capturedOptions!.retryIfNoChange).toBe(true);
  });

  test("ensureTap sets flags even when not originally provided", async () => {
    const { tap } = createTapOnElement();

    let capturedOptions: Record<string, unknown> | undefined;
    (tap as any).validateOptions = (opts: Record<string, unknown>) => {
      capturedOptions = opts;
      return "abort-for-test";
    };

    await tap.execute({
      text: "Submit",
      action: "tap",
      ensureTap: true,
      preTapStability: undefined,
      retryIfNoChange: undefined,
    } as any);

    expect(capturedOptions!.preTapStability).toBe(true);
    expect(capturedOptions!.retryIfNoChange).toBe(true);
  });
});
