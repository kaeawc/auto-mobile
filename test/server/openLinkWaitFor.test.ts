import { describe, expect, test } from "bun:test";
import type { Element, ObserveResult, OpenURLResult } from "../../src/models";
import { buildOpenLinkPayload, openLinkSchema } from "../../src/server/interactionTools";

const makeObservation = (marker: string): ObserveResult => ({
  updatedAt: 0,
  screenSize: { width: 200, height: 200 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  activeWindow: { appId: "com.example.app", activityName: marker, layoutSeqSum: 0 },
});

describe("openLinkSchema waitFor / settled", () => {
  test("accepts openLink with an integrated waitFor predicate", () => {
    const parsed = openLinkSchema.parse({
      platform: "ios",
      url: "slack://open",
      waitFor: {
        activeWindow: { appId: "com.tinyspeck.chatlyio" },
        elementId: "home_tab_bar",
        timeout: 25000,
      },
    });
    expect(parsed.waitFor).toMatchObject({
      activeWindow: { appId: "com.tinyspeck.chatlyio" },
      elementId: "home_tab_bar",
    });
  });

  test("accepts openLink with waitFor and settled together", () => {
    const parsed = openLinkSchema.parse({
      platform: "android",
      url: "myapp://home",
      waitFor: { elementId: "home_tab_bar", timeout: 25000 },
      settled: { quietPeriodMs: 500 },
    });
    expect(parsed.settled).toEqual({ quietPeriodMs: 500 });
  });

  test("accepts a plain openLink with no waitFor (unchanged behavior)", () => {
    const parsed = openLinkSchema.parse({
      platform: "android",
      url: "https://example.com",
    });
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.waitFor).toBeUndefined();
  });

  test("rejects settled without waitFor", () => {
    expect(
      openLinkSchema.safeParse({
        platform: "android",
        url: "myapp://home",
        settled: { quietPeriodMs: 500 },
      }).success,
    ).toBe(false);
  });
});

describe("buildOpenLinkPayload", () => {
  const openResult: OpenURLResult = {
    success: true,
    url: "slack://open",
    observation: makeObservation("open"),
  };

  test("returns the plain open result when no wait occurred", () => {
    const payload = buildOpenLinkPayload("slack://open", openResult, null);
    expect(payload.observation).toBe(openResult.observation);
    expect("awaitTimeout" in payload).toBe(false);
    expect("awaitedElement" in payload).toBe(false);
  });

  test("surfaces the awaited observation and await fields when a wait occurred", () => {
    const awaited = makeObservation("home");
    const awaitedElement = { "resource-id": "home_tab_bar" } as unknown as Element;
    const payload = buildOpenLinkPayload("slack://open", openResult, {
      observation: awaited,
      awaitedElement,
      awaitDuration: 1200,
      awaitTimeout: false,
      matched: true,
      timedOut: false,
      polls: 2,
      waitMs: 1200,
      matchedElement: awaitedElement,
      candidates: [],
    });
    expect(payload.observation).toBe(awaited);
    expect(payload.awaitedElement).toBe(awaitedElement);
    expect(payload.awaitDuration).toBe(1200);
    expect(payload.awaitTimeout).toBe(false);
    expect(payload.matched).toBe(true);
    expect(payload.timedOut).toBe(false);
    expect(payload.polls).toBe(2);
    expect(payload.waitMs).toBe(1200);
    expect(payload.matchedElement).toBe(awaitedElement);
    expect(payload.candidates).toEqual([]);
  });
});
