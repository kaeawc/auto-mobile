import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prototypeSettingsPagePlatformError } from "../../../src/features/prototype/prototypeSettings";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../fixtures/prototype-spec/platform-window-controls", name),
      "utf8",
    ),
  );
const wifi = fixture("settings-open-wifi.json");
const portable = fixture("settings-open-portable.json");

describe("settings.open pages per target platform (#16520)", () => {
  test("both fixtures are valid specs for the platform-neutral validator", () => {
    expect(validatePrototypeSpec(wifi).success).toBe(true);
    expect(validatePrototypeSpec(portable).success).toBe(true);
  });

  test("an Android-only literal page is refused for iOS at the action's path", () => {
    expect(prototypeSettingsPagePlatformError(wifi, "ios")).toEqual({
      path: "root.children[1].onTap[0]",
      message: 'settings.open page "wifi" is Android only; on iOS use "app" or "notifications"',
    });
  });

  test("the same spec passes for Android", () => {
    expect(prototypeSettingsPagePlatformError(wifi, "android")).toBeUndefined();
  });

  test("iOS pages and bound pages pass for iOS", () => {
    expect(prototypeSettingsPagePlatformError(portable, "ios")).toBeUndefined();
  });

  test("each Android-only page is refused for iOS", () => {
    for (const page of ["location", "wifi", "bluetooth", "display"]) {
      const spec = JSON.parse(JSON.stringify(wifi).replace('"wifi"}', `"${page}"}`));
      expect(prototypeSettingsPagePlatformError(spec, "ios")?.message).toContain(`"${page}"`);
    }
  });
});
