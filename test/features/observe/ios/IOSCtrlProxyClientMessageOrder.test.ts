import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import type { XCTestHierarchy } from "../../../../src/features/observe/ios/types";
import { getStructuredPayload } from "../../../../src/utils/toolUtils";
import { createConvertedHierarchyStubForTest } from "./iosStreamTestBuilders";
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
      // The client is created per test, so stubbing its private seams by
      // assignment needs no restore step.
      client["ignoreOlderHierarchyPush"] = () => {
        calls.push("older-guard");
        return kind === "older";
      };
      client["retainScaleMetadataFrom"] = () => {
        calls.push("scale");
      };
      client["handleHierarchyUpdateForNavigation"] = () => {
        calls.push("navigation");
      };
      client["convertToViewHierarchyResult"] = () => {
        calls.push("convert");
        return createConvertedHierarchyStubForTest(captured);
      };
      client["consumeHierarchyObservationStreamSuppression"] = () => {
        calls.push("suppression");
        return false;
      };
      client["pushHierarchyToObservationStream"] = () => {
        calls.push("stream");
      };
      client["startScreenshotBackoff"] = () => {
        calls.push("backoff");
      };
      client["notifyPushUpdateListeners"] = () => {
        calls.push("listeners");
      };
      const spies = [
        spyOn(client["sdkEventIngestor"], "recordLayoutTelemetryEvent").mockImplementation(() => {
          calls.push("layout");
        }),
        spyOn(client["requestManager"], "resolve").mockImplementation(() => {
          calls.push("resolve");
        }),
      ];
      try {
        client["processMessage"]({
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
