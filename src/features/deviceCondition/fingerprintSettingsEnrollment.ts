import { parseStringPromise } from "xml2js";
import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { parseBounds } from "../../utils/bounds";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { uiautomatorDumpLock } from "../action/uiautomatorDumpLock";
import { shell } from "./injectorSupport";

/**
 * Drives the Android Settings fingerprint enrollment flow on an emulator (#17299). There is no
 * shell command that enrolls a fingerprint, so this opens Settings' enroll screen, confirms the
 * AutoMobile test PIN, accepts the intro, and touches the emulator's virtual sensor through the
 * console until the enrolled count read from `dumpsys fingerprint` goes up.
 *
 * Screens are matched by resource id where Settings has a stable one and by English text
 * otherwise, so another system language reports the unrecognized screen instead of guessing.
 */

/** Public Settings action that opens fingerprint enrollment (API 28+, still handled on 35+). */
export const FINGERPRINT_ENROLL_ACTION = "android.settings.FINGERPRINT_ENROLL";

const DUMP_PATH = "/data/local/tmp/automobile-fingerprint-enroll.xml";

/** Upper bound on screen reads; emulator enrollment takes roughly a dozen sensor touches. */
export const ENROLL_MAX_STEPS = 60;
/** Consecutive unrecognized screens tolerated while Settings animates between pages. */
export const ENROLL_MAX_UNKNOWN_STREAK = 5;
/** PIN entries tolerated before the credential screen is treated as a rejected PIN. */
export const ENROLL_MAX_CREDENTIAL_ENTRIES = 2;
export const ENROLL_SETTLE_MS = 750;

/** Text on the screens that wait for a sensor touch: find-sensor and the enrolling progress. */
const TOUCH_SCREEN_TEXT =
  /touch the sensor|lift, then touch again|keep lifting|put your finger|place your finger|find the sensor|touch & hold|touch and hold/i;

/** Ids of the enrolling progress views, in Settings builds that have them. */
const TOUCH_SCREEN_ID = /:id\/(fingerprint_progress_bar|fingerprint_animator)$/;

/** The PIN entry field of Settings' confirm-credential screen. */
const CREDENTIAL_ID = /:id\/password_entry$/;

/** Buttons that move the flow forward, most specific first. "More" scrolls the consent page. */
const ADVANCE_LABELS = ["I agree", "Agree", "Next", "Start", "Continue", "Got it", "OK", "More"];

export interface EnrollmentScreenNode {
  text: string;
  resourceId: string;
  contentDesc: string;
  centre?: { x: number; y: number };
}

export type EnrollmentScreen =
  | { kind: "credential" }
  | { kind: "touch-sensor" }
  | { kind: "advance"; label: string; tap: { x: number; y: number } }
  | { kind: "unknown"; summary: string };

/** Decide what the current Settings screen asks for. Exported for tests. */
export function classifyEnrollmentScreen(nodes: readonly EnrollmentScreenNode[]): EnrollmentScreen {
  if (nodes.some((node) => CREDENTIAL_ID.test(node.resourceId))) {
    return { kind: "credential" };
  }
  if (
    nodes.some(
      (node) =>
        TOUCH_SCREEN_ID.test(node.resourceId) ||
        TOUCH_SCREEN_TEXT.test(node.text) ||
        TOUCH_SCREEN_TEXT.test(node.contentDesc),
    )
  ) {
    return { kind: "touch-sensor" };
  }
  for (const label of ADVANCE_LABELS) {
    const button = nodes.find(
      (node) => node.centre && node.text.trim().toLowerCase() === label.toLowerCase(),
    );
    if (button?.centre) {
      return { kind: "advance", label, tap: button.centre };
    }
  }
  const summary = nodes
    .map((node) => node.text.trim())
    .filter((text) => text.length > 0)
    .slice(0, 6)
    .join(" | ");
  return { kind: "unknown", summary: summary || "no readable text" };
}

interface XmlNode {
  $?: Record<string, string>;
  node?: XmlNode[];
}

function flatten(nodes: readonly XmlNode[]): EnrollmentScreenNode[] {
  return nodes.flatMap((node) => {
    const attributes = node.$ ?? {};
    const bounds = parseBounds(attributes.bounds);
    const own: EnrollmentScreenNode = {
      text: attributes.text ?? "",
      resourceId: attributes["resource-id"] ?? "",
      contentDesc: attributes["content-desc"] ?? "",
      ...(bounds && bounds.right > bounds.left && bounds.bottom > bounds.top
        ? {
            centre: {
              x: Math.round((bounds.left + bounds.right) / 2),
              y: Math.round((bounds.top + bounds.bottom) / 2),
            },
          }
        : {}),
    };
    return [own, ...flatten(node.node ?? [])];
  });
}

/** Parse a `uiautomator dump` into flat nodes; an unreadable dump is an empty screen. */
export async function parseEnrollmentScreen(xml: string): Promise<EnrollmentScreenNode[]> {
  const start = xml.indexOf("<?xml");
  const body = start >= 0 ? xml.slice(start) : xml;
  if (!body.includes("<hierarchy")) {
    return [];
  }
  const parsed: { hierarchy?: XmlNode } = await parseStringPromise(body, { explicitArray: true });
  return flatten(parsed.hierarchy?.node ?? []);
}

export interface FingerprintSettingsEnrollmentDeps {
  adb: AdbExecutor;
  timer: Timer;
  /** Serializes dumps with every other `uiautomator dump` on the device. */
  deviceId: string;
  pin: string;
  enrolledCount(signal?: AbortSignal): Promise<number>;
  /** Touch, then lift, the emulator's virtual sensor with `fingerId`. */
  touchSensor(fingerId: number, signal?: AbortSignal): Promise<void>;
}

async function readScreen(
  deps: FingerprintSettingsEnrollmentDeps,
  signal?: AbortSignal,
): Promise<EnrollmentScreenNode[]> {
  const xml = await uiautomatorDumpLock(deps.deviceId).runExclusive(async () => {
    await shell(deps.adb, ["uiautomator", "dump", DUMP_PATH], signal);
    return shell(deps.adb, ["cat", DUMP_PATH], signal);
  });
  return parseEnrollmentScreen(xml);
}

interface FlowState {
  unknownStreak: number;
  credentialEntries: number;
  lastSummary: string;
}

/** Act on one screen; throws when the flow cannot make progress. */
async function step(
  deps: FingerprintSettingsEnrollmentDeps,
  fingerId: number,
  state: FlowState,
  signal?: AbortSignal,
): Promise<void> {
  const screen = classifyEnrollmentScreen(await readScreen(deps, signal));
  state.unknownStreak = screen.kind === "unknown" ? state.unknownStreak + 1 : 0;
  switch (screen.kind) {
    case "credential":
      state.credentialEntries += 1;
      if (state.credentialEntries > ENROLL_MAX_CREDENTIAL_ENTRIES) {
        throw new ActionableError(
          "Settings kept asking for the lock-screen PIN; the AutoMobile test PIN was not accepted.",
        );
      }
      await shell(deps.adb, ["input", "text", deps.pin], signal);
      await shell(deps.adb, ["input", "keyevent", "KEYCODE_ENTER"], signal);
      return;
    case "touch-sensor":
      await deps.touchSensor(fingerId, signal);
      return;
    case "advance":
      await shell(deps.adb, ["input", "tap", String(screen.tap.x), String(screen.tap.y)], signal);
      return;
    case "unknown":
      state.lastSummary = screen.summary;
      if (state.unknownStreak >= ENROLL_MAX_UNKNOWN_STREAK) {
        throw new ActionableError(
          `Fingerprint enrollment stopped on a Settings screen AutoMobile does not recognize (${screen.summary}). ` +
            "The flow is matched in English; set the emulator's language to English and retry.",
        );
      }
  }
}

/**
 * Enroll one fingerprint with `fingerId` through Settings, resolving once `dumpsys fingerprint`
 * reports `targetCount` enrollments. Leaves Settings with HOME. A lock-screen credential must be
 * set to `deps.pin` first: Settings will not enroll without one.
 */
export async function enrollFingerprintThroughSettings(
  deps: FingerprintSettingsEnrollmentDeps,
  fingerId: number,
  targetCount: number,
  signal?: AbortSignal,
): Promise<void> {
  await shell(deps.adb, ["am", "start", "-W", "-a", FINGERPRINT_ENROLL_ACTION], signal);
  const state: FlowState = { unknownStreak: 0, credentialEntries: 0, lastSummary: "" };
  for (let attempt = 0; attempt < ENROLL_MAX_STEPS; attempt++) {
    throwIfAborted(signal);
    if ((await deps.enrolledCount(signal)) >= targetCount) {
      await shell(deps.adb, ["input", "keyevent", "KEYCODE_HOME"], signal);
      return;
    }
    await step(deps, fingerId, state, signal);
    await deps.timer.sleep(ENROLL_SETTLE_MS);
  }
  throw new ActionableError(
    `Fingerprint enrollment did not finish within ${ENROLL_MAX_STEPS} Settings steps` +
      (state.lastSummary ? ` (last unrecognized screen: ${state.lastSummary}).` : "."),
  );
}
