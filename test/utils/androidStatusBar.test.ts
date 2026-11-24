import { describe, expect, test } from "bun:test";
import { isStatusBarDiffSubtreeId, isSystemUiStatusBarId } from "../../src/utils/androidStatusBar";

const id = (name: string) => `com.android.systemui:id/${name}`;

describe("isStatusBarDiffSubtreeId (#19123)", () => {
  test.each([
    "status_bar_container",
    "status_bar",
    "statusIcons",
    "clock",
    "battery",
    "wifi_signal",
    "mobile_combo",
    "mobile_signal",
    "mobile_type",
    "signal_cluster",
    "signal_cluster_view",
  ])("skips status-bar chrome %s", (name) => {
    expect(isStatusBarDiffSubtreeId(id(name))).toBe(true);
  });

  test.each([
    id("notification_row_1"),
    id("notification_stack_scroller"),
    id("qs_frame"),
    id("tile_label"),
    id("carrier_combo"),
    "com.example:id/mobile_combo",
    undefined,
    42,
  ])("keeps %p", (resourceId) => {
    expect(isStatusBarDiffSubtreeId(resourceId)).toBe(false);
  });

  test("leaves the skeleton's status-bar folding allowlist unchanged", () => {
    expect(isSystemUiStatusBarId(id("mobile_combo"))).toBe(false);
  });
});
