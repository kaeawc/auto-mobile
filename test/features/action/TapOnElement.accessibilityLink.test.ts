import { describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { Element, ObserveResult } from "../../../src/models";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";

describe("tapOn semantic link outcomes", () => {
  for (const platform of ["android", "ios"] as const) {
    for (const scoped of [false, true]) {
      test.each(["timeout", "transport", "refusal", "success"])(
        `${platform} ${scoped ? "subtext" : "accessibilityLink"}: %s never falls back`,
        async (mode) => {
          const timer = new FakeTimer();
          timer.enableAutoAdvance();
          const android = new FakeCtrlProxy(timer);
          const ios = new FakeIOSCtrlProxy();
          const androidInstance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
            android as unknown as AndroidCtrlProxyClient,
          );
          const iosInstance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
            ios as unknown as IOSCtrlProxyClient,
          );
          const androidExisting = spyOn(
            AndroidCtrlProxyClient,
            "getExistingInstance",
          ).mockReturnValue(android as unknown as AndroidCtrlProxyClient);
          const iosExisting = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(
            ios as unknown as IOSCtrlProxyClient,
          );
          const client = platform === "android" ? android : ios;
          const unconfirmed = mode === "timeout" || mode === "transport";
          const error =
            mode === "timeout"
              ? "activation timed out"
              : mode === "transport"
                ? "socket closed"
                : "runner refused";
          const result = {
            success: mode === "success",
            error,
            action: "activate_accessibility_link",
            totalTimeMs: 1,
            dispatched: true,
            acknowledged: !unconfirmed,
            ...(unconfirmed ? { retryable: false } : {}),
          };
          const activate = spyOn(client, "requestActivateAccessibilityLink").mockResolvedValue(
            result,
          );
          const invalidate = spyOn(client, "invalidateCache");
          const adb = new FakeAdbClient();
          const tap = new TapOnElement(
            { deviceId: "semantic-link", name: "Test Device", platform },
            adb,
            {
              timer,
              // This suite bypasses BaseVisualChange's acquisition; cached-target
              // revalidation still needs a device-free hierarchy source.
              hierarchyCapture: new FakeHierarchyCapture(
                () => observation.viewHierarchy!,
                platform,
              ),
              accessibilityDetector: new FakeAccessibilityDetector(),
              iosVoiceOverDetector: new FakeIosVoiceOverDetector(),
              selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
            },
          );
          const element: Element = {
            text: "Owner",
            "resource-id": "owner",
            clickable: true,
            bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          };
          const observation: ObserveResult = {
            timestamp: 1,
            screenSize: { width: 100, height: 100 },
            viewHierarchy: { hierarchy: { node: element } },
            systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
          };
          const capture = spyOn(tap, "prepareSelectionCapture").mockResolvedValue(null);
          const controller = new AbortController();
          let thrown: unknown;
          tap.observedInteraction = async (run) => {
            try {
              return await run(observation);
            } catch (error) {
              thrown = error;
              throw error;
            }
          };
          try {
            const outcome = await tap.execute(
              {
                action: "tap",
                ...(scoped
                  ? { text: "Owner", subtext: { text: "Terms" } }
                  : { accessibilityLink: "Terms" }),
              },
              undefined,
              controller.signal,
            );
            expect(outcome.success).toBe(mode === "success");
            if (unconfirmed) {
              expect(thrown).toMatchObject({
                message: expect.stringContaining("Tap outcome is indeterminate"),
              });
              expect(outcome.error).toContain("Do not retry automatically");
              expect(invalidate).toHaveBeenCalledTimes(1);
            } else {
              expect(thrown).toBeUndefined();
              if (mode === "refusal") {
                expect(outcome.error).toBe(error);
                expect(invalidate).not.toHaveBeenCalled();
              } else if (platform === "ios") {
                expect(invalidate).toHaveBeenCalledTimes(1);
              }
            }
            expect(activate).toHaveBeenCalledTimes(1);
            expect(activate.mock.calls[0][5]).toBe(controller.signal);
            expect(android.getTapHistory()).toHaveLength(0);
            expect(ios.getTapHistory()).toHaveLength(0);
            expect(adb.getCommandCalls()).toEqual([]);
          } finally {
            for (const spy of [
              capture,
              activate,
              invalidate,
              androidInstance,
              iosInstance,
              androidExisting,
              iosExisting,
            ]) {
              spy.mockRestore();
            }
          }
        },
      );
    }
  }
});

describe("tapOn semantic link runner warning (#10082)", () => {
  const OWNER_NOTE =
    "Using owner 'row-a', the first of 2 candidate owners; scope with container/subtext for a specific owner.";

  for (const scoped of [false, true]) {
    for (const warning of [OWNER_NOTE, undefined]) {
      test(`ios ${scoped ? "subtext" : "accessibilityLink"}: runner warning ${warning ? "reaches" : "is absent from"} the tool result`, async () => {
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const ios = new FakeIOSCtrlProxy();
        const iosInstance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
          ios as unknown as IOSCtrlProxyClient,
        );
        const iosExisting = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(
          ios as unknown as IOSCtrlProxyClient,
        );
        const activate = spyOn(ios, "requestActivateAccessibilityLink").mockResolvedValue({
          success: true,
          action: "activate_accessibility_link",
          totalTimeMs: 1,
          dispatched: true,
          acknowledged: true,
          ...(warning ? { warning } : {}),
        });
        const element: Element = {
          text: "Owner",
          "resource-id": "owner",
          clickable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        };
        const observation: ObserveResult = {
          timestamp: 1,
          screenSize: { width: 100, height: 100 },
          viewHierarchy: { hierarchy: { node: element } },
          systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
        };
        const tap = new TapOnElement(
          { deviceId: "semantic-link-warning", name: "Test Device", platform: "ios" },
          new FakeAdbClient(),
          {
            timer,
            hierarchyCapture: new FakeHierarchyCapture(() => observation.viewHierarchy!, "ios"),
            accessibilityDetector: new FakeAccessibilityDetector(),
            iosVoiceOverDetector: new FakeIosVoiceOverDetector(),
            selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
          },
        );
        const capture = spyOn(tap, "prepareSelectionCapture").mockResolvedValue(null);
        tap.observedInteraction = async (run) => run(observation);
        try {
          const outcome = await tap.execute({
            action: "tap",
            ...(scoped
              ? { text: "Owner", subtext: { text: "Terms" } }
              : { accessibilityLink: "Terms" }),
          });
          expect(outcome.success).toBe(true);
          expect(activate).toHaveBeenCalledTimes(1);
          if (warning) {
            expect(outcome.warnings).toEqual([warning]);
          } else {
            expect(outcome).not.toHaveProperty("warnings");
          }
        } finally {
          for (const spy of [capture, activate, iosInstance, iosExisting]) {
            spy.mockRestore();
          }
        }
      });
    }
  }
});
