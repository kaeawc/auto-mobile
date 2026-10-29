import { describe, expect, test } from "bun:test";
import type { SdkWebSnapshotRequestOptions } from "../../../../src/features/observe/ios/CtrlProxySdkWebView";
import {
  createIosSdkWebReader,
  mergeIosSdkWebInto,
  type IosSdkWebClient,
  type IosSdkWebReader,
} from "../../../../src/features/observe/ios/IosSdkWebReader";
import type { CtrlProxySdkWebSnapshotResult } from "../../../../src/features/observe/ios/types";
import type { ViewHierarchyResult } from "../../../../src/models";

const entry = (webViewId: string) => ({
  webViewId,
  allowedOrigins: ["https://fixture.local"],
  contentProcessAvailable: true,
});
const snapshotOf = (snapshotId: string) => ({ snapshotId, elements: [] });

class FakeWebClient implements IosSdkWebClient {
  requests: Array<string | undefined> = [];
  constructor(private readonly replies: Record<string, CtrlProxySdkWebSnapshotResult | Error>) {}
  async requestSdkWebSnapshotForIos(
    options?: SdkWebSnapshotRequestOptions,
  ): Promise<CtrlProxySdkWebSnapshotResult> {
    this.requests.push(options?.webViewId);
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

  test("reads each further web view by id and keeps a slot for one without a snapshot", async () => {
    const client = new FakeWebClient({
      first: {
        success: false,
        available: true,
        totalTimeMs: 1,
        failure: "no_snapshot",
        webViews: [entry("a"), entry("b")],
      },
      b: {
        success: true,
        available: true,
        totalTimeMs: 1,
        webViewId: "b",
        snapshot: snapshotOf("s2"),
        webViews: [entry("a"), entry("b")],
      },
    });
    expect(await reader(client).snapshots()).toEqual([
      { webViewId: "a" },
      { webViewId: "b", snapshot: snapshotOf("s2") },
    ]);
    expect(client.requests).toEqual([undefined, "b"]);
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
    expect(client.requests).toEqual([]);
  });
});
