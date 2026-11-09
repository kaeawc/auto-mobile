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
export type KillProfileAppOp =
  | "RUN_ANY_IN_BACKGROUND"
  | "SCHEDULE_EXACT_ALARM"
  | "WAKE_LOCK"
  | "POST_NOTIFICATION";

/** One device command of a recipe, in the order it runs. */
export type KillProfileStep =
  /** `dumpsys battery unplug`: report the device as on battery. Restored by `dumpsys battery reset`. */
  | { kind: "batteryUnplug" }
  /** `am set-standby-bucket <pkg> <bucket>`. Restored to the bucket read before the first change. */
  | { kind: "standbyBucket"; bucket: "restricted" | "rare" }
  /** `appops set [--uid] <pkg> <op> <mode>`. Restored to the mode read before the first change. */
  | { kind: "appOp"; op: KillProfileAppOp; mode: "ignore" | "deny" }
  /** Revoke POST_NOTIFICATIONS on API 33+, restoring the grant read before the first change. */
  | { kind: "notificationPermission"; mode: "revoke" }
  /** App hibernation, restored to the state read before the first change. */
  | { kind: "hibernation" }
  /** Revoke all currently granted runtime permissions; restore the captured set (API 23+). */
  | { kind: "runtimePermissions" }
  /** Open Settings and confirm another package is top resumed. Nothing to restore. */
  | { kind: "foregroundChange" }
  /** Sleep the screen, verify it, then wait; wake on reset only if initially awake. */
  | { kind: "screenOff"; minutes: number }
  /** Observe boot receivers, stopped state and pending alarms without sending a broadcast. */
  | { kind: "bootReceiverCheck" }
  /** `dumpsys deviceidle force-idle`: force deep Doze. Restored by `dumpsys deviceidle unforce`. */
  | { kind: "forceIdle" }
  /** `input keyevent KEYCODE_HOME`: background the app first, as a recents swipe does. */
  | { kind: "home" }
  /** `am kill` (soft, background processes only) or `am force-stop` (hard). Not restorable. */
  | { kind: "kill"; mode: "soft" | "hard" };

export const KILL_PROFILE_IDS = [
  "samsung-sleeping",
  "samsung-deep-sleeping",
  "samsung-auto-disable",
  "samsung-foreground-kill",
  "screen-off-stop",
  "xiaomi-autostart-off",
  "oneplus-deep-optimization",
  "recents-swipe-kill",
  "recents-swipe-force-stop",
  "oneplus-sleep-standby",
  "motorola-adaptive",
  "user-restricted",
  "exact-alarm-denied",
  "notifications-off",
  "huawei-powergenie",
  "vivo-autostart",
  "realme-power-saver",
  "meizu-flyme-background",
  "asus-power-master",
  "sony-stamina",
  "tecno-app-halt",
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

const BOOT_CHECK_NOTE =
  " Boot-receiver observation predicts default delivery without sending BOOT_COMPLETED: shell is denied " +
  "this protected broadcast (SecurityException). Root checks on stock API 35 show a force-stopped package " +
  "receives no default broadcast (no process starts), but does with --include-stopped-packages. " +
  "A non-stopped package still receives it with RUN_ANY_IN_BACKGROUND=ignore or the restricted bucket; " +
  "only stopped state blocks delivery on stock Android when a receiver and permission are present.";

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
    version: 2,
    description: "Samsung 'Deep sleeping apps': stopped and never run in the background.",
    steps: [...FORCE_STOP_AND_RESTRICT, { kind: "appOp", op: "WAKE_LOCK", mode: "ignore" }],
    evidenceStatus: "inferred",
    evidenceNote:
      FORCE_STOP_AND_RESTRICT_NOTE +
      " WAKE_LOCK ignore simulates Samsung's foreground-service wake-lock denial on Android 11; " +
      "this is inferred, not a vendor-documented capture.",
    source: SAMSUNG_APP_MANAGEMENT,
  },
  "samsung-auto-disable": {
    id: "samsung-auto-disable",
    version: 2,
    description:
      "Samsung auto-disable of unused apps: runtime permissions revoked and app hibernation.",
    steps: [{ kind: "runtimePermissions" }, { kind: "hibernation" }],
    evidenceStatus: "inferred",
    evidenceNote:
      "Approximated by explicit runtime permission revocation and AOSP app hibernation. Hibernation alone does not revoke permissions of preinstalled apps. " +
      "Restores the captured granted permission set and hibernation state read before the first change; the unused-for-N-days trigger " +
      "is not reproduced.",
    source: SAMSUNG_APP_MANAGEMENT,
  },
  "samsung-foreground-kill": {
    id: "samsung-foreground-kill",
    version: 1,
    description:
      "Samsung Game Booster / Good Guardians: force-stop after another app comes to the foreground.",
    steps: [{ kind: "foregroundChange" }, { kind: "kill", mode: "hard" }],
    evidenceStatus: "inferred",
    evidenceNote:
      "Opens Settings, verifies another app is foreground, then force-stops. Approximates Game Booster / Good Guardians; OEM trigger and exemption policies are not reproduced.",
    source: "https://dontkillmyapp.com/samsung",
  },
  "screen-off-stop": {
    id: "screen-off-stop",
    version: 1,
    description: "Screen-off cleanup: wait one minute with the screen off, then force-stop.",
    steps: [
      { kind: "screenOff", minutes: 1 },
      { kind: "kill", mode: "hard" },
    ],
    evidenceStatus: "inferred",
    evidenceNote:
      "Approximates Asus Power Master, Meizu Protected apps and realme/Tecno screen-off cleanup with an explicit one-minute wait. Restores an initially awake screen; the N-days-unused trigger remains non-emulatable.",
    source: DONT_KILL_MY_APP,
  },
  "xiaomi-autostart-off": {
    id: "xiaomi-autostart-off",
    version: 2,
    description: "Xiaomi HyperOS/MIUI Autostart off: stopped and not restarted in the background.",
    steps: [...FORCE_STOP_AND_RESTRICT, { kind: "bootReceiverCheck" }],
    evidenceStatus: "inferred",
    evidenceNote: FORCE_STOP_AND_RESTRICT_NOTE + BOOT_CHECK_NOTE,
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
  "notifications-off": {
    id: "notifications-off",
    version: 2,
    description: "Notifications off: POST_NOTIFICATIONS runtime permission revoked (Android 13+).",
    steps: [{ kind: "notificationPermission", mode: "revoke" }],
    evidenceStatus: "inferred",
    evidenceNote:
      "Revokes the POST_NOTIFICATIONS runtime permission, as the Settings notification toggle does " +
      "on Android 13+. Restored to the grant read before the first change; an already-denied " +
      "permission stays denied.",
  },
  "huawei-powergenie": {
    id: "huawei-powergenie",
    version: 2,
    description:
      "Huawei EMUI: Classic battery optimization: Don't allow and background restriction.",
    steps: [
      { kind: "standbyBucket", bucket: "restricted" },
      { kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" },
      { kind: "appOp", op: "WAKE_LOCK", mode: "ignore" },
      { kind: "bootReceiverCheck" },
    ],
    evidenceStatus: "inferred",
    evidenceNote:
      'Battery > App launch set to "Manage manually" with Auto-launch, Secondary launch and Run in background switched off is approximated by the restricted bucket, RUN_ANY_IN_BACKGROUND ignore and WAKE_LOCK ignore, plus boot receiver observation. Mechanisms from the dontkillmyapp.com Huawei entry (CC-BY-4.0). samsung-foreground-kill gives a foreground-change kill; screen-off-stop gives a screen-off kill. Not emulated: PowerGenie/HwPFWService killing every non-whitelisted app after about 60 minutes in the background, using a Huawei-maintained whitelist; System Manager Smart tune-up cleanup.' +
      BOOT_CHECK_NOTE,
    source: "https://dontkillmyapp.com/huawei",
  },
  "vivo-autostart": {
    id: "vivo-autostart",
    version: 2,
    description: "Vivo Funtouch OS: Per-app background power restriction (Android 13).",
    steps: [
      { kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" },
      { kind: "standbyBucket", bucket: "restricted" },
      { kind: "bootReceiverCheck" },
    ],
    evidenceStatus: "inferred",
    evidenceNote:
      "Android 13 background power restriction is approximated by background restriction and the restricted bucket, plus boot receiver observation. Mechanisms from the dontkillmyapp.com Vivo entry (CC-BY-4.0). Not emulated: the proprietary Autostart permission (stock delivery is only observed); taskbar app lock." +
      BOOT_CHECK_NOTE,
    source: "https://dontkillmyapp.com/vivo",
  },
  "realme-power-saver": {
    id: "realme-power-saver",
    version: 2,
    description: "realme UI: Power saving on battery with App battery management set to Optimize.",
    steps: [
      { kind: "batteryUnplug" },
      { kind: "standbyBucket", bucket: "restricted" },
      { kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" },
    ],
    evidenceStatus: "inferred",
    evidenceNote:
      "Power saving on battery and App battery management Optimize are approximated by battery unplug, the restricted bucket and background restriction. Mechanisms from the dontkillmyapp.com realme entry (CC-BY-4.0). The separate screen-off-stop profile approximates screen-off cleanup. Not emulated: Super power saving mode's 6-app limit; auto power-saving trigger levels; OEM sleep schedules.",
    source: "https://dontkillmyapp.com/realme",
  },
  "meizu-flyme-background": {
    id: "meizu-flyme-background",
    version: 2,
    description:
      'Meizu Flyme: Background processes not allowed and "keep running after screen off" off (wake-lock denial).',
    steps: [
      { kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" },
      { kind: "appOp", op: "WAKE_LOCK", mode: "ignore" },
    ],
    evidenceStatus: "inferred",
    evidenceNote:
      "Background processes not allowed is approximated by background restriction. Keep running after screen off off is approximated by WAKE_LOCK ignore. Mechanisms from the dontkillmyapp.com Meizu entry (CC-BY-4.0). screen-off-stop gives a screen-off kill. Not emulated: Protected apps list; Power plan.",
    source: "https://dontkillmyapp.com/meizu",
  },
  "asus-power-master": {
    id: "asus-power-master",
    version: 2,
    description: "Asus ZenUI: Power Master's auto-deny of auto-start.",
    steps: [
      { kind: "standbyBucket", bucket: "restricted" },
      { kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" },
    ],
    evidenceStatus: "inferred",
    evidenceNote:
      'Power Master auto-deny of auto-start is approximated by the restricted bucket and RUN_ANY_IN_BACKGROUND ignore. Mechanisms from the dontkillmyapp.com Asus entry (CC-BY-4.0). screen-off-stop approximates "Clean up in suspend". Not emulated: Power Master\'s own whitelist and settings UI; its auto-start denial, which can block a boot receiver from starting an app that targets below API 33 (stock Android still starts it, so a boot receiver check here can differ from a real Asus device).',
    source: "https://dontkillmyapp.com/asus",
  },
  "sony-stamina": {
    id: "sony-stamina",
    version: 2,
    description: "Sony Xperia: STAMINA mode (background processes and alarms restricted).",
    steps: [
      { kind: "batteryUnplug" },
      { kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" },
      { kind: "appOp", op: "SCHEDULE_EXACT_ALARM", mode: "deny" },
    ],
    evidenceStatus: "inferred",
    evidenceNote:
      'STAMINA mode on battery is approximated by battery unplug, background restriction and exact alarm denial. On Android 13 and later an app declaring USE_EXACT_ALARM can keep exact alarm access despite the SCHEDULE_EXACT_ALARM denial. Mechanisms from the dontkillmyapp.com Sony entry (CC-BY-4.0). Not emulated: the time-based "Prefer battery time" STAMINA level limits after screen off; the Power-saving feature Excepted list; Intelligence Engine.',
    source: "https://dontkillmyapp.com/sony",
  },
  "tecno-app-halt": {
    id: "tecno-app-halt",
    version: 2,
    description:
      "Tecno HiOS: Background execution denied and foreground-service wake locks denied.",
    steps: [
      { kind: "appOp", op: "RUN_ANY_IN_BACKGROUND", mode: "ignore" },
      { kind: "appOp", op: "WAKE_LOCK", mode: "ignore" },
    ],
    evidenceStatus: "inferred",
    evidenceNote:
      'Power Saving Management For Apps denial is approximated by background execution and wake-lock denial. Mechanisms from the dontkillmyapp.com Tecno entry (CC-BY-4.0). screen-off-stop approximates Power Marathon screen-off cleanup. Not emulated: app-freeze ("frozen in time") of timers and foreground services; the night-time Sleep Mode airplane-mode schedule; Auto-start management allow-list.',
    source: "https://dontkillmyapp.com/tecno",
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
