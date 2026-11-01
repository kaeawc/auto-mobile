import { describe, expect, spyOn, test } from "bun:test";
import type { SdkWebSnapshotRequestOptions } from "../../../../src/features/observe/ios/CtrlProxySdkWebView";
import {
  createIosSdkWebReader,
  mergeIosSdkWebInto,
  type IosSdkWebClient,
  type IosSdkWebReader,
} from "../../../../src/features/observe/ios/IosSdkWebReader";
import type { CtrlProxySdkWebSnapshotResult } from "../../../../src/features/observe/ios/types";
import type { ViewHierarchyResult } from "../../../../src/models";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { logger } from "../../../../src/utils/logger";

const entry = (webViewId: string) => ({
  webViewId,
  allowedOrigins: ["https://fixture.local"],
  contentProcessAvailable: true,
});
const snapshotOf = (snapshotId: string) => ({ snapshotId, elements: [] });

class FakeWebClient implements IosSdkWebClient {
  requests: Array<string | undefined> = [];
  requestOptions: Array<SdkWebSnapshotRequestOptions | undefined> = [];
  constructor(private readonly replies: Record<string, CtrlProxySdkWebSnapshotResult | Error>) {}
  async requestSdkWebSnapshotForIos(
    options?: SdkWebSnapshotRequestOptions,
  ): Promise<CtrlProxySdkWebSnapshotResult> {
    this.requests.push(options?.webViewId);
    this.requestOptions.push(options);
    const reply = this.replies[options?.webViewId ?? "first"];
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }
}

function reader(client: FakeWebClient, enabled = true): IosSdkWebReader {
  return createIosSdkWebReader({ client: () => client, enabled: () => enabled });
}

describe("createIosSdkWebReader (#5162)", () => {
  test("an app with one web view costs one read", async () => {
    const client = new FakeWebClient({
      first: {
        success: true,
        available: true,
        totalTimeMs: 1,
        webViewId: "a",
        snapshot: snapshotOf("s1"),
        webViews: [entry("a")],
      },
    });
    expect(await reader(client).snapshots()).toEqual([
      { webViewId: "a", snapshot: snapshotOf("s1") },
    ]);
    expect(client.requests).toEqual([undefined]);
  });

  test("two or more registered web views cost one read and carry no snapshots", async () => {
    const client = new FakeWebClient({
      first: {
        success: true,
        available: true,
        totalTimeMs: 1,
        webViewId: "a",
        snapshot: snapshotOf("s1"),
        webViews: [entry("a"), entry("b"), entry("c")],
      },
    });
    expect(await reader(client).snapshots()).toEqual([
      { webViewId: "a" },
      { webViewId: "b" },
      { webViewId: "c" },
    ]);
    expect(client.requests).toEqual([undefined]);
  });

  test("a single web view whose read failed keeps its slot without a snapshot", async () => {
    const client = new FakeWebClient({
      first: {
        success: false,
        available: true,
        totalTimeMs: 1,
        failure: "no_snapshot",
        webViews: [entry("a")],
      },
    });
    expect(await reader(client).snapshots()).toEqual([{ webViewId: "a" }]);
    expect(client.requests).toEqual([undefined]);
  });

  test("a snapshot naming a different web view than the registered one is not attached", async () => {
    const client = new FakeWebClient({
      first: {
        success: true,
        available: true,
        totalTimeMs: 1,
        webViewId: "other",
        snapshot: snapshotOf("s9"),
        webViews: [entry("a")],
      },
    });
    expect(await reader(client).snapshots()).toEqual([{ webViewId: "a" }]);
  });

  test("routing off, no client, no registered web view or a failed read yields nothing", async () => {
    const reply: CtrlProxySdkWebSnapshotResult = {
      success: false,
      available: false,
      totalTimeMs: 1,
      failure: "bridge_unavailable",
      webViews: [],
    };
    const client = new FakeWebClient({ first: reply });
    expect(await reader(client, false).snapshots()).toEqual([]);
    expect(client.requests).toEqual([]);
    expect(
      await createIosSdkWebReader({ client: () => null, enabled: () => true }).snapshots(),
    ).toEqual([]);
    expect(await reader(client).snapshots()).toEqual([]);
    expect(
      await reader(new FakeWebClient({ first: new Error("socket closed") })).snapshots(),
    ).toEqual([]);
  });
});

describe("mergeIosSdkWebInto (#5162)", () => {
  test("reads nothing for a screen without a WKWebView", async () => {
    const client = new FakeWebClient({});
    const hierarchy: ViewHierarchyResult = {
      hierarchy: { node: { $: { class: "XCUIApplication" } } },
    };
    expect(await mergeIosSdkWebInto(hierarchy, reader(client))).toBeNull();
    expect(client.requests).toHaveLength(0);
  });

  test("reads nothing for a screen with two WKWebViews, which never merge", async () => {
    const client = new FakeWebClient({});
    const webView = {
      $: { class: "WKWebView", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
    };
    const hierarchy: ViewHierarchyResult = {
      hierarchy: { node: { $: { class: "XCUIApplication" }, node: [webView, webView] } },
    };
    expect(await mergeIosSdkWebInto(hierarchy, reader(client))).toBeNull();
    expect(client.requests).toHaveLength(0);
  });
});

describe("returned snapshot failures (#5162)", () => {
  test("a bad_reply is logged before the read falls back to XCTest only", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const client = new FakeWebClient({
        first: {
          success: false,
          available: true,
          totalTimeMs: 1,
          failure: "bad_reply",
          error: "garbled",
        },
      });
      expect(await reader(client).snapshots()).toEqual([]);
      expect(warn.mock.calls.some(([message]) => String(message).includes("garbled"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("SDK web-view snapshot budget", () => {
  const screen = (): ViewHierarchyResult => ({
    hierarchy: {
      node: { $: { class: "WKWebView", bounds: { left: 0, top: 0, right: 400, bottom: 800 } } },
    },
  });
  const noSnapshot: CtrlProxySdkWebSnapshotResult = {
    success: false,
    available: true,
    totalTimeMs: 1,
    failure: "no_snapshot",
    webViews: [entry("a")],
  };

  test("the single runner read receives the budget left at call time", async () => {
    const timer = new FakeTimer();
    const client = new FakeWebClient({ first: noSnapshot });
    const web = createIosSdkWebReader({
      timer,
      enabled: () => true,
      client: () => {
        timer.advanceTime(125);
        return client;
      },
    });
    const signal = new AbortController().signal;
    expect(await web.snapshots(signal, 500)).toEqual([{ webViewId: "a" }]);
    expect(client.requestOptions).toEqual([{ signal, timeoutMs: 375 }]);
  });

  test("elapsed, zero and negative budgets skip the runner and merge without error", async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => undefined);
    try {
      for (const timeoutMs of [500, 0, -1]) {
        const timer = new FakeTimer();
        const client = new FakeWebClient({ first: noSnapshot });
        const web = createIosSdkWebReader({
          timer,
          enabled: () => true,
          client: () => {
            timer.advanceTime(500);
            return client;
          },
        });
        expect(await web.snapshots(undefined, timeoutMs)).toEqual([]);
        expect(await mergeIosSdkWebInto(screen(), web, undefined, timeoutMs)).toBeNull();
        expect(client.requests).toEqual([]);
      }
      expect(debug).toHaveBeenCalledWith(
        "[iOS] SDK web-view snapshot skipped: time budget exhausted",
      );
    } finally {
      debug.mockRestore();
    }
  });

  test("omitted and larger budgets retain the 2000 ms per-read cap", async () => {
    const timer = new FakeTimer();
    const client = new FakeWebClient({ first: noSnapshot });
    const web = createIosSdkWebReader({ client: () => client, enabled: () => true, timer });
    timer.advanceTime(10_000);
    await web.snapshots();
    await web.snapshots(undefined, 3000);
    expect(client.requestOptions.map((options) => options?.timeoutMs)).toEqual([2000, 2000]);
  });

  test("merge forwards its remaining budget and signal to the reader", async () => {
    const client = new FakeWebClient({ first: noSnapshot });
    const web = createIosSdkWebReader({
      client: () => client,
      enabled: () => true,
      timer: new FakeTimer(),
    });
    const snapshots = spyOn(web, "snapshots");
    const signal = new AbortController().signal;
    try {
      expect(await mergeIosSdkWebInto(screen(), web, signal, 500)).toBeNull();
      expect(snapshots).toHaveBeenCalledWith(signal, 500);
      expect(client.requestOptions).toEqual([{ signal, timeoutMs: 500 }]);
    } finally {
      snapshots.mockRestore();
    }
  });
});
