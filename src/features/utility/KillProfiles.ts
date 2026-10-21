/**
 * OEM background-kill profiles (#14051): named recipes that reproduce the
 * EFFECT of an OEM's background restrictions on a stock Android device, each
 * with the evidence behind it, modeled on the CtrlProxy `KeyboardProfile`
 * (id + evidence status). A profile simulates what the app observes; it does not
 * reproduce the OEM firmware that triggers it.
 */

/** How well a recipe is grounded, from strongest to weakest. */
export const KILL_PROFILE_EVIDENCE_STATUSES = [
  "vendor_documented",
  "cdd_derived",
  "inferred",
] as const;

export type KillProfileEvidenceStatus = (typeof KILL_PROFILE_EVIDENCE_STATUSES)[number];

/** App ops a recipe may change. Package-mode ops are set per package, uid-mode per uid. */
export type KillProfileAppOp = "RUN_ANY_IN_BACKGROUND" | "SCHEDULE_EXACT_ALARM";

/** One device command of a recipe, in the order it runs. */
export type KillProfileStep =
  /** `dumpsys battery unplug`: report the device as on battery. Restored by `dumpsys battery reset`. */
  | { kind: "batteryUnplug" }
  /** `am set-standby-bucket <pkg> <bucket>`. Restored to the bucket read before the first change. */
  | { kind: "standbyBucket"; bucket: "restricted" | "rare" }
  /** `appops set [--uid] <pkg> <op> <mode>`. Restored to the mode read before the first change. */
  | { kind: "appOp"; op: KillProfileAppOp; mode: "ignore" | "deny" }
  /** `dumpsys deviceidle force-idle`: force deep Doze. Restored by `dumpsys deviceidle unforce`. */
  | { kind: "forceIdle" }
  /** `input keyevent KEYCODE_HOME`: background the app first, as a recents swipe does. */
  | { kind: "home" }
  /** `am kill` (soft, background processes only) or `am force-stop` (hard). Not restorable. */
  | { kind: "kill"; mode: "soft" | "hard" };

export const KILL_PROFILE_IDS = [
  "samsung-sleeping",
  "samsung-deep-sleeping",
  "xiaomi-autostart-off",
  "oneplus-deep-optimization",
  "recents-swipe-kill",
  "recents-swipe-force-stop",
  "oneplus-sleep-standby",
  "motorola-adaptive",
  "user-restricted",
  "exact-alarm-denied",
] as const;

export type KillProfileId = (typeof KILL_PROFILE_IDS)[number];

export interface KillProfile {
  id: KillProfileId;
  /** Bumped whenever a recipe's steps change, so a result names the recipe it ran. */
  version: number;
  description: string;
  steps: readonly KillProfileStep[];
  evidenceStatus: KillProfileEvidenceStatus;
  evidenceNote: string;
  source?: string;
}

const SAMSUNG_APP_MANAGEMENT = "https://developer.samsung.com/mobile/app-management.html";
const ANDROID_TEST_POWER = "https://developer.android.com/topic/performance/power/test-power";
const ANDROID_16_CDD = "https://source.android.com/docs/compatibility/16/android-16-cdd";
const DONT_KILL_MY_APP = "https://dontkillmyapp.com/";
const ANDROID_EXACT_ALARMS =
  "https://developer.android.com/develop/background-work/services/alarms/schedule";

const FORCE_STOP_AND_RESTRICT: readonly KillProfileStep[] = [
  { kind: "kill", mode: "hard" },
  { kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" },
];

const FORCE_STOP_AND_RESTRICT_NOTE =
  "Approximated as a force-stop plus RUN_ANY_IN_BACKGROUND ignore: the app is stopped and may not " +
  "run in the background until reset. The OEM's own trigger and exemption UI are not reproduced.";

export const KILL_PROFILES: Readonly<Record<KillProfileId, KillProfile>> = {
  "samsung-sleeping": {
    id: "samsung-sleeping",
    version: 1,
    description: "Samsung 'Sleeping apps': on battery, app in the restricted standby bucket.",
    steps: [{ kind: "batteryUnplug" }, { kind: "standbyBucket", bucket: "restricted" }],
    evidenceStatus: "vendor_documented",
    evidenceNote:
      "Samsung documents sleeping apps as restricted from background work. The restricted bucket " +
      "needs API 30+; below that the bucket step reports unsupported.",
    source: SAMSUNG_APP_MANAGEMENT,
  },
  "samsung-deep-sleeping": {
    id: "samsung-deep-sleeping",
    version: 1,
    description: "Samsung 'Deep sleeping apps': stopped and never run in the background.",
    steps: FORCE_STOP_AND_RESTRICT,
    evidenceStatus: "inferred",
    evidenceNote: FORCE_STOP_AND_RESTRICT_NOTE,
    source: SAMSUNG_APP_MANAGEMENT,
  },
  "xiaomi-autostart-off": {
    id: "xiaomi-autostart-off",
    version: 1,
    description: "Xiaomi HyperOS/MIUI Autostart off: stopped and not restarted in the background.",
    steps: FORCE_STOP_AND_RESTRICT,
    evidenceStatus: "inferred",
    evidenceNote: FORCE_STOP_AND_RESTRICT_NOTE,
    source: DONT_KILL_MY_APP,
  },
  "oneplus-deep-optimization": {
    id: "oneplus-deep-optimization",
    version: 1,
    description: "OnePlus deep optimization: stopped and restricted from background execution.",
    steps: FORCE_STOP_AND_RESTRICT,
    evidenceStatus: "inferred",
    evidenceNote: FORCE_STOP_AND_RESTRICT_NOTE,
    source: DONT_KILL_MY_APP,
  },
  "recents-swipe-kill": {
    id: "recents-swipe-kill",
    version: 1,
    description: "Swipe away from recents, soft: background the app, then kill its processes.",
    steps: [{ kind: "home" }, { kind: "kill", mode: "soft" }],
    evidenceStatus: "inferred",
    evidenceNote:
      "Stock Android keeps the app's alarms and jobs after a recents swipe; `am kill` only ends its " +
      "background processes. Nothing to restore.",
    source: DONT_KILL_MY_APP,
  },
  "recents-swipe-force-stop": {
    id: "recents-swipe-force-stop",
    version: 1,
    description: "Swipe away from recents, hard (several OEMs): background, then force-stop.",
    steps: [{ kind: "home" }, { kind: "kill", mode: "hard" }],
    evidenceStatus: "inferred",
    evidenceNote:
      "Several OEMs force-stop on a recents swipe, which also cancels alarms and jobs until the user " +
      "opens the app again. Nothing to restore.",
    source: DONT_KILL_MY_APP,
  },
  "oneplus-sleep-standby": {
    id: "oneplus-sleep-standby",
    version: 1,
    description: "OnePlus sleep standby optimization: on battery, device forced into deep Doze.",
    steps: [{ kind: "batteryUnplug" }, { kind: "forceIdle" }],
    evidenceStatus: "inferred",
    evidenceNote:
      "Approximated with the AOSP Doze test recipe; force-idle needs the device on battery, so the " +
      "battery is unplugged first. Doze must be enabled on the device.",
    source: ANDROID_TEST_POWER,
  },
  "motorola-adaptive": {
    id: "motorola-adaptive",
    version: 1,
    description: "Motorola adaptive battery: app in the rare standby bucket.",
    steps: [{ kind: "standbyBucket", bucket: "rare" }],
    evidenceStatus: "inferred",
    evidenceNote: "Approximated by the AOSP rare bucket that adaptive battery assigns.",
    source: ANDROID_TEST_POWER,
  },
  "user-restricted": {
    id: "user-restricted",
    version: 1,
    description: "User-restricted background usage: RUN_ANY_IN_BACKGROUND ignore.",
    steps: [{ kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" }],
    evidenceStatus: "cdd_derived",
    evidenceNote:
      "Android 16 CDD 3.5.1: an OEM restriction stricter than the restricted bucket must return true " +
      "for ActivityManager.isBackgroundRestricted(); this appop produces that signal on stock Android.",
    source: ANDROID_16_CDD,
  },
  "exact-alarm-denied": {
    id: "exact-alarm-denied",
    version: 1,
    description: "Exact alarms revoked: SCHEDULE_EXACT_ALARM denied for the app's uid.",
    steps: [{ kind: "appOp", op: "SCHEDULE_EXACT_ALARM", mode: "deny" }],
    evidenceStatus: "vendor_documented",
    evidenceNote:
      "AOSP behaviour when the user turns off 'Alarms & reminders' (API 31+). Apps that declare " +
      "USE_EXACT_ALARM keep the permission.",
    source: ANDROID_EXACT_ALARMS,
  },
};

/** OEM behaviour no recipe can reproduce on a stock device; reported by `list`. */
export const KILL_PROFILE_NON_EMULATABLE: readonly { id: string; note: string }[] = [
  {
    id: "oem-unused-app-triggers",
    note: "OEM triggers such as 'unused for 3 days' that move an app into a sleeping list.",
  },
  {
    id: "firmware-update-exemption-reset",
    note: "Battery-optimization exemptions that a firmware update resets.",
  },
  {
    id: "xiaomi-proprietary-appops",
    note: "Xiaomi proprietary AppOps 10008/10021 (autostart, background start); community-reported only.",
  },
];
