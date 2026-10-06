import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CtrlProxyTalkBackDialogProbe,
  findTalkBackConsentDialog,
} from "../../../src/features/accessibility/TalkBackDialogProbe";
import type {
  AccessibilityHierarchy,
  AccessibilityNode,
} from "../../../src/features/observe/android/types";
import type { BootedDevice } from "../../../src/models";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

// Typed nodes carrying only the fields the probe reads (resource-id, text, bounds); the full
// device hierarchy format is exercised by the CtrlProxy hierarchy tests, not here.
const consentButton: AccessibilityNode = {
  "resource-id": "android:id/button1",
  text: "Allow",
  bounds: { left: 180, top: 684, right: 540, bottom: 740 },
};
const consentMessage: AccessibilityNode = { text: "Allow TalkBack to have full control?" };

const tree = (...children: AccessibilityNode[]): AccessibilityNode => ({
  "resource-id": "android:id/content",
  node: children,
});

describe("findTalkBackConsentDialog", () => {
  test("finds the positive button and its centre when the TalkBack dialog is present", () => {
    expect(findTalkBackConsentDialog(tree(consentMessage, consentButton))).toEqual({
      kind: "dialog",
      tap: { x: 360, y: 712 },
    });
  });

  test("matches the button by resource-id on a non-English locale", () => {
    const localized = tree(
      { text: "TalkBack に全画面制御を許可しますか？" },
      { ...consentButton, text: "許可" },
    );
    expect(findTalkBackConsentDialog(localized)).toMatchObject({ kind: "dialog" });
  });

  test("reads the context from the content description too", () => {
    const described = tree({ "content-desc": "TalkBack" }, consentButton);
    expect(findTalkBackConsentDialog(described)).toMatchObject({ kind: "dialog" });
  });

  test("finds a button nested under a single (non-array) child", () => {
    const nested: AccessibilityNode = {
      node: { node: [consentMessage, { node: consentButton }] },
    };
    expect(findTalkBackConsentDialog(nested)).toMatchObject({ kind: "dialog" });
  });

  test("ignores a button1 that belongs to an unrelated dialog", () => {
    const unrelated = tree({ text: "Allow this app to access your location?" }, consentButton);
    expect(findTalkBackConsentDialog(unrelated)).toEqual({ kind: "none" });
  });

  // The captured tree is one root whose children are each window's root, marked with the
  // native windowId (ViewHierarchyExtractor `UIElementInfo(children = sortedWindowRoots)`).
  const window = (windowId: number, ...children: AccessibilityNode[]): AccessibilityNode => ({
    windowId,
    node: children,
  });
  const multiWindow = (...windows: AccessibilityNode[]): AccessibilityNode => ({ node: windows });
  const otherWindowButton: AccessibilityNode = {
    ...consentButton,
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
  };

  test("never taps another window's button1 because TalkBack is mentioned in a different window", () => {
    const unrelatedDialog = window(
      7,
      { text: "Allow this app to access your location?" },
      otherWindowButton,
    );
    const talkBackWindow = window(9, { text: "TalkBack is on" });

    expect(findTalkBackConsentDialog(multiWindow(unrelatedDialog, talkBackWindow))).toEqual({
      kind: "none",
    });
    expect(findTalkBackConsentDialog(multiWindow(talkBackWindow, unrelatedDialog))).toEqual({
      kind: "none",
    });
  });

  test("taps the TalkBack window's own button even when another window also has a button1", () => {
    const unrelatedDialog = window(
      7,
      { text: "Allow this app to access your location?" },
      otherWindowButton,
    );
    const talkBackDialog = window(9, consentMessage, consentButton);

    expect(findTalkBackConsentDialog(multiWindow(unrelatedDialog, talkBackDialog))).toEqual({
      kind: "dialog",
      tap: { x: 360, y: 712 },
    });
  });

  test("finds the consent dialog when it is not in the first window", () => {
    const appWindow = window(1, { text: "Settings" });
    const dialogWindow = window(2, consentMessage, consentButton);

    expect(findTalkBackConsentDialog(multiWindow(appWindow, dialogWindow))).toMatchObject({
      kind: "dialog",
    });
  });

  test("reports none on a captured multi-window launcher hierarchy", () => {
    const capture = JSON.parse(
      readFileSync("test/fixtures/android-launcher/launcher-home-emulator-5600.json", "utf8"),
    ) as { rawViewHierarchy: { json: string } };
    const raw = JSON.parse(capture.rawViewHierarchy.json) as { hierarchy: AccessibilityNode };

    expect(raw.hierarchy.node).toHaveLength(2);
    expect(findTalkBackConsentDialog(raw.hierarchy)).toEqual({ kind: "none" });
  });

  test("reports no dialog when TalkBack is mentioned but there is no button", () => {
    expect(findTalkBackConsentDialog(tree(consentMessage))).toEqual({ kind: "none" });
  });

  test("reports a dialog without a tap target when the button has no bounds", () => {
    const unbounded: AccessibilityNode = { "resource-id": "android:id/button1", text: "Allow" };
    expect(findTalkBackConsentDialog(tree(consentMessage, unbounded))).toEqual({
      kind: "dialog",
      tap: null,
    });
  });
});

describe("CtrlProxyTalkBackDialogProbe", () => {
  const hierarchy = (root: AccessibilityNode): AccessibilityHierarchy => ({
    updatedAt: 1,
    packageName: "com.android.systemui",
    hierarchy: root,
  });

  const probeWith = (
    request: () => Promise<{ hierarchy: AccessibilityHierarchy } | null>,
    calls: unknown[][] = [],
  ) =>
    new CtrlProxyTalkBackDialogProbe(device, () => ({
      requestHierarchySyncWithoutObservationStreamPush: async (...args: unknown[]) => {
        calls.push(args);
        return request();
      },
    }));

  test("reads the CtrlProxy hierarchy without pushing it to the observation stream", async () => {
    const calls: unknown[][] = [];
    const probe = probeWith(
      async () => ({ hierarchy: hierarchy(tree(consentMessage, consentButton)) }),
      calls,
    );

    expect(await probe.probe()).toEqual({ kind: "dialog", tap: { x: 360, y: 712 } });
    expect(calls).toHaveLength(1);
  });

  test("reports none when CtrlProxy answers and no consent dialog is on screen", async () => {
    const probe = probeWith(async () => ({
      hierarchy: hierarchy(tree({ text: "Settings" })),
    }));

    expect(await probe.probe()).toEqual({ kind: "none" });
  });

  test("reports unavailable when CtrlProxy has no hierarchy", async () => {
    expect(await probeWith(async () => null).probe()).toEqual({ kind: "unavailable" });
  });

  test("reports unavailable when CtrlProxy returns a capture with no root", async () => {
    const rootless = { updatedAt: 1, packageName: "x", error: "no root" } as AccessibilityHierarchy;
    expect(await probeWith(async () => ({ hierarchy: rootless })).probe()).toEqual({
      kind: "unavailable",
    });
  });

  test("reports unavailable, never throws, when the request fails", async () => {
    const probe = probeWith(async () => {
      throw new Error("socket closed");
    });

    expect(await probe.probe()).toEqual({ kind: "unavailable" });
  });
});
