import { describe, expect, spyOn, test } from "bun:test";
import { isRecord } from "../../../src/server/pipeline/isRecord";
import type {
  SdkContractManifest,
  WebViewHostLog,
} from "../../../scripts/ios/sdk-contract/manifest";
import { parseSdkContractManifest } from "../../../scripts/ios/sdk-contract/manifest";
import type { ToolOutcome } from "../../../scripts/ios/sdk-contract/observationSlice";
import { judgeManifest } from "../../../scripts/ios/sdk-contract/networkSlice";
import {
  WEB_VIEW_SLICE,
  WEB_VIEW_STEPS,
  WEB_VIEW_NODES,
  WEB_VIEW_LABELS,
  WEB_VIEW_TEXT,
  driveWebViewSteps,
  judgeWebViewCases,
  observedWebButtonSelector,
  webViewObservationReady,
} from "../../../scripts/ios/sdk-contract/webViewSlice";
import { FakeTimer } from "../../fakes/FakeTimer";
import { webViewObserveCapture } from "./webViewObserveCapture";

const origin = "http://127.0.0.1:5000";
const disallowedOrigin = "http://127.0.0.1:5001";

function log(): WebViewHostLog {
  return {
    staleProbeAccepted: false,
    origin,
    disallowedOrigin,
    pageEvents: [
      ...["ready", "allowed-frame", "disallowed-frame"].map((kind) => ({
        kind,
        clicks: 0,
        value: "initial",
        document: "/initial",
        documentId: "d1",
      })),
      { kind: "click", clicks: 1, value: "initial", document: "/initial", documentId: "d1" },
      { kind: "input", clicks: 1, value: "", document: "/initial", documentId: "d1" },
      { kind: "input", clicks: 1, value: WEB_VIEW_TEXT, document: "/initial", documentId: "d1" },
      { kind: "ready", clicks: 1, value: "initial", document: "/next", documentId: "d2" },
      { kind: "click", clicks: 2, value: "initial", document: "/next", documentId: "d2" },
    ],
    captures: [
      { snapshotId: "s1", documentId: "d1" },
      { snapshotId: "s2", documentId: "d2" },
    ],
    rejections: [
      { snapshotId: "s1", documentId: "d1", domain: "AutoMobileWebViewBridge", code: 1 },
    ],
  };
}

function manifest(hostLog = log()): SdkContractManifest {
  return {
    schemaVersion: 4,
    scenario: WEB_VIEW_SLICE,
    runId: "run-1",
    status: "complete",
    network: [],
    faults: [],
    events: [],
    undecodableBatches: 0,
    webView: hostLog,
  };
}

/** Structured fake outcomes, not parser captures or a fabricated device fixture. */
function observation(documentId = "d1", snapshotId = "s1", extraId?: string): ToolOutcome {
  return {
    result: {
      viewHierarchy: {
        hierarchy: {
          node: {
            $: { class: "WKWebView" },
            node: [
              {
                $: {
                  class: "button",
                  "content-desc": WEB_VIEW_LABELS.button,
                  "view-id": `s2-${documentId}`,
                  "web-view-id": WEB_VIEW_NODES.webView,
                  "web-element-id": WEB_VIEW_NODES.button,
                  "web-snapshot-id": snapshotId,
                  "web-document-id": documentId,
                  "web-origin": origin,
                  "web-role": "button",
                },
              },
              {
                $: {
                  class: "input",
                  "content-desc": WEB_VIEW_LABELS.input,
                  "web-view-id": WEB_VIEW_NODES.webView,
                  "web-element-id": WEB_VIEW_NODES.input,
                  "web-snapshot-id": snapshotId,
                  "web-document-id": documentId,
                  "web-origin": origin,
                  "web-role": "input",
                },
              },
              ...(extraId ? [{ $: { "web-element-id": extraId, "web-origin": origin } }] : []),
            ],
          },
        },
      },
    },
  };
}

const sdkAction: ToolOutcome = { result: { success: true, backend: "sdk" } };
function outcomes(): Map<string, ToolOutcome> {
  return new Map([
    ["observe", observation()],
    ["tap", sdkAction],
    ["input", { result: { success: true, commands: [{ success: true, backend: "sdk" }] } }],
    ["after-navigation", observation("d2", "s2")],
    ["stale-handle", sdkAction],
  ]);
}

function judge(overrides: Record<string, ToolOutcome> = {}, hostLog = log()) {
  const results = outcomes();
  for (const [name, value] of Object.entries(overrides)) {
    results.set(name, value);
  }
  return judgeWebViewCases(manifest(hostLog), results);
}

function flattenAttributes(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(flattenAttributes);
  }
  if (!isRecord(value)) {
    return value;
  }
  const attributes = isRecord(value.$) ? value.$ : {};
  return Object.fromEntries(
    Object.entries({ ...value, ...attributes })
      .filter(([key]) => key !== "$")
      .map(([key, child]) => [key, flattenAttributes(child)]),
  );
}

describe("WKWebView contract judge (phase E)", () => {
  test("the captured DOM siblings beneath nested WKWebViews pass with wrapped or flat attributes", () => {
    const host = log();
    const attributes = webViewObserveCapture.viewHierarchy.hierarchy.node.node[0].node[1].$;
    if (
      typeof attributes["web-origin"] !== "string" ||
      typeof attributes["web-snapshot-id"] !== "string" ||
      typeof attributes["web-document-id"] !== "string"
    ) {
      throw new Error("capture is missing the DOM button");
    }
    host.origin = attributes["web-origin"];
    host.captures[0] = {
      snapshotId: attributes["web-snapshot-id"],
      documentId: attributes["web-document-id"],
    };
    host.rejections[0] = { ...host.rejections[0], ...host.captures[0] };
    host.pageEvents = host.pageEvents.map((event) =>
      event.documentId === "d1" ? { ...event, documentId: host.captures[0].documentId } : event,
    );
    for (const result of [webViewObserveCapture, flattenAttributes(webViewObserveCapture)]) {
      if (!isRecord(result)) {
        throw new Error("capture must be an object");
      }
      expect(webViewObservationReady({ result })).toBe(true);
      expect(observedWebButtonSelector({ result })).toEqual({ text: WEB_VIEW_LABELS.button });
      expect(judge({ observe: { result } }, host)).toEqual([]);
    }
  });
  test("all four ordered cases pass against the page and bridge logs", () => {
    expect(WEB_VIEW_STEPS.map((step) => step.caseName)).toEqual([
      "observe",
      "tap",
      "input",
      "stale-handle",
    ]);
    expect(judge()).toEqual([]);
    expect(judgeManifest(manifest(), WEB_VIEW_SLICE)).toEqual([]);
    const parsed = parseSdkContractManifest(JSON.stringify(manifest()));
    expect(parsed.success && parsed.manifest.webView).toEqual(log());
  });

  test("missing logs, missing steps and unloaded frames name the fixture boundary", () => {
    expect(judgeWebViewCases({ ...manifest(), webView: undefined }, outcomes())).toEqual([
      expect.objectContaining({ caseName: "run", boundary: "fixture-host" }),
    ]);
    expect(judgeManifest({ ...manifest(), webView: undefined }, WEB_VIEW_SLICE)).toEqual([
      expect.objectContaining({ caseName: "run", boundary: "fixture-host" }),
    ]);
    const missing = outcomes();
    missing.delete("input");
    expect(judgeWebViewCases(manifest(), missing)).toEqual([
      expect.objectContaining({ caseName: "input", boundary: "fixture-host" }),
    ]);
    for (const kind of ["allowed-frame", "disallowed-frame"]) {
      const host = log();
      host.pageEvents = host.pageEvents.filter((event) => event.kind !== kind);
      expect(judge({}, host)).toEqual([expect.objectContaining({ boundary: "fixture-host" })]);
    }
    expect(judge({}, { ...log(), disallowedOrigin: origin })).toEqual([
      expect.objectContaining({ boundary: "fixture-host" }),
    ]);
  });

  test("a node mention or DOM children outside WKWebView cannot pass observe", () => {
    expect(
      judge({ observe: { result: { message: "contract-web-button web-origin", skeleton: [] } } }),
    ).toContainEqual(expect.objectContaining({ caseName: "observe", boundary: "ios-client" }));
    const bad = JSON.stringify(observation()).replace('"WKWebView"', '"UIView"');
    const parsed: ToolOutcome = JSON.parse(bad);
    expect(webViewObservationReady(parsed)).toBe(false);
    expect(judge({ observe: parsed })).toContainEqual(
      expect.objectContaining({ caseName: "observe", boundary: "ios-client" }),
    );
  });

  test("unknown document handles and missing real attributes name the client", () => {
    expect(judge({ observe: observation("unknown", "s1") })).toContainEqual(
      expect.objectContaining({ caseName: "observe", boundary: "ios-client" }),
    );
    const missing: ToolOutcome = JSON.parse(
      JSON.stringify(observation()).replaceAll('"web-document-id"', '"invented-id"'),
    );
    expect(judge({ observe: missing })).toContainEqual(
      expect.objectContaining({ caseName: "observe", boundary: "ios-client" }),
    );
  });

  test("leaking a disallowed origin or either child frame names the adapter", () => {
    for (const bad of [
      JSON.stringify(observation()).replaceAll(origin, disallowedOrigin),
      ...[WEB_VIEW_NODES.allowed, WEB_VIEW_NODES.disallowed].map((id) =>
        JSON.stringify(observation("d1", "s1", id)),
      ),
    ]) {
      const leaked: ToolOutcome = JSON.parse(bad);
      expect(judge({ observe: leaked })).toContainEqual(
        expect.objectContaining({ caseName: "observe", boundary: "sdk-adapter" }),
      );
    }
  });

  for (const caseName of ["tap", "input"] as const) {
    test(`${caseName} needs SDK success and the actual page effect`, () => {
      expect(judge({ [caseName]: { result: { success: false, backend: "sdk" } } })).toEqual([
        expect.objectContaining({ caseName, boundary: "mcp-surface" }),
      ]);
      expect(judge({ [caseName]: { error: "unavailable" } })).toEqual([
        expect.objectContaining({ caseName, boundary: "mcp-surface" }),
      ]);
      const host = log();
      host.pageEvents = host.pageEvents.filter(
        (event) =>
          event.documentId !== "d1" || event.kind !== (caseName === "tap" ? "click" : "input"),
      );
      expect(judge({}, host)).toContainEqual(
        expect.objectContaining({ caseName, boundary: "ctrlproxy-command" }),
      );
      expect(
        judge({ [caseName]: { result: { success: true, backend: "xctest" } } }, host),
      ).toContainEqual(expect.objectContaining({ caseName, boundary: "ios-client" }));
    });
  }

  for (const caseName of ["tap", "input"] as const) {
    test(`${caseName} findings preserve bounded real MCP errors with or without a page effect`, () => {
      const error =
        'Failed to tap: Target "Contract web increment" is covered by the navigation bar; scroll it into view with swipeOn, then retry tapOn.';
      const longError = `${error} ${"detail ".repeat(100)}`;
      const failures: ToolOutcome[] = [
        { error: longError },
        { result: { success: false, error: longError } },
        { result: { success: false, message: longError } },
        {
          result: {
            success: false,
            commands: [{ success: false, backend: "sdk", error: longError }],
          },
        },
        {
          error: "Command failed: bun tool --selector long-argv",
          result: { success: false, error: longError },
        },
        {
          error: "Command failed: bun tool --selector long-argv",
          result: {
            success: false,
            message: "generic command failure",
            commands: [{ success: false, backend: "sdk", message: longError }],
          },
        },
      ];
      for (const failure of failures) {
        for (const host of [
          log(),
          {
            ...log(),
            pageEvents: log().pageEvents.filter(
              (event) =>
                event.documentId !== "d1" ||
                event.kind !== (caseName === "tap" ? "click" : "input"),
            ),
          },
        ]) {
          const message = judge({ [caseName]: failure }, host).find(
            (entry) => entry.caseName === caseName,
          )?.message;
          expect(message).toContain(error);
          expect(message).toContain(longError.slice(0, 240));
          expect(message!.length).toBeLessThan(400);
          expect(message).not.toContain(longError.slice(0, 241));
        }
      }
    });
  }

  test("replace must clear the initial value before the page reports the requested value", () => {
    const host = log();
    host.pageEvents = host.pageEvents.filter(
      (event) => event.kind !== "input" || event.value !== "",
    );
    expect(judge({}, host)).toEqual([
      expect.objectContaining({ caseName: "input", boundary: "ctrlproxy-command" }),
    ]);
    expect(
      judge({
        input: { result: { success: true, commands: [{ success: false, backend: "sdk" }] } },
      }),
    ).toEqual([expect.objectContaining({ caseName: "input", boundary: "mcp-surface" })]);
  });

  test("extra clicks cannot be hidden by successful or stale MCP replies", () => {
    const host = log();
    host.pageEvents.push({
      kind: "click",
      clicks: 3,
      value: "initial",
      document: "/initial",
      documentId: "d1",
    });
    const findings = judge({}, host);
    expect(findings).toContainEqual(
      expect.objectContaining({ caseName: "tap", boundary: "sdk-adapter" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ caseName: "stale-handle", boundary: "sdk-adapter" }),
    );
  });

  test("stale needs a new document and snapshot plus the bridge's rejection evidence", () => {
    for (const after of [observation(), observation("d1", "s2"), observation("d2", "s1")]) {
      expect(judge({ "after-navigation": after })).toEqual([
        expect.objectContaining({ caseName: "stale-handle", boundary: "fixture-host" }),
      ]);
    }
    expect(judge({}, { ...log(), rejections: [] })).toEqual([
      expect.objectContaining({ caseName: "stale-handle", boundary: "fixture-host" }),
    ]);
    expect(judge({}, { ...log(), staleProbeAccepted: true })).toEqual([
      expect.objectContaining({ caseName: "stale-handle", boundary: "sdk-adapter" }),
    ]);
  });

  test("navigation fallback requires SDK success; stale/target failures cannot stand in for a new-document click", () => {
    expect(judge({ "stale-handle": sdkAction })).toEqual([]);
    for (const result of [
      { error: "bridge rejected click (stale_snapshot)" },
      { result: { success: false, error: "Element not found" } },
      { error: "connection refused" },
      { result: { success: false } },
      { result: { success: true, backend: "xctest" } },
      {},
    ]) {
      expect(judge({ "stale-handle": result })).toEqual([
        expect.objectContaining({ caseName: "stale-handle", boundary: "ios-client" }),
      ]);
    }
  });

  test("navigation fallback requires exactly one click on the new bridge document id", () => {
    for (const documentId of [undefined, "d1", "unknown"]) {
      const host = log();
      host.pageEvents[host.pageEvents.length - 1].documentId = documentId;
      expect(judge({}, host)).toContainEqual(
        expect.objectContaining({ caseName: "stale-handle", boundary: "sdk-adapter" }),
      );
    }
    for (const mutate of [
      (host: WebViewHostLog) => host.pageEvents.pop(),
      (host: WebViewHostLog) => host.pageEvents.push({ ...host.pageEvents.at(-1)!, clicks: 3 }),
      (host: WebViewHostLog) => {
        host.pageEvents[host.pageEvents.length - 1].clicks = 1;
      },
    ]) {
      const host = log();
      mutate(host);
      expect(judge({}, host)).toEqual([
        expect.objectContaining({ caseName: "stale-handle", boundary: "sdk-adapter" }),
      ]);
    }
  });
});

describe("WKWebView driver", () => {
  test("resolves observe artifacts before readiness and after navigation using an injected reader", async () => {
    const paths: string[] = [];
    let reads = 0;
    const results = await driveWebViewSteps({
      timer: new FakeTimer(),
      ready: async () => {},
      navigate: async () => {},
      release: async () => {},
      invoke: async (tool, args) => {
        if (tool !== "observe") {
          return sdkAction;
        }
        expect(args).toEqual({ platform: "ios", project: "full" });
        return { result: { artifact: { path: "/tool_outputs/observe.json" } } };
      },
      readArtifact: async (path) => {
        paths.push(path);
        return JSON.stringify((++reads === 1 ? observation() : observation("d2", "s2")).result);
      },
    });
    expect(paths).toEqual(["/tool_outputs/observe.json", "/tool_outputs/observe.json"]);
    expect(webViewObservationReady(results.get("observe")!)).toBe(true);
    expect(results.get("after-navigation")?.result).toEqual(observation("d2", "s2").result);
  });

  for (const failure of ["unreadable", "invalid JSON", "non-object JSON"]) {
    test(`an ${failure} artifact returns an MCP finding and releases without actions`, async () => {
      const warning = spyOn(console, "warn").mockImplementation(() => {});
      const calls: string[] = [];
      try {
        const results = await driveWebViewSteps({
          timer: new FakeTimer(),
          ready: async () => {},
          navigate: async () => {
            calls.push("navigate");
          },
          release: async () => {
            calls.push("release");
          },
          invoke: async (tool) => {
            calls.push(tool);
            return { result: { artifact: { path: "/tool_outputs/missing.json" } } };
          },
          readArtifact: async () => {
            if (failure === "unreadable") {
              throw new Error("ENOENT");
            }
            return failure === "invalid JSON" ? "{" : "null";
          },
        });
        expect(calls).toEqual(["observe", "release"]);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(judgeWebViewCases(manifest(), results)).toContainEqual(
          expect.objectContaining({
            caseName: "observe",
            boundary: "mcp-surface",
            message: expect.stringContaining("artifact pointer=true"),
          }),
        );
      } finally {
        warning.mockRestore();
      }
    });
  }

  test("timeout diagnostics retain pointer evidence across retries and bound backend text", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let reads = 0;
    const result = { ...webViewObserveCapture, backend: "sdk".repeat(100) };
    const text = JSON.stringify(result).replaceAll('"contract-web-input"', '"missing-input"');
    const incomplete: Record<string, unknown> = JSON.parse(text);
    const results = await driveWebViewSteps({
      timer,
      ready: async () => {},
      navigate: async () => {},
      release: async () => {},
      invoke: async () =>
        ++reads === 1
          ? { result: { artifact: { path: "/tool_outputs/observe.json" } } }
          : { result: incomplete },
      readArtifact: async () => text,
    });
    const message = judgeWebViewCases(manifest(), results).find(
      (entry) => entry.caseName === "observe",
    )?.message;
    expect(timer.getSleepHistory()).toHaveLength(60);
    expect(message).toContain("web-element-id nodes=3, artifact pointer=true");
    expect(message).toContain(`backend=${"sdk".repeat(100).slice(0, 40)},`);
    expect(message!.length).toBeLessThan(250);
  });

  test("an unreadable after-navigation artifact is attributed to the MCP surface", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let reads = 0;
    try {
      const results = await driveWebViewSteps({
        timer: new FakeTimer(),
        ready: async () => {},
        navigate: async () => {},
        release: async () => {},
        invoke: async (tool) => {
          if (tool !== "observe") {
            return sdkAction;
          }
          return ++reads === 1
            ? observation()
            : { result: { artifact: { path: "/tool_outputs/missing.json" } } };
        },
        readArtifact: async () => {
          throw new Error("ENOENT");
        },
      });
      expect(judgeWebViewCases(manifest(), results)).toContainEqual(
        expect.objectContaining({
          caseName: "stale-handle",
          boundary: "mcp-surface",
          message: expect.stringContaining("after-navigation observe failed"),
        }),
      );
    } finally {
      warning.mockRestore();
    }
  });
  test("a DOM node without a native selector uses its observed label", () => {
    const result: ToolOutcome = JSON.parse(
      JSON.stringify(observation()).replaceAll('"view-id"', '"unrelated"'),
    );
    expect(observedWebButtonSelector(result)).toEqual({ text: WEB_VIEW_LABELS.button });
    expect(observedWebButtonSelector({ result: { skeleton: [] } })).toBeUndefined();
  });

  test("readiness has a bounded fake-time deadline and releases without acting", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tools: string[] = [];
    let released = false;
    let navigated = false;
    const result = await driveWebViewSteps({
      timer,
      ready: async () => {},
      invoke: async (tool) => {
        tools.push(tool);
        return { result: {} };
      },
      navigate: async () => {
        navigated = true;
      },
      release: async () => {
        released = true;
      },
    });
    expect(result.size).toBe(1);
    expect(new Set(tools)).toEqual(new Set(["observe"]));
    expect(timer.getSleepHistory()).toEqual(Array.from({ length: 60 }, () => 500));
    expect(released).toBe(true);
    expect(navigated).toBe(false);
    expect(judgeWebViewCases(manifest(), result)).toContainEqual(
      expect.objectContaining({
        caseName: "observe",
        message: expect.stringContaining(
          "backend=unknown, web-element-id nodes=0, artifact pointer=false",
        ),
      }),
    );
  });

  test("retries reads with FakeTimer, acts once, retains the observed selector and releases last", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const calls: { tool: string; args: Record<string, string | boolean> }[] = [];
    const order: string[] = [];
    let reads = 0;
    const results = await driveWebViewSteps({
      timer,
      ready: async () => {
        order.push("ready");
      },
      invoke: async (tool, args) => {
        calls.push({ tool, args });
        order.push(tool);
        if (tool === "observe") {
          reads++;
          return reads === 1
            ? { result: {} }
            : reads === 2
              ? observation()
              : observation("d2", "s2");
        }
        return sdkAction;
      },
      navigate: async () => {
        order.push("navigate");
      },
      release: async () => {
        order.push("release");
      },
    });
    expect(timer.getSleepHistory()).toEqual([500]);
    expect(order).toEqual([
      "ready",
      "observe",
      "observe",
      "tapOn",
      "sendKeys",
      "navigate",
      "observe",
      "tapOn",
      "release",
    ]);
    expect(calls.at(-1)?.args.selector).toBe(
      JSON.stringify(observedWebButtonSelector(results.get("observe")!)),
    );
    expect(calls.at(-1)?.args.selector).toBe(
      JSON.stringify(observedWebButtonSelector(results.get("after-navigation")!)),
    );
    expect(calls.at(-1)?.args.exactText).toBe(true);
    expect(results.has("stale-handle")).toBe(true);
  });

  test("always releases the host when marker coordination throws", async () => {
    let released = false;
    await expect(
      driveWebViewSteps({
        timer: new FakeTimer(),
        invoke: async () => sdkAction,
        ready: async () => {
          throw new Error("host failed");
        },
        navigate: async () => {},
        release: async () => {
          released = true;
        },
      }),
    ).rejects.toThrow("host failed");
    expect(released).toBe(true);
  });
});
