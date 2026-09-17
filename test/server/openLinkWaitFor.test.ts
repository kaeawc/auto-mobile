import { afterEach, describe, expect, test } from "bun:test";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  OpenURLResult,
  TapOnElementResult,
} from "../../src/models";
import {
  acceptIosAppOpenAlert,
  buildOpenLinkPayload,
  isIosAppOpenAlert,
  openLinkSchema,
  resetTapOnElementFactory,
  setTapOnElementFactory,
} from "../../src/server/interactionTools";

const makeObservation = (marker: string): ObserveResult => ({
  updatedAt: 0,
  screenSize: { width: 200, height: 200 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  activeWindow: { appId: "com.example.app", activityName: marker, layoutSeqSum: 0 },
});

const appOpenAlertObservation = {
  ...makeObservation("system-alert"),
  viewHierarchy: {
    hierarchy: {
      text: 'Open in "Slack Debug"?',
      node: [{ text: "Cancel" }, { text: "Open", clickable: true }],
    },
  },
} as unknown as ObserveResult;
const noAlertHierarchy = {
  hierarchy: { text: "Home" },
} as unknown as NonNullable<ObserveResult["viewHierarchy"]>;

describe("openLinkSchema waitFor / settled", () => {
  test("accepts opt-in iOS app-open alert handling", () => {
    const parsed = openLinkSchema.parse({
      platform: "ios",
      url: "slack://open",
      acceptOpenAlert: true,
    });
    expect(parsed.acceptOpenAlert).toBe(true);
  });

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

describe("openLink iOS app-open alert acceptance", () => {
  const iosDevice = {
    name: "iPhone",
    platform: "ios",
    deviceId: "ABCDEF01-1234-1234-1234-1234567890AB",
  } as BootedDevice;

  afterEach(() => {
    resetTapOnElementFactory();
  });

  test("recognizes only an Open button inside an Open in app confirmation", () => {
    expect(isIosAppOpenAlert(appOpenAlertObservation)).toBe(true);
    expect(
      isIosAppOpenAlert({
        ...makeObservation("ordinary"),
        viewHierarchy: {
          hierarchy: { text: "Open channel", node: [{ text: "Open" }] },
        },
      } as unknown as ObserveResult),
    ).toBe(false);
  });

  test("taps Open through the normal hierarchy-driven action", async () => {
    const options: unknown[] = [];
    setTapOnElementFactory(() => ({
      execute: async (received) => {
        options.push(received);
        return {
          success: true,
          action: "tap",
          element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
          observation: makeObservation("slack"),
        } as TapOnElementResult;
      },
    }));

    const result = await acceptIosAppOpenAlert(iosDevice, appOpenAlertObservation);

    expect(result?.success).toBe(true);
    expect(options).toEqual([{ text: "Open", action: "tap" }]);
  });

  test("forces a current hierarchy when the open-time observation is stale", async () => {
    let refreshCalls = 0;
    let tapCalls = 0;
    setTapOnElementFactory(() => ({
      execute: async () => {
        tapCalls += 1;
        return {
          success: true,
          action: "tap",
          element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        } as TapOnElementResult;
      },
    }));

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("stale-welcome"),
      undefined,
      undefined,
      async () => {
        refreshCalls += 1;
        return refreshCalls === 1
          ? (appOpenAlertObservation.viewHierarchy ?? null)
          : noAlertHierarchy;
      },
    );

    expect(result?.success).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(tapCalls).toBe(1);
  });

  test("falls back to the live SpringBoard button when snapshots omit the alert", async () => {
    let systemTapCalls = 0;

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("stale-welcome"),
      undefined,
      undefined,
      undefined,
      async () => {
        systemTapCalls += 1;
        return { success: true };
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.element.text).toBe("Open");
    expect(systemTapCalls).toBe(1);
  });

  test("retries the live button when the dialog remains after a successful tap", async () => {
    let refreshCalls = 0;
    let systemTapCalls = 0;
    setTapOnElementFactory(() => ({
      execute: async () =>
        ({
          success: true,
          action: "tap",
          element: { text: "Open", bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        }) as TapOnElementResult,
    }));

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      appOpenAlertObservation,
      undefined,
      undefined,
      async () => {
        refreshCalls += 1;
        return refreshCalls === 1
          ? (appOpenAlertObservation.viewHierarchy ?? null)
          : noAlertHierarchy;
      },
      async () => {
        systemTapCalls += 1;
        return { success: true };
      },
    );

    expect(result?.success).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(systemTapCalls).toBe(1);
  });

  test("rejects inconclusive verification snapshots after tapping", async () => {
    setTapOnElementFactory(() => ({
      execute: async () =>
        ({
          success: true,
          action: "tap",
          element: { text: "Open", bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        }) as TapOnElementResult,
    }));

    await expect(
      acceptIosAppOpenAlert(
        iosDevice,
        appOpenAlertObservation,
        undefined,
        undefined,
        async () => null,
      ),
    ).rejects.toThrow("dialog remained visible");
  });

  test("uses the locale-independent live system action for localized alerts", async () => {
    let systemTapCalls = 0;
    const localizedObservation = {
      ...makeObservation("localized-system-alert"),
      viewHierarchy: {
        hierarchy: {
          className: "UIAlertController",
          text: "In „Slack Debug“ öffnen?",
          node: [{ text: "Abbrechen" }, { text: "Öffnen", clickable: true }],
        },
      },
    } as unknown as ObserveResult;

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      localizedObservation,
      undefined,
      undefined,
      undefined,
      async () => {
        systemTapCalls += 1;
        return { success: true };
      },
    );

    expect(result?.success).toBe(true);
    expect(systemTapCalls).toBe(1);
  });

  test("does nothing when the alert is absent", async () => {
    let calls = 0;
    setTapOnElementFactory(() => ({
      execute: async () => {
        calls += 1;
        throw new Error("must not tap");
      },
    }));

    const result = await acceptIosAppOpenAlert(iosDevice, makeObservation("home"));

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  test("surfaces failure when the observed alert cannot be accepted", async () => {
    setTapOnElementFactory(() => ({
      execute: async () =>
        ({
          success: false,
          action: "tap",
          error: "Open was no longer hittable",
          element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
        }) as TapOnElementResult,
    }));

    await expect(acceptIosAppOpenAlert(iosDevice, appOpenAlertObservation)).rejects.toThrow(
      "Failed to accept iOS app-open alert: Open was no longer hittable",
    );
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
