import { describe, expect, test } from "bun:test";
import {
  acquisitionFailureDeviceLeft,
  acquisitionNextStep,
  annotateAcquisitionFailure,
  createdDeviceRollbackDeviceLeft,
} from "../../../../src/features/deviceLifecycle/boot/acquisitionFailureDeviceState";
import { ActionableError } from "../../../../src/models";
import { DeviceTransportOfflineError } from "../../../../src/models/DeviceTransportOfflineError";

describe("annotateAcquisitionFailure (#19153)", () => {
  test("returns an annotated copy and leaves the shared original unchanged", () => {
    const root = new Error("adb failed");
    const original = new ActionableError("readiness failed", { cause: root });
    const annotated = annotateAcquisitionFailure(original, "shutdown", "retry getAndroid");
    expect(annotated).not.toBe(original);
    expect(original.message).toBe("readiness failed");
    expect(annotated).toBeInstanceOf(ActionableError);
    expect(annotated.message).toBe(
      "readiness failed. deviceLeft: shutdown (this request is shutting down the emulator it " +
        "cold-booted). Next step: retry getAndroid.",
    );
    expect(annotated.cause).toBe(original);
    expect(original.cause).toBe(root);
  });

  test("the copy's stack leads with the annotated message", () => {
    const original = new ActionableError("readiness failed.");
    const annotated = annotateAcquisitionFailure(original, "booted", "retry");
    const [header, ...frames] = (annotated.stack ?? "").split("\n");
    expect(header).toBe(`Error: ${annotated.message}`);
    expect(frames.length).toBeGreaterThan(0);
    expect(original.stack?.split("\n")[0]).toBe("Error: readiness failed.");
  });

  test("keeps the class and fields retry classification reads", () => {
    const original = new DeviceTransportOfflineError("emulator-5554", undefined);
    const annotated = annotateAcquisitionFailure(original, "booted", "retry");
    expect(annotated).toBeInstanceOf(DeviceTransportOfflineError);
    expect(annotated.code).toBe(original.code);
  });

  test("annotates once", () => {
    const annotated = annotateAcquisitionFailure(new ActionableError("x"), "unknown", "retry");
    expect(annotateAcquisitionFailure(annotated, "shutdown", "retry")).toBe(annotated);
  });

  test("passes a non-Error through", () => {
    expect(annotateAcquisitionFailure("boom", "unknown", "retry")).toBe("boom");
  });

  test("the copy carries deviceLeft as a typed field; the original does not (#18823)", () => {
    const original = new ActionableError("readiness failed");
    const annotated = annotateAcquisitionFailure(original, "booted", "retry");
    expect(acquisitionFailureDeviceLeft(annotated)).toBe("booted");
    expect(annotated).toHaveProperty("deviceLeft", "booted");
    expect(acquisitionFailureDeviceLeft(original)).toBeUndefined();
    expect(original).not.toHaveProperty("deviceLeft");
    expect(acquisitionFailureDeviceLeft("boom")).toBeUndefined();
  });

  test("a deleted created device names what was removed (#18823)", () => {
    const annotated = annotateAcquisitionFailure(
      new ActionableError("readiness failed"),
      "deleted",
      acquisitionNextStep("startDevice", "Pixel_A", true),
    );
    expect(annotated.message).toBe(
      "readiness failed. deviceLeft: deleted (this request shut down the device it created and " +
        "deleted it). Next step: retry startDevice with createIfMissing: true.",
    );
  });
});

describe("createIfMissing rollback reporting (#18823)", () => {
  test("a deleted device is reported deleted; a failed rollback cannot confirm it", () => {
    expect(createdDeviceRollbackDeviceLeft("deleted")).toBe("deleted");
    expect(createdDeviceRollbackDeviceLeft("failed")).toBe("unknown");
  });

  test("the next step recreates the device instead of naming the deleted avdName", () => {
    expect(acquisitionNextStep("startDevice", "Pixel_A", true)).toBe(
      "retry startDevice with createIfMissing: true",
    );
    expect(acquisitionNextStep("startDevice", "Pixel_A")).toBe(
      'retry startDevice with the same avdName ("Pixel_A")',
    );
  });
});
