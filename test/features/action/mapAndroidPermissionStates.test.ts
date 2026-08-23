import { describe, expect, test } from "bun:test";
import { mapAndroidPermissionStates } from "../../../src/features/action/AppPermissions";

describe("mapAndroidPermissionStates", () => {
  test("reports granted and denied runtime permissions", () => {
    const result = mapAndroidPermissionStates(
      ["android.permission.CAMERA", "android.permission.RECORD_AUDIO"],
      { "android.permission.CAMERA": true, "android.permission.RECORD_AUDIO": false },
    );

    expect(result).toEqual([
      {
        permission: "android.permission.CAMERA",
        state: "granted",
        source: "androidRuntime",
        raw: { granted: true },
      },
      {
        permission: "android.permission.RECORD_AUDIO",
        state: "denied",
        source: "androidRuntime",
        raw: { granted: false },
      },
    ]);
  });

  // Issue #4187: `permission in granted` also matches inherited Object.prototype
  // members, so a bogus permission name reported "granted" (the inherited value is a
  // truthy function) instead of "unknown".
  test.each([
    ["constructor"],
    ["toString"],
    ["valueOf"],
    ["hasOwnProperty"],
    ["__proto__"],
    // Control row: an ordinary absent permission must behave identically.
    ["android.permission.NOT_REPORTED"],
  ])("reports the absent permission %s as unknown", (permission) => {
    expect(mapAndroidPermissionStates([permission], { "android.permission.CAMERA": true })).toEqual(
      [{ permission, state: "unknown", source: "androidRuntime" }],
    );
  });
});
