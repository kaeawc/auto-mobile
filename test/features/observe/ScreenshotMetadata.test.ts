import { describe, expect, test } from "bun:test";
import {
  ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
  metadataForScreenshotFormat,
} from "../../../src/features/observe/ScreenshotMetadata";

describe("metadataForScreenshotFormat", () => {
  test("sets MIME type and format for known screenshot formats", () => {
    expect(metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, "png")).toEqual({
      screenshotMimeType: "image/png",
      screenshotFormat: "png",
      screenshotCaptureSource: "android_ctrlproxy_a11y",
      screenshotFallback: false,
    });
  });

  test("does not label unknown formats as the platform default", () => {
    expect(metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, "webp")).toEqual({
      screenshotCaptureSource: "android_ctrlproxy_a11y",
      screenshotFallback: false,
    });
  });
});
