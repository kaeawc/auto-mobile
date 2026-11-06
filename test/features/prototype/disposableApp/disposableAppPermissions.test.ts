import { describe, expect, test } from "bun:test";
import contract from "../../../../schemas/prototype-spec-contract.json";
import {
  DISPOSABLE_APP_ANDROID_BACKGROUND,
  DISPOSABLE_APP_ANDROID_PERMISSIONS,
  DISPOSABLE_APP_IOS_BACKGROUND_MODES,
  disposableAppDeclarations,
  resolveDisposableAppGrants,
} from "../../../../src/features/prototype/disposableApp/disposableAppPermissions";
import fixture from "../../../fixtures/prototype-spec/valid/platform-requires.json";

const P = "android.permission.";

describe("disposableAppDeclarations", () => {
  test("derives every platform list from the fixture's requires block", () => {
    const declarations = disposableAppDeclarations(fixture);
    expect(declarations.permissions).toEqual(["camera", "notifications"]);
    expect(declarations.background).toEqual(["audio"]);
    expect(declarations.android.permissions).toEqual([
      `${P}CAMERA`,
      `${P}FOREGROUND_SERVICE`,
      `${P}FOREGROUND_SERVICE_MEDIA_PLAYBACK`,
      `${P}INTERNET`,
      `${P}POST_NOTIFICATIONS`,
    ]);
    expect(declarations.ios).toEqual({
      usageDescriptions: { NSCameraUsageDescription: "Scan a code" },
      backgroundModes: ["audio"],
    });
  });

  test("a spec without requires declares only INTERNET on Android", () => {
    const declarations = disposableAppDeclarations({ id: "x", root: { type: "column" } });
    expect(declarations.permissions).toEqual([]);
    expect(declarations.android.permissions).toEqual([`${P}INTERNET`]);
    expect(declarations.ios).toEqual({ usageDescriptions: {}, backgroundModes: [] });
  });

  test("an invalid requires block is refused rather than partly derived", () => {
    expect(() =>
      disposableAppDeclarations({ requires: { permissions: [{ name: "sms", purpose: "x" }] } }),
    ).toThrow(/requires block is invalid/);
  });

  test("every contract permission and background name has a platform table entry", () => {
    const permissions = contract.definitions.platformPermission.fields.name.rule.values;
    const background = contract.definitions.platformRequires.fields.background.rule.item.values;
    expect(Object.keys(DISPOSABLE_APP_ANDROID_PERMISSIONS).sort()).toEqual([...permissions].sort());
    expect(Object.keys(DISPOSABLE_APP_ANDROID_BACKGROUND).sort()).toEqual([...background].sort());
    expect(Object.keys(DISPOSABLE_APP_IOS_BACKGROUND_MODES).sort()).toEqual([...background].sort());
  });
});

describe("resolveDisposableAppGrants", () => {
  const declared = ["camera", "notifications"];
  test("prompt grants nothing and grantDeclared grants every declared name", () => {
    expect(resolveDisposableAppGrants("prompt", declared)).toEqual({ granted: [], denied: [] });
    expect(resolveDisposableAppGrants("grantDeclared", declared)).toEqual({
      granted: declared,
      denied: [],
    });
  });

  test("explicit grant and deny lists must name declared permissions", () => {
    expect(
      resolveDisposableAppGrants({ grant: ["notifications"], deny: ["camera"] }, declared),
    ).toEqual({ granted: ["notifications"], denied: ["camera"] });
    expect(() => resolveDisposableAppGrants({ grant: ["contacts"] }, declared)).toThrow(
      /does not declare/,
    );
    expect(() =>
      resolveDisposableAppGrants({ grant: ["camera"], deny: ["camera"] }, declared),
    ).toThrow(/both grants and denies camera/);
  });
});
