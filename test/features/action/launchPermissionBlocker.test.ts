import { describe, expect, test } from "bun:test";
import {
  describeLaunchPermissionBlocker,
  pairPermissionDialogWindow,
  resolveLaunchPermissionBlocker,
} from "../../../src/features/action/launchPermissionBlocker";
import type { ObserveResult } from "../../../src/models";
import { parseObserveResultJson } from "../../../src/features/observe/output/observeResultWire";
import capture from "../../fixtures/android-launch-permission-dialog/contacts-first-launch-api37.json";

const observation = (): ObserveResult =>
  parseObserveResultJson(JSON.stringify(capture.observation));

describe("pairPermissionDialogWindow", () => {
  test("blanks the launched app's activity paired with the permission controller appId", () => {
    expect(pairPermissionDialogWindow(observation().activeWindow)).toEqual({
      appId: "com.google.android.permissioncontroller",
      activityName: "",
      layoutSeqSum: 0,
      type: "notification_permission_dialog",
    });
  });

  test("keeps the permission controller's own activity under either package name", () => {
    const window = {
      appId: "com.google.android.permissioncontroller",
      activityName: "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
      layoutSeqSum: 3,
    };
    expect(pairPermissionDialogWindow(window)).toBe(window);
  });

  test("leaves other apps' windows untouched", () => {
    const window = {
      appId: "com.google.android.contacts",
      activityName: "com.google.android.apps.contacts.activities.PeopleActivity",
      layoutSeqSum: 1,
    };
    expect(pairPermissionDialogWindow(window)).toBe(window);
    expect(pairPermissionDialogWindow(undefined)).toBeUndefined();
  });
});

describe("resolveLaunchPermissionBlocker", () => {
  test("reports the captured notification dialog with its buttons as actions", () => {
    const blocker = resolveLaunchPermissionBlocker("com.google.android.contacts", observation());
    expect(blocker).toEqual({
      kind: "permission_dialog",
      packageName: "com.google.android.permissioncontroller",
      permission: "android.permission.POST_NOTIFICATIONS",
      actions: ["Allow", "Don’t allow"],
    });
    expect(describeLaunchPermissionBlocker(blocker!)).toBe(
      'blocked by a notification permission dialog (com.google.android.permissioncontroller); tap "Allow" or "Don’t allow", or pre-grant with setAppPermissions',
    );
  });

  test("reports any permission controller window, without naming a permission", () => {
    const capture = observation();
    capture.notificationPermissionDetected = false;
    delete capture.activeWindow!.type;
    expect(resolveLaunchPermissionBlocker("com.google.android.contacts", capture)).toEqual({
      kind: "permission_dialog",
      packageName: "com.google.android.permissioncontroller",
      actions: ["Allow", "Don’t allow"],
    });
  });

  test("falls back to grant-button ids when nodes carry no package", () => {
    const capture = observation();
    for (const element of capture.elements!.clickable) {
      delete element.package;
    }
    expect(resolveLaunchPermissionBlocker("com.google.android.contacts", capture)?.actions).toEqual(
      ["Allow", "Don’t allow"],
    );
  });

  test("is absent when the requested app owns the foreground or nothing was observed", () => {
    const capture = observation();
    capture.notificationPermissionDetected = false;
    capture.activeWindow = { appId: "com.example.app", activityName: "", layoutSeqSum: 0 };
    capture.viewHierarchy = { hierarchy: {}, packageName: "com.example.app" };
    expect(resolveLaunchPermissionBlocker("com.example.app", capture)).toBeUndefined();
    expect(resolveLaunchPermissionBlocker("com.other.app", capture)).toBeUndefined();
    expect(resolveLaunchPermissionBlocker("com.example.app", undefined)).toBeUndefined();
  });

  test("tells the client to answer the dialog when no button was captured", () => {
    expect(
      describeLaunchPermissionBlocker({
        kind: "permission_dialog",
        packageName: "com.android.permissioncontroller",
        actions: [],
      }),
    ).toBe(
      "blocked by a permission dialog (com.android.permissioncontroller); answer it with tapOn, or pre-grant with setAppPermissions",
    );
  });
});
