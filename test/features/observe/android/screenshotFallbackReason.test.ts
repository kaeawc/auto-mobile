import { describe, it, expect } from "bun:test";
import {
  fallbackReasonForCtrlProxyFailure,
  CTRLPROXY_RATE_LIMITED_ERROR,
} from "../../../../src/features/observe/android/screenshotFallbackReason";

describe("fallbackReasonForCtrlProxyFailure", () => {
  it("maps the distinguishable rate-limit wire error to ctrlproxy_rate_limited", () => {
    // AC3: a genuine platform rate-limit must be classified distinctly, not as a generic failure.
    expect(fallbackReasonForCtrlProxyFailure(CTRLPROXY_RATE_LIMITED_ERROR)).toBe(
      "ctrlproxy_rate_limited"
    );
  });

  it("maps the internal timeout sentinel to ctrlproxy_timeout", () => {
    expect(fallbackReasonForCtrlProxyFailure("Screenshot timeout")).toBe("ctrlproxy_timeout");
  });

  it("maps a generic old-APK screenshot_error to ctrlproxy_failed (backward compatible)", () => {
    // AC4: an older APK only emits the generic message; it must keep classifying as today's reason.
    expect(fallbackReasonForCtrlProxyFailure("Failed to capture screenshot")).toBe(
      "ctrlproxy_failed"
    );
  });

  it("maps unknown/undefined errors to ctrlproxy_failed", () => {
    expect(fallbackReasonForCtrlProxyFailure(undefined)).toBe("ctrlproxy_failed");
    expect(fallbackReasonForCtrlProxyFailure("some other error")).toBe("ctrlproxy_failed");
  });
});
