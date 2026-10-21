import { describe, expect, test } from "bun:test";
import { BIOMETRIC_PROMPT_SETTLE_MS } from "../../src/features/action/BiometricAuth";
import {
  IOS_INSTALL_VERIFY_ATTEMPTS,
  IOS_PHYSICAL_VERIFY_ATTEMPTS,
} from "../../src/features/action/InstallApp";
import { KEY_EVENT_SETTLE_MS } from "../../src/features/action/InputText";
import { IME_DIAGNOSTIC_ATTEMPTS } from "../../src/features/action/imeFailureDiagnostics";
import { RECENT_APPS_VERIFY_ATTEMPTS } from "../../src/features/action/RecentApps";
import { DROPDOWN_OPEN_SETTLE_MS } from "../../src/features/action/SetUIState";
import { CTRL_PROXY_CONNECT_ATTEMPTS } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { SCREENSHOT_RECORD_ATTEMPTS } from "../../src/features/observe/screenshot/ObserveScreenshotRecorder";

describe("retry and settle constants", () => {
  test("preserves the existing typing, dropdown, and biometric delays", () => {
    expect(KEY_EVENT_SETTLE_MS).toBe(100);
    expect(DROPDOWN_OPEN_SETTLE_MS).toBe(200);
    expect(BIOMETRIC_PROMPT_SETTLE_MS).toBe(100);
  });

  test("preserves the existing retry attempt bounds", () => {
    expect(RECENT_APPS_VERIFY_ATTEMPTS).toBe(2);
    expect(IOS_INSTALL_VERIFY_ATTEMPTS).toBe(2);
    expect(IOS_PHYSICAL_VERIFY_ATTEMPTS).toBe(3);
    expect(IME_DIAGNOSTIC_ATTEMPTS).toBe(3);
    expect(SCREENSHOT_RECORD_ATTEMPTS).toBe(2);
    expect(CTRL_PROXY_CONNECT_ATTEMPTS).toBe(3);
  });
});
