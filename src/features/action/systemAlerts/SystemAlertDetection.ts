import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../models";
import { ViewHierarchyParser } from "../../../utils/ViewHierarchyParser";
import type { SystemAlertMatch, SystemAlertPolicyName } from "./SystemAlertPolicy";

export type SystemAlertButtonKind = "allow" | "allowOnce" | "deny" | "other";

export interface SystemAlertButton {
  label: string;
  kind: SystemAlertButtonKind;
  /** Lower ranks win when several buttons share a kind. */
  rank: number;
  /** The `tapOn` selector for this button: a resource id on Android, its label on iOS. */
  selector: { elementId: string } | { text: string };
}

export interface DetectedSystemAlert {
  platform: "android" | "ios";
  message: string;
  buttons: SystemAlertButton[];
  /**
   * A recognized OS permission prompt. An unrecognized alert (an app's own alert, or a
   * system alert in a language the labels below do not cover) is never answered by policy.
   */
  recognized: boolean;
}

export type SystemAlertDecision =
  | { answer: "report" }
  | { answer: "unmatched" }
  | { answer: "tap"; button: SystemAlertButton };

const parser = new ViewHierarchyParser();

// AOSP's permission controller (Android 10+) and the package installer before it.
const ANDROID_PERMISSION_ID =
  /^com\.(?:google\.)?android\.(?:permissioncontroller|packageinstaller):id\/(permission_\w+)$/;

/** Android permission buttons by resource-id name, so any device locale matches (#14106). */
const ANDROID_BUTTONS: Record<string, { kind: SystemAlertButtonKind; rank: number }> = {
  permission_allow_foreground_only_button: { kind: "allow", rank: 0 },
  permission_allow_button: { kind: "allow", rank: 1 },
  permission_allow_all_button: { kind: "allow", rank: 2 },
  permission_allow_always_button: { kind: "allow", rank: 3 },
  permission_allow_one_time_button: { kind: "allowOnce", rank: 0 },
  permission_deny_button: { kind: "deny", rank: 0 },
  permission_deny_and_dont_ask_again_button: { kind: "deny", rank: 1 },
};

const IOS_ALERT_CLASSES = new Set([
  "UIAlertController",
  "UIActionSheet",
  "XCUIElementTypeAlert",
  "XCUIElementTypeSheet",
]);
const IOS_BUTTON_CLASSES = new Set(["UIButton", "XCUIElementTypeButton"]);

/**
 * English iOS permission-prompt labels, normalized (lowercase, straight apostrophes). Every
 * iOS permission prompt offers a refusal ("Don't Allow", or "Ask App Not to Track" for App
 * Tracking Transparency), so a refusal label is what marks an alert as one;
 * other languages are reported as unmatched unless a `match` entry names the button.
 */
const IOS_BUTTONS: Record<string, { kind: SystemAlertButtonKind; rank: number }> = {
  "allow while using app": { kind: "allow", rank: 0 },
  allow: { kind: "allow", rank: 1 },
  "allow full access": { kind: "allow", rank: 2 },
  "allow access to all photos": { kind: "allow", rank: 3 },
  ok: { kind: "allow", rank: 4 },
  continue: { kind: "allow", rank: 5 },
  "allow once": { kind: "allowOnce", rank: 0 },
  "don't allow": { kind: "deny", rank: 0 },
  "ask app not to track": { kind: "deny", rank: 1 },
};

function normalizeLabel(label: string): string {
  return label
    .replace(/[‘’]/g, "'")
    .trim()
    .toLowerCase();
}

function attributes(node: ViewHierarchyNode): Record<string, unknown> {
  return parser.extractNodeProperties(node) as Record<string, unknown>;
}

function stringAttr(attrs: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function nodeLabel(attrs: Record<string, unknown>): string | undefined {
  return stringAttr(attrs, "text", "content-desc", "ios-accessibility-label", "label");
}

function allRoots(hierarchy: ViewHierarchyResult): ViewHierarchyNode[] {
  return [...parser.extractRootNodes(hierarchy), ...parser.extractWindowRootNodes(hierarchy)];
}

function detectAndroidAlert(hierarchy: ViewHierarchyResult): DetectedSystemAlert | null {
  const messages: string[] = [];
  const buttons: SystemAlertButton[] = [];
  for (const root of allRoots(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attrs = attributes(node);
      const id = stringAttr(attrs, "resource-id");
      const name = id?.match(ANDROID_PERMISSION_ID)?.[1];
      if (!id || !name) {
        return;
      }
      const label = nodeLabel(attrs) ?? name;
      if (name === "permission_message") {
        messages.push(label);
        return;
      }
      const known = ANDROID_BUTTONS[name];
      if (known || /^permission_(?:allow|deny)\w*_button$/.test(name)) {
        if (
          !buttons.some(
            (button) => "elementId" in button.selector && button.selector.elementId === id,
          )
        ) {
          buttons.push({
            label,
            ...(known ?? { kind: "other", rank: 0 }),
            selector: { elementId: id },
          });
        }
      }
    });
  }
  if (buttons.length === 0) {
    return null;
  }
  return {
    platform: "android",
    message: messages.join(" "),
    buttons,
    recognized: buttons.some((button) => button.kind !== "other"),
  };
}

function iosAlertContent(alert: ViewHierarchyNode): {
  texts: string[];
  buttons: SystemAlertButton[];
} {
  const texts: string[] = [];
  const buttons: SystemAlertButton[] = [];
  parser.traverseNode(alert, (node: ViewHierarchyNode) => {
    const attrs = attributes(node);
    const label = nodeLabel(attrs);
    if (!label) {
      return;
    }
    const className = stringAttr(attrs, "className", "class");
    if (attrs.role === "button" || (className && IOS_BUTTON_CLASSES.has(className))) {
      const known = IOS_BUTTONS[normalizeLabel(label)];
      buttons.push({ label, ...(known ?? { kind: "other", rank: 0 }), selector: { text: label } });
    } else if (!texts.includes(label)) {
      texts.push(label);
    }
  });
  return { texts, buttons };
}

function detectIosAlert(hierarchy: ViewHierarchyResult): DetectedSystemAlert | null {
  let alert: ViewHierarchyNode | undefined;
  for (const root of allRoots(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const className = stringAttr(attributes(node), "className", "class");
      if (!alert && className && IOS_ALERT_CLASSES.has(className)) {
        alert = node;
      }
    });
  }
  if (!alert) {
    return null;
  }
  const { texts, buttons } = iosAlertContent(alert);
  if (buttons.length === 0) {
    return null;
  }
  return {
    platform: "ios",
    message: texts.join(" "),
    buttons,
    recognized: buttons.some((button) => button.kind === "deny"),
  };
}

/** The OS permission or system alert showing in `hierarchy`, or null when there is none. */
export function detectSystemAlert(
  platform: "android" | "ios",
  hierarchy: ViewHierarchyResult | null | undefined,
): DetectedSystemAlert | null {
  if (!hierarchy) {
    return null;
  }
  return platform === "android" ? detectAndroidAlert(hierarchy) : detectIosAlert(hierarchy);
}

function bestOfKind(
  alert: DetectedSystemAlert,
  kind: SystemAlertButtonKind,
): SystemAlertButton | undefined {
  return alert.buttons
    .filter((button) => button.kind === kind)
    .sort((left, right) => left.rank - right.rank)[0];
}

function buttonForPolicy(
  alert: DetectedSystemAlert,
  policy: Exclude<SystemAlertPolicyName, "report">,
): SystemAlertButton | undefined {
  if (policy === "allowOnce") {
    return bestOfKind(alert, "allowOnce") ?? bestOfKind(alert, "allow");
  }
  return bestOfKind(alert, policy);
}

function matchApplies(alert: DetectedSystemAlert, entry: SystemAlertMatch): boolean {
  return (
    entry.textContains === undefined ||
    alert.message.toLowerCase().includes(entry.textContains.toLowerCase())
  );
}

/**
 * The button `policy` answers `alert` with. A `match` entry whose `textContains` fits the alert
 * (or that has none) names its button by `buttonText`, in any language and on any alert; an
 * alert no entry answers falls back to the policy.
 */
export function chooseSystemAlertButton(
  alert: DetectedSystemAlert,
  policy: SystemAlertPolicyName,
  match: readonly SystemAlertMatch[],
): SystemAlertDecision {
  for (const entry of match) {
    if (!matchApplies(alert, entry)) {
      continue;
    }
    const wanted = normalizeLabel(entry.buttonText);
    const button = alert.buttons.find((candidate) => normalizeLabel(candidate.label) === wanted);
    if (button) {
      return { answer: "tap", button };
    }
  }
  if (policy === "report") {
    return { answer: "report" };
  }
  const button = alert.recognized ? buttonForPolicy(alert, policy) : undefined;
  return button ? { answer: "tap", button } : { answer: "unmatched" };
}
