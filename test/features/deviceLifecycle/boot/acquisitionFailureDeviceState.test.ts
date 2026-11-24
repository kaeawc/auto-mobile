import { describe, expect, test } from "bun:test";
import { annotateAcquisitionFailure } from "../../../../src/features/deviceLifecycle/boot/acquisitionFailureDeviceState";
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
});
