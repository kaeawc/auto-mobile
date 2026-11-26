import { describe, expect, test } from "bun:test";
import { isStatusBarDiffSubtree, isSystemUiStatusBarId } from "../../src/utils/androidStatusBar";

const id = (name: string) => `com.android.systemui:id/${name}`;

describe("isStatusBarDiffSubtree (#19123, #19155)", () => {
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
    expect(isStatusBarDiffSubtree({ "resource-id": id(name) })).toBe(true);
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
    expect(isStatusBarDiffSubtree({ "resource-id": resourceId })).toBe(false);
  });

  test.each(["clickable", "long-clickable", "checkable", "scrollable"])(
    "keeps a status-bar-shaped id that is %s",
    (attribute) => {
      expect(
        isStatusBarDiffSubtree({ "resource-id": id("wifi_toggle"), [attribute]: "true" }),
      ).toBe(false);
    },
  );

  test("keeps a status-bar-shaped id whose descendant has an affordance", () => {
    const row = {
      "resource-id": id("mobile_network_layout"),
      node: [
        { "resource-id": id("mobile_carrier_text"), text: "T-Mobile" },
        { node: { "resource-id": id("mobile_toggle"), checkable: true } },
      ],
    };
    expect(isStatusBarDiffSubtree(row)).toBe(false);
  });

  test("skips a known status-bar root even when it has an affordance", () => {
    expect(isStatusBarDiffSubtree({ "resource-id": id("status_bar"), clickable: "true" })).toBe(
      true,
    );
  });

  test("skips the SystemUI clock even when the shade header makes it clickable", () => {
    expect(isStatusBarDiffSubtree({ "resource-id": id("clock"), clickable: "true" })).toBe(true);
  });

  test("keeps a status-bar-shaped id under an actionable ancestor", () => {
    expect(
      isStatusBarDiffSubtree({ "resource-id": id("wifi_connected_summary") }, () => true),
    ).toBe(false);
    expect(isStatusBarDiffSubtree({ "resource-id": id("status_bar") }, () => true)).toBe(true);
  });

  test("leaves the skeleton's status-bar folding allowlist unchanged", () => {
    expect(isSystemUiStatusBarId(id("mobile_combo"))).toBe(false);
  });
});
