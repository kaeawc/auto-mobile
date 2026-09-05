import { expect, describe, test } from "bun:test";
import { parseWindowManagerRotation } from "../../../src/utils/android-cmdline-tools/parseWindowManagerRotation";

describe("parseWindowManagerRotation", () => {
  test("parses the authoritative WindowManagerService rotation", () => {
    const stdout = "  mRotation=1 mAltOrientation=false";
    expect(parseWindowManagerRotation(stdout)).toBe(1);
  });

  test("parses a bare mRotation line with no trailing fields", () => {
    expect(parseWindowManagerRotation("  mRotation=0")).toBe(0);
  });

  // #6199: dumpsys window (filtered through `grep -i "mRotation="`) can
  // contain a stale TaskSnapshot rotation BEFORE the authoritative
  // WindowManagerService rotation. A naive "first match anywhere" scan picks
  // the wrong one; only the line whose trimmed content starts with
  // `mRotation=<digit>` is the authoritative field.
  test("selects the authoritative display rotation over a preceding stale TaskSnapshot rotation", () => {
    const stdout = [
      "     snapshot=TaskSnapshot{ mId=1749551414267 mCaptureTime=1748344877515 mTopActivityComponent=com.android.settings/.SubSettings mSnapshot=android.hardware.HardwareBuffer@d8e7fad (864x1920) mColorSpace=sRGB IEC61966-2.1 (id=0, model=RGB) mOrientation=1 mRotation=0 mTaskSize=Point(1080, 2400) mContentInsets=[0,74][0,63] mLetterboxInsets=[0,0][0,0] mIsLowResolution=false mIsRealSnapshot=true mWindowingMode=1 mAppearance=24 mIsTranslucent=false mHasImeSurface=false mInternalReferences=2",
      "  mRotation=1",
    ].join("\n");

    expect(parseWindowManagerRotation(stdout)).toBe(1);
  });

  test("ignores a Configuration toString's symbolic mRotation=ROTATION_0 (non-numeric, not at line start)", () => {
    const stdout = [
      "    mFullConfiguration={1.0 310mcc260mnc [en_US] ldltr sw411dp w411dp h874dp 420dpi nrml long port finger -keyb/v/h -nav/h winConfig={ mBounds=Rect(0, 0 - 1080, 2400) mDisplayRotation=ROTATION_0 mWindowingMode=fullscreen mRotation=ROTATION_0} as.2 s.43 fontWeightAdjustment=0}",
      "  mRotation=3 mAltOrientation=false",
    ].join("\n");

    expect(parseWindowManagerRotation(stdout)).toBe(3);
  });

  test("returns null when no authoritative mRotation line is present", () => {
    const stdout =
      "     snapshot=TaskSnapshot{ mOrientation=1 mRotation=0 mTaskSize=Point(1080, 2400)";

    expect(parseWindowManagerRotation(stdout)).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseWindowManagerRotation("")).toBeNull();
  });
});
