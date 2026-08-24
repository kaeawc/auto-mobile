import { describe, expect, test } from "bun:test";
import {
  ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
  ANDROID_ADB_SCREENSHOT_METADATA,
  IOS_CTRLPROXY_SCREENSHOT_METADATA,
  ScreenshotMetadata,
  metadataForScreenshotFormat,
  pickScreenshotMetadata,
} from "../../../src/features/observe/ScreenshotMetadata";

describe("metadataForScreenshotFormat", () => {
  // Each of the three source constants crossed with each format. The function
  // strips the source's own mime/format first, then relabels only for the
  // known jpeg/png cases; anything else (webp, undefined) keeps NO mime/format.
  // The case-sensitive switch means "PNG"/"JPEG" fall through to default.
  const constants: Array<{ name: string; value: ScreenshotMetadata; rest: ScreenshotMetadata }> = [
    {
      name: "android ctrlproxy",
      value: ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
      rest: { screenshotCaptureSource: "android_ctrlproxy_a11y", screenshotFallback: false },
    },
    {
      name: "android adb",
      value: ANDROID_ADB_SCREENSHOT_METADATA,
      rest: { screenshotCaptureSource: "android_adb_screencap", screenshotFallback: true },
    },
    {
      name: "ios ctrlproxy",
      value: IOS_CTRLPROXY_SCREENSHOT_METADATA,
      rest: { screenshotCaptureSource: "ios_ctrlproxy", screenshotFallback: false },
    },
  ];

  constants.forEach(({ name, value, rest }) => {
    test(`${name} + jpeg is labelled image/jpeg`, () => {
      expect(metadataForScreenshotFormat(value, "jpeg")).toEqual({
        ...rest,
        screenshotMimeType: "image/jpeg",
        screenshotFormat: "jpeg",
      });
    });

    test(`${name} + png is labelled image/png`, () => {
      expect(metadataForScreenshotFormat(value, "png")).toEqual({
        ...rest,
        screenshotMimeType: "image/png",
        screenshotFormat: "png",
      });
    });

    test(`${name} + webp is labelled image/webp`, () => {
      expect(metadataForScreenshotFormat(value, "webp")).toEqual({
        ...rest,
        screenshotMimeType: "image/webp",
        screenshotFormat: "webp",
      });
    });

    test(`${name} + undefined format drops mime/format`, () => {
      expect(metadataForScreenshotFormat(value, undefined)).toEqual(rest);
    });

    test(`${name} + uppercase "PNG" falls through to default (case-sensitive)`, () => {
      expect(metadataForScreenshotFormat(value, "PNG")).toEqual(rest);
    });
  });

  test("does not mutate the source constant", () => {
    const snapshot = { ...ANDROID_CTRLPROXY_SCREENSHOT_METADATA };
    metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, "png");
    expect(ANDROID_CTRLPROXY_SCREENSHOT_METADATA).toEqual(snapshot);
  });
});

describe("pickScreenshotMetadata", () => {
  test("returns an empty object when no screenshot fields are present", () => {
    expect(pickScreenshotMetadata({})).toEqual({});
  });

  test("copies every screenshot field when all are present", () => {
    const full: ScreenshotMetadata = {
      screenshotMimeType: "image/jpeg",
      screenshotFormat: "jpeg",
      screenshotCaptureSource: "android_ctrlproxy_a11y",
      screenshotFallback: true,
      screenshotFallbackReason: "ctrlproxy_timeout",
      screenshotCaptureDurationMs: 12,
      screenshotEncodeDurationMs: 3,
      screenshotByteLength: 4096,
      screenshotBase64Length: 5461,
    };
    expect(pickScreenshotMetadata(full)).toEqual(full);
  });

  test("omits fields that are undefined", () => {
    const partial: ScreenshotMetadata = {
      screenshotFormat: "png",
      screenshotCaptureSource: "ios_ctrlproxy",
    };
    const picked = pickScreenshotMetadata(partial);
    expect(picked).toEqual({ screenshotFormat: "png", screenshotCaptureSource: "ios_ctrlproxy" });
    expect(Object.keys(picked).sort()).toEqual(["screenshotCaptureSource", "screenshotFormat"]);
  });

  test("keeps an explicit null fallback reason (null is not undefined)", () => {
    expect(pickScreenshotMetadata({ screenshotFallbackReason: null })).toEqual({
      screenshotFallbackReason: null,
    });
  });

  test("keeps a false screenshotFallback (false is not undefined)", () => {
    expect(pickScreenshotMetadata({ screenshotFallback: false })).toEqual({
      screenshotFallback: false,
    });
  });

  test("drops keys not part of the screenshot-metadata contract", () => {
    const withExtra = { screenshotFormat: "png", unrelated: "x" } as unknown as ScreenshotMetadata;
    const picked = pickScreenshotMetadata(withExtra);
    expect(picked).toEqual({ screenshotFormat: "png" });
    expect("unrelated" in picked).toBe(false);
  });
});
