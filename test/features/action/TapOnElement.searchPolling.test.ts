import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ResultFaker } from "../../fakes/ResultFaker";

function setup(platform: "android" | "ios") {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const selector = new FakeElementSelector();
  const command = new TapOnElement(
    { name: "test", platform, deviceId: "test" } as any,
    new FakeAdbClient() as any,
    { timer, elementSelector: selector },
  );
  const hierarchy = { hierarchy: { node: [] } };
  const requests: number[] = [];
  const refresh = spyOn(command as any, "refreshViewHierarchy").mockImplementation(async () => {
    requests.push(timer.now());
    // Bound the broken implementation too, so the red test cannot spin forever.
    timer.advanceTime(1);
    return hierarchy;
  });
  const search = (duration = 1500, signal?: AbortSignal) =>
    (command as any).searchForElement(
      { action: "tap", text: "missing", searchUntil: { duration } },
      { viewHierarchy: hierarchy, screenSize: { width: 400, height: 800 } },
      signal,
    );
  return { timer, selector, refresh, requests, search };
}

describe("TapOnElement search polling", () => {
  beforeEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });
  afterEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });
  for (const platform of ["ios", "android"] as const) {
    test(`${platform} bounds fast misses and yields between hierarchy requests`, async () => {
      const { search, requests } = setup(platform);
      const result = await search();
      expect(result.selection.element).toBeNull();
      expect(result.stats.requestCount).toBeGreaterThan(1);
      expect(result.stats.requestCount).toBeLessThanOrEqual(30);
      expect(result.stats.requestCount).toBe(requests.length);
      expect(result.stats.durationMs).toBeLessThanOrEqual(1500);
      for (let i = 1; i < requests.length; i++) {
        expect(requests[i] - requests[i - 1]).toBeGreaterThanOrEqual(50);
      }
    });
  }

  test("null refreshes cannot bypass pacing", async () => {
    const { search, refresh, timer } = setup("ios");
    refresh.mockImplementation(async () => {
      timer.advanceTime(1);
      return null;
    });
    expect((await search()).stats.requestCount).toBeLessThanOrEqual(30);
  });

  test("finds a target on a later poll without waiting out the window", async () => {
    const { search, refresh, selector, timer } = setup("ios");
    const target = ResultFaker.element({ bounds: { left: 0, top: 0, right: 100, bottom: 50 } });
    let calls = 0;
    refresh.mockImplementation(async () => {
      timer.advanceTime(1);
      if (++calls === 2) {
        selector.setNextElement(target);
      }
      return { hierarchy: { node: [] } };
    });
    const result = await search();
    expect(result.selection.element).toBe(target);
    expect(result.stats.requestCount).toBe(2);
    expect(result.stats.durationMs).toBeLessThan(1500);
  });

  test("off-screen matches cannot bypass pacing", async () => {
    const { search, selector } = setup("ios");
    selector.setNextElement(
      ResultFaker.element({
        bounds: { left: 500, top: 900, right: 600, bottom: 950 },
      }),
    );
    const result = await search();
    expect(result.selection.element).toBeNull();
    expect(result.stats.requestCount).toBeLessThanOrEqual(30);
  });

  test("request ceiling terminates even when the clock stops advancing", async () => {
    const { search, timer } = setup("ios");
    spyOn(timer, "now").mockReturnValue(0);
    expect((await search()).stats.requestCount).toBe(30);
  });

  test("an initial match needs no poll or delay", async () => {
    const { search, selector, refresh, timer } = setup("ios");
    selector.setNextElement(
      ResultFaker.element({
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      }),
    );
    expect((await search()).stats.requestCount).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(timer.now()).toBe(0);
  });

  test("aborting during the poll delay prevents another request", async () => {
    const { search, refresh, timer } = setup("ios");
    const controller = new AbortController();
    timer.setTimeout(() => controller.abort(), 25);
    await expect(search(1500, controller.signal)).rejects.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
