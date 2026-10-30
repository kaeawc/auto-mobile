import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { IosSdkWebActionClient } from "../../../../src/features/action/IosSdkWebActionRouter";
import { createIosSdkWebScrollIntoView } from "../../../../src/features/action/swipeon/IosSdkWebScrollIntoView";
import type { IosSdkWebReader } from "../../../../src/features/observe/ios/IosSdkWebReader";
import type { IosSdkWebViewSnapshot } from "../../../../src/features/observe/ios/iosSdkWebMerge";
import type {
  IosSdkWebAction,
  IosSdkWebElement,
} from "../../../../src/features/observe/ios/sdkWebViewBridge";
import type { CtrlProxySdkWebActionResult } from "../../../../src/features/observe/ios/types";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";

function screen(webViews = 1): { viewHierarchy: ViewHierarchyResult } {
  const webView = {
    $: { class: "WKWebView", bounds: { left: 0, top: 0, right: 400, bottom: 800 } },
  };
  return {
    viewHierarchy: {
      hierarchy: {
        node: {
          $: { class: "Application" },
          node: Array.from({ length: webViews }, () => webView),
        },
      },
    },
  };
}

const element = (id: string, fields: Partial<IosSdkWebElement> = {}): IosSdkWebElement => ({
  id,
  role: "button",
  bounds: [0, 2000, 100, 40],
  enabled: true,
  visible: true,
  focused: false,
  ...fields,
});

class FakeClient implements IosSdkWebActionClient {
  actions: Array<{ webViewId: string; action: IosSdkWebAction }> = [];
  constructor(private readonly reply: CtrlProxySdkWebActionResult) {}
  async requestSdkWebActionForIos(webViewId: string, action: IosSdkWebAction) {
    this.actions.push({ webViewId, action });
    return this.reply;
  }
}

const accepted: CtrlProxySdkWebActionResult = {
  success: true,
  available: true,
  totalTimeMs: 1,
  result: { status: "accepted" },
};

function scroller(
  elements: IosSdkWebElement[],
  options: {
    client?: FakeClient | null;
    enabled?: boolean;
    entries?: IosSdkWebViewSnapshot[];
  } = {},
) {
  const client = options.client === undefined ? new FakeClient(accepted) : options.client;
  const reader: IosSdkWebReader = {
    snapshots: async () =>
      options.entries ?? [{ webViewId: "checkout", snapshot: { snapshotId: "s3", elements } }],
  };
  return {
    client,
    web: createIosSdkWebScrollIntoView({
      reader,
      client: () => client,
      enabled: () => options.enabled ?? true,
    }),
  };
}

describe("scrolling a web-view DOM element into view (#5162)", () => {
  test("a text that names one element by label scrolls that element into view", async () => {
    const { web, client } = scroller([
      element("e1", { label: "Terms" }),
      element("e2", { label: "Pay" }),
    ]);
    const outcome = await web.scroll({ text: "pay" }, screen());
    expect(outcome).toEqual({ backend: "sdk" });
    expect(client?.actions).toEqual([
      { webViewId: "checkout", action: { scrollIntoView: { snapshotId: "s3", elementId: "e2" } } },
    ]);
  });

  test("an element's value matches too, but a redacted value never does", async () => {
    const byValue = scroller([element("e1", { role: "input", value: "Promo code" })]);
    expect(await byValue.web.scroll({ text: "Promo code" }, screen())).toEqual({ backend: "sdk" });
    const redacted = scroller([element("e1", { role: "input", value: "[REDACTED]" })]);
    expect(await redacted.web.scroll({ text: "[REDACTED]" }, screen())).toBeNull();
    expect(redacted.client?.actions).toEqual([]);
  });

  test("an ambiguous, partial or missing match leaves the search to swipe", async () => {
    const two = scroller([element("e1", { label: "Pay" }), element("e2", { label: "Pay" })]);
    expect(await two.web.scroll({ text: "Pay" }, screen())).toBeNull();
    const partial = scroller([element("e1", { label: "Pay now" })]);
    expect(await partial.web.scroll({ text: "Pay" }, screen())).toBeNull();
    const none = scroller([element("e1", { label: "Terms" })]);
    expect(await none.web.scroll({ text: "Pay" }, screen())).toBeNull();
    const dupId = scroller([element("e1", { label: "Pay" }), element("e1", { label: "Other" })]);
    expect(await dupId.web.scroll({ text: "Pay" }, screen())).toBeNull();
    expect([two, partial, none, dupId].flatMap(({ client }) => client?.actions ?? [])).toEqual([]);
  });

  test("an id selector, two web views, routing off or two registered web views do nothing", async () => {
    const elements = [element("e1", { label: "Pay" })];
    expect(await scroller(elements).web.scroll({ elementId: "pay" }, screen())).toBeNull();
    expect(await scroller(elements).web.scroll({ text: "Pay" }, screen(2))).toBeNull();
    expect(
      await scroller(elements, { enabled: false }).web.scroll({ text: "Pay" }, screen()),
    ).toBeNull();
    const registeredTwo = scroller(elements, { entries: [{ webViewId: "a" }, { webViewId: "b" }] });
    expect(await registeredTwo.web.scroll({ text: "Pay" }, screen())).toBeNull();
  });

  test("no runner client falls back to swiping and says the bridge is unavailable", async () => {
    const { web } = scroller([element("e1", { label: "Pay" })], { client: null });
    expect(await web.scroll({ text: "Pay" }, screen())).toEqual({
      backend: "xctest",
      fallbackReason: "unavailable",
    });
  });

  test("a rejected scroll fails closed", async () => {
    const client = new FakeClient({
      success: false,
      available: true,
      totalTimeMs: 1,
      result: { status: "rejected", reason: "stale_snapshot" },
    });
    const { web } = scroller([element("e1", { label: "Pay" })], { client });
    await expect(web.scroll({ text: "Pay" }, screen())).rejects.toBeInstanceOf(ActionableError);
  });
});
