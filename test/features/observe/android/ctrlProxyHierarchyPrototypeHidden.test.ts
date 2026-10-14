import { expect, spyOn, test } from "bun:test";
import capture from "../../../fixtures/android-launcher/launcher-recents-emulator-5602.json";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../../src/features/observe/android/types";
import { FakeTimer } from "../../../fakes/FakeTimer";

for (const path of ["main", "rootless", "failure"] as const) {
  for (const reason of ["app_layer_window_hidden", "device_blocked", "future_reason", undefined]) {
    test(`hidden reason conversion ${path}: ${reason}`, () => {
      const wire: AccessibilityHierarchy = JSON.parse(capture.rawViewHierarchy.json);
      if (reason !== undefined) {
        Object.assign(wire, { prototypeHiddenReason: reason });
      }
      if (path === "rootless") {
        Reflect.deleteProperty(wire, "hierarchy");
      }
      const timer = new FakeTimer();
      let calls = 0;
      if (path === "failure") {
        spyOn(timer, "now").mockImplementation(() => {
          if (++calls === 2) {
            throw new Error("injected conversion completion failure");
          }
          return 0;
        });
      }
      const converted = new CtrlProxyHierarchy({
        timer,
      } as HierarchyDelegateContext).convertToViewHierarchyResult(wire);
      if (reason === "app_layer_window_hidden" || reason === "device_blocked") {
        expect(converted.prototypeHiddenReason).toBe(reason);
      } else {
        expect(Object.hasOwn(converted, "prototypeHiddenReason")).toBe(false);
      }
      if (path === "failure") {
        expect(converted.hierarchy.error).toBe(
          "Failed to convert accessibility service hierarchy format",
        );
      }
    });
  }
}
