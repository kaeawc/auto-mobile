import { describe, expect, test } from "bun:test";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../../src/models";
import {
  chooseSystemAlertButton,
  detectSystemAlert,
} from "../../../../src/features/action/systemAlerts/SystemAlertDetection";

const node = (attrs: Record<string, unknown>, children?: ViewHierarchyNode[]): ViewHierarchyNode =>
  ({ $: attrs, ...(children ? { node: children } : {}) }) as ViewHierarchyNode;
const tree = (root: ViewHierarchyNode, packageName?: string): ViewHierarchyResult => ({
  hierarchy: { node: root },
  ...(packageName ? { packageName } : {}),
});
const bounds = { left: 0, top: 0, right: 100, bottom: 50 };
const pc = (id: string) => `com.android.permissioncontroller:id/${id}`;

const androidLocationDialog = (labels = ["While using the app", "Only this time", "Don't allow"]) =>
  tree(
    node({ "resource-id": pc("grant_dialog"), bounds }, [
      node({
        "resource-id": pc("permission_message"),
        text: "Allow Demo to access this device's location?",
        bounds,
      }),
      node({
        "resource-id": pc("permission_allow_foreground_only_button"),
        text: labels[0],
        clickable: true,
        bounds,
      }),
      node({
        "resource-id": pc("permission_allow_one_time_button"),
        text: labels[1],
        clickable: true,
        bounds,
      }),
      node({
        "resource-id": pc("permission_deny_button"),
        text: labels[2],
        clickable: true,
        bounds,
      }),
    ]),
  );

const iosAlert = (message: string, buttons: string[]) =>
  tree(
    node({ className: "UIApplication", text: "Demo", bounds }, [
      node({ className: "UIAlertController", text: message, bounds }, [
        ...buttons.map((label) =>
          node({ className: "UIButton", role: "button", text: label, clickable: true, bounds }),
        ),
      ]),
    ]),
  );

describe("detectSystemAlert (#14106)", () => {
  test("finds an Android permission-controller dialog by resource id", () => {
    const alert = detectSystemAlert("android", androidLocationDialog());
    expect(alert).toMatchObject({
      recognized: true,
      message: "Allow Demo to access this device's location?",
    });
    expect(alert?.buttons.map((button) => [button.label, button.kind])).toEqual([
      ["While using the app", "allow"],
      ["Only this time", "allowOnce"],
      ["Don't allow", "deny"],
    ]);
    expect(alert?.buttons[0].selector).toEqual({
      elementId: pc("permission_allow_foreground_only_button"),
    });
  });

  test("classifies Android buttons by resource id, so localized labels still match", () => {
    const alert = detectSystemAlert(
      "android",
      androidLocationDialog(["Während der App-Nutzung", "Nur dieses Mal", "Nicht zulassen"]),
    );
    expect(alert?.buttons.map((button) => button.kind)).toEqual(["allow", "allowOnce", "deny"]);
  });

  test("finds an iOS permission alert by its Don't Allow button", () => {
    const alert = detectSystemAlert(
      "ios",
      iosAlert("Allow “Demo” to use your location?", [
        "Allow Once",
        "Allow While Using App",
        "Don’t Allow",
      ]),
    );
    expect(alert).toMatchObject({
      recognized: true,
      message: "Allow “Demo” to use your location?",
    });
    expect(alert?.buttons.map((button) => [button.label, button.kind])).toEqual([
      ["Allow Once", "allowOnce"],
      ["Allow While Using App", "allow"],
      ["Don’t Allow", "deny"],
    ]);
    expect(alert?.buttons[1].selector).toEqual({ text: "Allow While Using App" });
  });

  test("an iOS alert without a known Don't Allow label is detected but not recognized", () => {
    const localized = detectSystemAlert(
      "ios",
      iosAlert("„Demo“ möchte auf deine Kamera zugreifen", ["Nicht erlauben", "Erlauben"]),
    );
    expect(localized).toMatchObject({ recognized: false });
    const appOwned = detectSystemAlert("ios", iosAlert("Delete note?", ["Cancel", "OK"]));
    expect(appOwned).toMatchObject({ recognized: false, message: "Delete note?" });
  });

  test("returns null when no alert is showing", () => {
    expect(detectSystemAlert("android", tree(node({ text: "Home", bounds })))).toBeNull();
    expect(
      detectSystemAlert("ios", tree(node({ className: "UIButton", text: "OK", bounds }))),
    ).toBeNull();
  });
});

describe("chooseSystemAlertButton (#14106)", () => {
  const location = detectSystemAlert("android", androidLocationDialog())!;
  const notification = detectSystemAlert(
    "android",
    tree(
      node({ bounds }, [
        node({
          "resource-id": pc("permission_message"),
          text: "Allow Demo to send you notifications?",
          bounds,
        }),
        node({ "resource-id": pc("permission_allow_button"), text: "Allow", bounds }),
        node({ "resource-id": pc("permission_deny_button"), text: "Don't allow", bounds }),
      ]),
    ),
  )!;

  test("report never chooses a button", () => {
    expect(chooseSystemAlertButton(location, "report", [])).toEqual({ answer: "report" });
  });

  test("allow, allowOnce and deny pick the matching kind", () => {
    expect(chooseSystemAlertButton(location, "allow", [])).toMatchObject({
      answer: "tap",
      button: { label: "While using the app" },
    });
    expect(chooseSystemAlertButton(location, "allowOnce", [])).toMatchObject({
      answer: "tap",
      button: { label: "Only this time" },
    });
    expect(chooseSystemAlertButton(location, "deny", [])).toMatchObject({
      answer: "tap",
      button: { label: "Don't allow" },
    });
  });

  test("allowOnce falls back to allow when the alert offers no one-time grant", () => {
    expect(chooseSystemAlertButton(notification, "allowOnce", [])).toMatchObject({
      answer: "tap",
      button: { label: "Allow" },
    });
  });

  test("an unrecognized alert is reported as unmatched instead of tapped", () => {
    const alert = detectSystemAlert("ios", iosAlert("Delete note?", ["Cancel", "OK"]))!;
    expect(chooseSystemAlertButton(alert, "allow", [])).toEqual({ answer: "unmatched" });
  });

  test("a match entry answers any alert, including a localized one", () => {
    const alert = detectSystemAlert(
      "ios",
      iosAlert("„Demo“ möchte auf deine Kamera zugreifen", ["Nicht erlauben", "Erlauben"]),
    )!;
    expect(
      chooseSystemAlertButton(alert, "report", [
        { textContains: "kamera", buttonText: "erlauben" },
      ]),
    ).toMatchObject({ answer: "tap", button: { label: "Erlauben" } });
    expect(
      chooseSystemAlertButton(alert, "allow", [
        { textContains: "Mikrofon", buttonText: "Erlauben" },
      ]),
    ).toEqual({ answer: "unmatched" });
  });

  test("a match entry without textContains answers any alert with that button", () => {
    const alert = detectSystemAlert("ios", iosAlert("Delete note?", ["Cancel", "OK"]))!;
    expect(chooseSystemAlertButton(alert, "report", [{ buttonText: "cancel" }])).toMatchObject({
      answer: "tap",
      button: { label: "Cancel" },
    });
  });

  test("App Tracking Transparency and Contacts prompts are recognized iOS permission prompts", () => {
    const tracking = detectSystemAlert(
      "ios",
      iosAlert("Allow “Demo” to track your activity across other companies’ apps and websites?", [
        "Ask App Not to Track",
        "Allow",
      ]),
    )!;
    expect(tracking.recognized).toBe(true);
    expect(chooseSystemAlertButton(tracking, "deny", [])).toMatchObject({
      button: { label: "Ask App Not to Track" },
    });
    const contacts = detectSystemAlert(
      "ios",
      iosAlert("“Demo” Would Like to Access Your Contacts", ["Don’t Allow", "Continue"]),
    )!;
    expect(chooseSystemAlertButton(contacts, "allow", [])).toMatchObject({
      button: { label: "Continue" },
    });
  });
});
