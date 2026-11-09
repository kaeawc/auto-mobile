import { describe, expect, test } from "bun:test";
import {
  blockingPromptForForegroundActivity,
  blockingSystemPromptHint,
  blockingSystemPromptIn,
  isRuntimePermissionPrompt,
} from "../../../src/features/observe/BlockingSystemPrompt";
import type { ObserveResult, ViewHierarchyWindowInfo } from "../../../src/models";

const APP = "com.example.chat";
const GRANT = "com.google.android.permissioncontroller.permission.ui.GrantPermissionsActivity";

function observation(
  windows: ViewHierarchyWindowInfo[] | undefined,
  activeWindow: ObserveResult["activeWindow"] = {
    appId: APP,
    activityName: `${APP}.MainActivity`,
    layoutSeqSum: 0,
  },
): Pick<ObserveResult, "activeWindow" | "viewHierarchy"> {
  return { activeWindow, viewHierarchy: { hierarchy: { node: {} }, windows } };
}

describe("blockingSystemPromptIn", () => {
  test("a focused permission controller window is reported while activeWindow names the app (#17669)", () => {
    expect(
      blockingSystemPromptIn(
        observation([
          { type: 1, packageName: "com.google.android.permissioncontroller", isFocused: true },
          { type: 1, packageName: APP, isFocused: false },
        ]),
      ),
    ).toEqual({ kind: "runtime-permission", package: "com.google.android.permissioncontroller" });
  });

  test.each(["com.android.systemui", "android"])(
    "a focused %s window is a system dialog",
    (pkg) => {
      expect(blockingSystemPromptIn(observation([{ packageName: pkg, isFocused: true }]))).toEqual({
        kind: "system-dialog",
        package: pkg,
      });
    },
  );

  test("the activity is added when activeWindow names the same package", () => {
    const pkg = "com.google.android.permissioncontroller";
    expect(
      blockingSystemPromptIn(
        observation([{ packageName: pkg, isFocused: true }], {
          appId: pkg,
          activityName: GRANT,
          layoutSeqSum: 0,
        }),
      ),
    ).toEqual({ kind: "runtime-permission", package: pkg, activity: GRANT });
  });

  test.each([
    ["no windows", undefined],
    ["focused app window", [{ packageName: APP, isFocused: true }]],
    ["unfocused status bar", [{ packageName: "com.android.systemui", type: 3, isFocused: false }]],
    ["focused window without a package", [{ isFocused: true }]],
    ["focused unrelated package", [{ packageName: "com.other.app", isFocused: true }]],
  ])("%s reports nothing", (_name, windows) => {
    expect(blockingSystemPromptIn(observation(windows))).toBeUndefined();
  });

  test("falls back to a GrantPermissionsActivity foreground without window metadata", () => {
    expect(
      blockingSystemPromptIn(
        observation(undefined, {
          appId: "com.android.permissioncontroller",
          activityName: "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
          layoutSeqSum: 0,
        }),
      )?.kind,
    ).toBe("runtime-permission");
  });

  test("falls back to a SystemUI overlay foreground", () => {
    expect(
      blockingSystemPromptIn(
        observation(undefined, {
          appId: "com.android.systemui",
          activityName: "",
          layoutSeqSum: 0,
          systemOverlay: true,
        }),
      ),
    ).toMatchObject({ kind: "system-dialog", package: "com.android.systemui" });
  });

  test("no observation reports nothing", () => {
    expect(blockingSystemPromptIn(undefined)).toBeUndefined();
  });
});

describe("blockingSystemPromptHint", () => {
  test("a permission prompt names its buttons and rules out scrolling", () => {
    const hint = blockingSystemPromptHint({
      kind: "runtime-permission",
      package: "com.google.android.permissioncontroller",
    });
    expect(hint).toContain("com.google.android.permissioncontroller");
    expect(hint).toContain("permission_deny_button");
    expect(hint).toContain("scrolling will not reveal the field");
    expect(hint).not.toContain("swipeOn");
  });

  test("a system dialog says to dismiss it", () => {
    expect(
      blockingSystemPromptHint({ kind: "system-dialog", package: "com.android.systemui" }),
    ).toContain("pressButton back");
  });
});

describe("isRuntimePermissionPrompt", () => {
  test("requires the permission controller package and GrantPermissionsActivity", () => {
    expect(
      isRuntimePermissionPrompt({
        packageName: "com.google.android.permissioncontroller",
        activityName: GRANT,
      }),
    ).toBe(true);
    expect(isRuntimePermissionPrompt({ packageName: APP, activityName: GRANT })).toBe(false);
  });
});

type ForegroundCase = [
  packageName: string,
  activityName: string | undefined,
  expected: ReturnType<typeof blockingPromptForForegroundActivity>,
];

describe("blockingPromptForForegroundActivity", () => {
  const RESOLVER = "com.android.internal.app.ResolverActivity";
  const USB = "com.android.systemui.usb.UsbPermissionActivity";
  const MANAGE = "com.google.android.permissioncontroller.ManagePermissionsActivity";
  const cases: ForegroundCase[] = [
    [
      "com.google.android.permissioncontroller",
      GRANT,
      {
        kind: "runtime-permission",
        package: "com.google.android.permissioncontroller",
        activity: GRANT,
      },
    ],
    ["android", RESOLVER, { kind: "system-dialog", package: "android", activity: RESOLVER }],
    [
      "com.android.systemui",
      USB,
      { kind: "system-dialog", package: "com.android.systemui", activity: USB },
    ],
    [APP, `${APP}.MainActivity`, undefined],
    ["com.google.android.permissioncontroller", MANAGE, undefined],
    ["android", undefined, undefined],
  ];
  test.each(cases)("%s/%s classifies as %p", (packageName, activityName, expected) => {
    expect(blockingPromptForForegroundActivity({ packageName, activityName })).toEqual(expected);
  });
});
