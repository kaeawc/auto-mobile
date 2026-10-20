import capture from "../fixtures/android-launcher/launcher-recents-emulator-5602.json";
import { AccessibilityHierarchyConverter } from "../../src/features/observe/android/AccessibilityHierarchyConverter";
import type { AccessibilityHierarchy } from "../../src/features/observe/android/types";
import { scopeHierarchyForSelector } from "../../src/features/observe/hierarchyLayer";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeTimer } from "../fakes/FakeTimer";

export function suspendedCapture(
  rootless = false,
  suspended: boolean | null = true,
  timer = new FakeTimer(),
) {
  const wire = JSON.parse(capture.rawViewHierarchy.json) as AccessibilityHierarchy;
  // No captured frame has prototypeSuspended yet; add only that wire key to the real capture.
  if (suspended !== null) {
    wire.prototypeSuspended = suspended;
  }
  if (rootless) {
    Reflect.deleteProperty(wire, "hierarchy");
  }
  return new AccessibilityHierarchyConverter({ timer }).convertToViewHierarchyResult(wire);
}

export function suspendedRefusal() {
  try {
    scopeHierarchyForSelector(suspendedCapture(), "prototype");
  } catch (error) {
    if (error instanceof ActionableError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected suspended refusal");
}
