import { expect, describe, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseWindowManagerRotation } from "../../../src/utils/android-cmdline-tools/parseWindowManagerRotation";

const WINDOW_DUMPS_DIR = join(__dirname, "..", "..", "features", "observe", "windowDumps");

/** Emulate `dumpsys window | grep -i "mRotation="` against a checked-in fixture. */
function grepMRotationLines(fixtureFile: string): string {
  const contents = readFileSync(join(WINDOW_DUMPS_DIR, fixtureFile), "utf8");
  return contents
    .split("\n")
    .filter((line) => /mRotation=/i.test(line))
    .join("\n");
}

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

  // #6199 follow-up: on API ~29-33, WindowManagerService does not print
  // `mRotation=` on its own line — it's inline on the `mDisplayFrozen=`
  // display-status line instead. Line taken verbatim (via `grep -in
  // "mRotation="`) from test/features/observe/windowDumps/api29-settings-window-dump.log:281.
  test("parses the inline mDisplayFrozen= form used on API ~29-33 (real api29 fixture line)", () => {
    const stdout =
      "  mDisplayFrozen=false windows=0 client=false apps=0  mRotation=0  mLastWindowForcedOrientation=-1 mLastOrientation=-1";

    expect(parseWindowManagerRotation(stdout)).toBe(0);
  });

  test("parses the inline mDisplayFrozen= form from the api30-33 fixtures (mRotation without mLastWindowForcedOrientation)", () => {
    const stdout =
      "  mDisplayFrozen=false windows=0 client=false apps=0  mRotation=1  mLastOrientation=-1";

    expect(parseWindowManagerRotation(stdout)).toBe(1);
  });

  test("selects the API ~29-33 inline display rotation over a preceding stale TaskSnapshot rotation", () => {
    const stdout = [
      "     snapshot=TaskSnapshot{ mId=1749551414267 mCaptureTime=1748344877515 mTopActivityComponent=com.android.settings/.SubSettings mSnapshot=android.hardware.HardwareBuffer@d8e7fad (864x1920) mColorSpace=sRGB IEC61966-2.1 (id=0, model=RGB) mOrientation=1 mRotation=0 mTaskSize=Point(1080, 2400) mContentInsets=[0,74][0,63] mLetterboxInsets=[0,0][0,0] mIsLowResolution=false mIsRealSnapshot=true mWindowingMode=1 mAppearance=24 mIsTranslucent=false mHasImeSurface=false mInternalReferences=2",
      "  mDisplayFrozen=false windows=0 client=false apps=0  mRotation=1  mLastWindowForcedOrientation=-1 mLastOrientation=-1",
    ].join("\n");

    expect(parseWindowManagerRotation(stdout)).toBe(1);
  });

  test("ignores a Configuration toString's symbolic mRotation=ROTATION_0 even alongside the API ~29-33 form", () => {
    const stdout = [
      "    mFullConfiguration={1.0 310mcc260mnc [en_US] ldltr sw411dp w411dp h842dp 420dpi nrml long port finger -keyb/v/h -nav/h winConfig={ mBounds=Rect(0, 0 - 1080, 2400) mAppBounds=Rect(0, 0 - 1080, 2274) mWindowingMode=fullscreen mDisplayWindowingMode=fullscreen mActivityType=undefined mAlwaysOnTop=undefined mRotation=ROTATION_0} s.6}",
      "  mDisplayFrozen=false windows=0 client=false apps=0  mRotation=0  mLastWindowForcedOrientation=-1 mLastOrientation=-1",
    ].join("\n");

    expect(parseWindowManagerRotation(stdout)).toBe(0);
  });

  // #6199 follow-up: run the parser directly against `grep -i "mRotation="`
  // applied to the real checked-in API 29-33 fixtures (not a hand-copied
  // string), so any future change to those fixtures re-validates the parse.
  for (const [file, expected] of [
    ["api29-settings-window-dump.log", 0],
    ["api30-settings-window-dump.log", 0],
    ["api31-settings-window-dump.log", 0],
    ["api32-settings-window-dump.log", 0],
    ["api33-settings-window-dump.log", 0],
  ] as const) {
    test(`parses the live rotation out of the real ${file} fixture`, () => {
      expect(parseWindowManagerRotation(grepMRotationLines(file))).toBe(expected);
    });
  }

  // The older (mRotation= as its own line) and newer (34+, back to its own
  // line) fixtures must keep working too.
  for (const [file, expected] of [
    ["api26-settings-window-dump.log", 0],
    ["api27-settings-window-dump.log", 0],
    ["api28-settings-window-dump.log", 3],
    ["api34-settings-window-dump.log", 0],
    ["api35-settings-window-dump.log", 0],
    ["api36-settings-window-dump.log", 0],
  ] as const) {
    test(`parses the live rotation out of the real ${file} fixture`, () => {
      expect(parseWindowManagerRotation(grepMRotationLines(file))).toBe(expected);
    });
  }

  test("returns null when no authoritative mRotation line is present", () => {
    const stdout =
      "     snapshot=TaskSnapshot{ mOrientation=1 mRotation=0 mTaskSize=Point(1080, 2400)";

    expect(parseWindowManagerRotation(stdout)).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(parseWindowManagerRotation("")).toBeNull();
  });
});
