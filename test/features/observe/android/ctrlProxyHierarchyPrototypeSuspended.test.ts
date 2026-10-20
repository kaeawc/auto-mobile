import { FakeTimer } from "../../../fakes/FakeTimer";
import { describe, expect, spyOn, test, afterEach, mock } from "bun:test";
import { suspendedCapture } from "../../../helpers/prototypeSuspendedCapture";
import {
  scopeHierarchyForSelector,
  assertGestureOnLayer,
} from "../../../../src/features/observe/hierarchyLayer";
import {
  PrototypeSuspendedError,
  PROTOTYPE_SUSPENDED_REASON,
} from "../../../../src/features/prototype/prototypeSuspended";
import { typedRefusalFields } from "../../../../src/models/typedRefusalFields";
import { ActionableError } from "../../../../src/models/ActionableError";

afterEach(() => {
  mock.restore();
});

describe("captured Android prototype suspension", () => {
  for (const rootless of [false, true]) {
    test(`conversion retains true and omits absent/false, rootless=${rootless}`, () => {
      expect(suspendedCapture(rootless).prototypeSuspended).toBe(true);
      for (const flag of [null, false]) {
        expect(Object.hasOwn(suspendedCapture(rootless, flag), "prototypeSuspended")).toBe(false);
      }
    });
    test(`converted capture refuses selectors and gestures with typed advice, rootless=${rootless}`, () => {
      const converted = suspendedCapture(rootless);
      for (const refuse of [
        () => scopeHierarchyForSelector(converted, "prototype"),
        () => assertGestureOnLayer(converted, "prototype", [{ x: 10, y: 10 }], "swipe"),
      ]) {
        expect(refuse).toThrow(PROTOTYPE_SUSPENDED_REASON);
        try {
          refuse();
        } catch (error) {
          expect(error).toBeInstanceOf(ActionableError);
          expect(error).toBeInstanceOf(PrototypeSuspendedError);
          expect(typedRefusalFields(error)).toEqual({
            code: "prototype_suspended",
            retryable: false,
            nextAction:
              "bring the app the prototype was shown over back to the foreground (launchApp), or show the prototype again",
            details: { prototypeSuspended: true },
          });
        }
      }
    });
  }
});

test("conversion failure retains suspension in the error result", () => {
  const timer = new FakeTimer();
  let calls = 0;
  // Inject a one-shot failure at conversion completion; the frame is still the captured frame.
  spyOn(timer, "now").mockImplementation(() => {
    if (++calls === 2) {
      throw new Error("injected conversion completion failure");
    }
    return 0;
  });
  const converted = suspendedCapture(false, true, timer);
  expect(converted.hierarchy.error).toBe(
    "Failed to convert accessibility service hierarchy format",
  );
  expect(converted.prototypeSuspended).toBe(true);
  expect(() => scopeHierarchyForSelector(converted, "prototype")).toThrow(PrototypeSuspendedError);
});
