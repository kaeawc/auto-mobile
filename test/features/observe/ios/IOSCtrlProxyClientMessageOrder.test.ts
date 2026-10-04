import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import type { WebSocketMessage, XCTestHierarchy } from "../../../../src/features/observe/ios/types";
import { getStructuredPayload } from "../../../../src/utils/toolUtils";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createSuccessWebSocketFactory } from "../../../fakes/FakeWebSocket";

let captured: XCTestHierarchy;
beforeAll(() => {
  const envelope = JSON.parse(
    readFileSync(
      new URL(
        "../../../fixtures/ios/ios-demos-observe-full-sdk-nodes-injected.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const payload = getStructuredPayload<{ viewHierarchy: XCTestHierarchy }>(envelope);
  if (!payload) {
    throw new Error("Missing captured hierarchy");
  }
  captured = payload.viewHierarchy;
});

describe("IOSCtrlProxyClient captured hierarchy message ordering", () => {
  test.each(["push", "response", "older"] as const)(
    "preserves %s side effects and exits",
    (kind) => {
      const timer = new FakeTimer();
      const client = IOSCtrlProxyClient.createForTesting(
        { deviceId: "captured-order", platform: "ios", name: "Fake iPhone" },
        8765,
        createSuccessWebSocketFactory(timer),
        timer,
      );
      const calls: string[] = [];
      const internal = client as unknown as {
        processMessage(message: WebSocketMessage): void;
        ignoreOlderHierarchyPush(message: WebSocketMessage): boolean;
        retainScaleMetadataFrom(hierarchy: XCTestHierarchy): void;
        handleHierarchyUpdateForNavigation(hierarchy: XCTestHierarchy): void;
        convertToViewHierarchyResult(hierarchy: XCTestHierarchy): unknown;
        sdkEventIngestor: { recordLayoutTelemetryEvent(hierarchy: unknown): void };
        consumeHierarchyObservationStreamSuppression(requestId: string): boolean;
        pushHierarchyToObservationStream(hierarchy: unknown): void;
        startScreenshotBackoff(): void;
        notifyPushUpdateListeners(hierarchy: XCTestHierarchy): void;
        requestManager: { resolve(requestId: string, result: unknown): void };
      };
      const spies = [
        spyOn(internal, "ignoreOlderHierarchyPush").mockImplementation(() => {
          calls.push("older-guard");
          return kind === "older";
        }),
        spyOn(internal, "retainScaleMetadataFrom").mockImplementation(() => {
          calls.push("scale");
        }),
        spyOn(internal, "handleHierarchyUpdateForNavigation").mockImplementation(() => {
          calls.push("navigation");
        }),
        spyOn(internal, "convertToViewHierarchyResult").mockImplementation(() => {
          calls.push("convert");
          return { hierarchy: captured.hierarchy };
        }),
        spyOn(internal.sdkEventIngestor, "recordLayoutTelemetryEvent").mockImplementation(() => {
          calls.push("layout");
        }),
        spyOn(internal, "consumeHierarchyObservationStreamSuppression").mockImplementation(() => {
          calls.push("suppression");
          return false;
        }),
        spyOn(internal, "pushHierarchyToObservationStream").mockImplementation(() => {
          calls.push("stream");
        }),
        spyOn(internal, "startScreenshotBackoff").mockImplementation(() => {
          calls.push("backoff");
        }),
        spyOn(internal, "notifyPushUpdateListeners").mockImplementation(() => {
          calls.push("listeners");
        }),
        spyOn(internal.requestManager, "resolve").mockImplementation(() => {
          calls.push("resolve");
        }),
      ];
      try {
        internal.processMessage({
          type: "hierarchy_update",
          data: captured,
          ...(kind === "response" ? { requestId: "captured-response" } : {}),
        });
        expect(calls).toEqual(
          kind === "older"
            ? ["older-guard"]
            : kind === "response"
              ? [
                  "older-guard",
                  "scale",
                  "navigation",
                  "convert",
                  "layout",
                  "suppression",
                  "stream",
                  "resolve",
                ]
              : [
                  "older-guard",
                  "scale",
                  "navigation",
                  "convert",
                  "layout",
                  "convert",
                  "stream",
                  "backoff",
                  "listeners",
                ],
        );
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    },
  );
});
