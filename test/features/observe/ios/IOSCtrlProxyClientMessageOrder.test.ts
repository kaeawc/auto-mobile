import { convertIosHierarchy } from "../../../helpers/iosHierarchyConverter";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import type { IosHierarchyMessageEffects } from "../../../../src/features/observe/ios/IosHierarchyMessageEffects";
import type { XCTestHierarchy } from "../../../../src/features/observe/ios/types";
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
      const calls: string[] = [];
      const effects: IosHierarchyMessageEffects = {
        ignoreOlderPush: () => {
          calls.push("older-guard");
          return kind === "older";
        },
        retainScaleMetadata: () => {
          calls.push("scale");
        },
        recordNavigation: () => {
          calls.push("navigation");
        },
        convert: () => {
          calls.push("convert");
          return convertIosHierarchy(captured);
        },
        recordLayoutTelemetry: () => {
          calls.push("layout");
        },
        consumeStreamSuppression: () => {
          calls.push("suppression");
          return false;
        },
        pushToObservationStream: () => {
          calls.push("stream");
        },
        startScreenshotBackoff: () => {
          calls.push("backoff");
        },
        notifyPushListeners: () => {
          calls.push("listeners");
        },
        resolveRequest: () => {
          calls.push("resolve");
        },
      };
      const options = { messageEffects: effects, transientObserver: false };
      const client = IOSCtrlProxyClient.createForTesting(
        { deviceId: "captured-order", platform: "ios", name: "Fake iPhone" },
        8765,
        { wsFactory: createSuccessWebSocketFactory(timer), timer, options },
      );
      void client.connectionTestHooks.deliverMessage(
        JSON.stringify({
          type: "hierarchy_update",
          data: captured,
          ...(kind === "response" ? { requestId: "captured-response" } : {}),
        }),
      );
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
    },
  );
});
