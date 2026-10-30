# Android form factors: TV, Wear OS and Android Auto

Spike notes for #14118, part of #14072.

> [!WARNING]
> **Not yet verified on an emulator** (no KVM or Android SDK was available when written). "Verified in the repo" means read from this checkout; "Hypothesis" means from AOSP and Android documentation. Verdicts are provisional until the verification checklist is run.

## Verdicts

| Form factor                                  | Verdict            | Smallest useful tool surface                                                                       | Main risk                                                       |
| -------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Android TV / Google TV                       | **Go**             | `focusNavigate`, a `select` key on `sendKeys` only if `enter` falls short, TV form-factor matching | The CtrlProxy has never been run on a TV image                  |
| Wear OS                                      | **Conditional go** | rotary scroll, `isScreenRound` in `observe`, ambient toggle                                        | Every rotary and ambient command is unconfirmed                 |
| Android Auto (projection to a DHU)           | **No-go**          | none                                                                                               | The car UI is not in any accessibility tree AutoMobile can read |
| Android Automotive OS (an AAOS system image) | **Investigate**    | none yet                                                                                           | It is a normal Android image and may just work                  |

Android Auto projects a phone's UI to a head unit; Automotive OS is a full Android build on the car. Only the latter is feasible.

## What the repo does today (verified)

- **Matching.** The vocabulary is `phone | tablet | foldable | tv | watch | automotive | unknown` (`src/models/DeviceMatchCriteria.ts`); binding `family` takes the same values except `unknown` (`BINDING_DEVICE_FAMILIES`, `src/utils/provisionDeviceSpecSchemas.ts`). `formFactorFrom` (`src/models/formFactor.ts`) classifies `tv`, `watch` and `automotive` from the system-image tag first (`android-tv`, `android-wear`, `android-automotive`), then the avdmanager profile id, then geometry (fold/flip by profile name; diagonal >= 7in is a tablet, else phone), so a TV is never matched as a tablet. iOS accepts only `phone` and `tablet`. `startDevice` `formFactor`, the broker binding `deviceFamily` and the device description accept the new values; `getAndroid` has no `formFactor` input. `startDevice` with `createIfMissing` creates `tv` and `automotive` AVDs but not `watch` ones (those fail with an actionable error). An `automotive` request picks only installed `android-automotive-playstore` / `android-automotive` images (Play first, behind API level and host ABI, with the CtrlProxy minSdk floor), creates the AVD with `automotive_1024p_landscape`, and with no car image installed fails with the exact `sdkmanager` command; a repeated request reuses the AVD because those tags classify it as `automotive`. The tag and profile names are still unconfirmed on real images.
- **Provisioning.** `provisionDevice` takes `runtime` as a system-image package id; `parseAndroidSystemImageRuntime` accepts any tag between API level and ABI (only `google_apis_playstore` is special-cased). Default creation (`pickAndroidSystemImage`, `src/devices/deviceProvisioning.ts`) picks an image family from the requested form factor (`androidImageFamilyFor`): handheld tags for phone, tablet, foldable or none (#14900), and only the TV tags for `tv`, ranked `android-tv`, `google-tv`, `google-tv-ps16k` behind API level and host ABI. `android-tv` leads because Play Store builds usually refuse `adb root`; the order is provisional until the TV baseline confirms root. A TV AVD gets the `tv_1080p` profile. The tag lists and default profiles live once in `src/models/formFactor.ts` and the broker's family defaults read them. With no TV image in range the error names the `sdkmanager` command; nothing is downloaded.
- **CtrlProxy.** `minSdk` 24 (`android/gradle/libs.versions.toml`) is not a blocker. The manifest declares no `<uses-feature>` and only a `LAUNCHER` category (no `LEANBACK_LAUNCHER`). The accessibility config requests window content, interactive windows and gesture dispatch.
- **Input.** `sendKeys` supports arrows (`KEYCODE_DPAD_*`), enter, tab, escape, backspace, delete (`INPUT_KEY_CODE_MAP`, `src/features/action/InputKey.ts`); there is no D-pad centre, menu or media key. `pressButton` sends back/home/recent as global actions with ADB fallback, plus volume/power via ADB.
- **Focus.** `observe` returns `focusedElement` (`ActiveWindowAttribution.ts`, `HierarchyFocus.ts`) from the `focused` property; TalkBack focus is separate (`accessibility-focused`).
- `observe` reports `isScreenRound` for `watch` devices; nothing handles ambient mode.

## Hypotheses to confirm

- sdkmanager tags: `android-tv`, `google-tv`, `android-wear`, `android-wear-cn`, `android-automotive`, `android-automotive-playstore` (`sdkmanager --list`). avdmanager profiles: `tv_1080p`, `tv_4k`, `wearos_small_round`, `wearos_large_round`, `wearos_rect`, `wearos_square`, `automotive_1024p_landscape` (`avdmanager list device`).
- `adb install` does not filter on `<uses-feature>`, so the APK installs everywhere. Enabling the accessibility service from the host should work, but TV and Wear ship a different Settings app and the enable path has never run there; service connect plus hierarchy is the first check per image.

## Android TV: go

TV navigation is a focus problem: D-pad keys can be sent and the focused element comes back in every observation. `focusNavigate` is the loop that connects them. `launchApp` tries `MAIN/LEANBACK_LAUNCHER` when `LAUNCHER` resolution finds no activity, including activity-query and package-dump fallbacks. `listApps` includes Leanback entry points in launchability on devices with `formFactor: "tv"`.

1. **Activate focused item.** Android treats `KEYCODE_ENTER` and `KEYCODE_DPAD_CENTER` both as select, so `enter` is the activation key and no `select` key exists. If checklist row 3 shows `enter` does not activate on a TV image, add `select` (`KEYCODE_DPAD_CENTER`) to **both** `SUPPORTED_INPUT_KEYS` and `INPUT_KEY_CODE_MAP`: `InputKeyName` derives from the first and the second is checked against it, so one entry alone does not compile.
2. **`focusNavigate({ until, direction?, maxSteps?, settleMs? })`** (`src/features/action/FocusNavigate.ts`, Android only). Observe; stop if the focused element matches `until`; else press one D-pad key and repeat. `until` matches on `text`, `contentDesc` and `resourceId`. Returns the path of focused elements.
   - Direction: given `direction`, else the arrow from the focused element's bounds centre toward the nearest `until` match; with no match on screen, `arrow_down`.
   - Stops on match, `maxSteps` (default 30), or when every direction toward the target has left focus unchanged on the current element (ranked dominant axis first; a direction that did not move focus is blocked for that element for the rest of the call; an explicit `direction` stops after two unchanged presses). Statuses: `focused`, `max_steps`, `stuck`.
   - Why a tool, not an agent loop: one call replaces up to 30 round-trips, and stuck detection needs the previous observation.
3. **TV matching.** Extend `FormFactor` with `tv`, classified from system-image tag first, geometry second.

Open on-device: does `tapOn`/`swipeOn` work with no touchscreen (gesture dispatch needs a display, not a digitizer)? Does `focused` appear for Leanback's focus ring, or only input-focused views (if so `focusNavigate` needs accessibility focus too)?

## Wear OS: conditional go

Hierarchy and tap path should match a phone's; the gaps are three Wear-specific inputs, none confirmed.

- **Rotary.** `rotaryScroll({ delta })` (`src/features/wear/RotaryScroll.ts`, opt-in like `windowMode`) tries, in order, `adb shell input rotaryencoder scroll --axis SCROLL,<-delta>`, `adb emu event send EV_REL:REL_WHEEL:<delta>` (emulator serials only) and a vertical centre-column `input swipe` sized from `wm size`. After each it re-reads the CtrlProxy hierarchy; a candidate counts only if the structural fingerprint changed. The result names the first working `method` and lists every attempt; on a device whose `ro.build.characteristics` does not name `watch` (device traits `formFactor`) the input is still sent and the result carries a `warning`. The hierarchy has no scroll offset, so a list already at its end reports `unchanged`, and an unreadable hierarchy (CtrlProxy disconnected) makes no attempt. The native SCROLL axis command is confirmed on a Wear OS emulator, with its sign inverted relative to delta: positive delta reveals lower items. The emulator-console `REL_WHEEL` mapping and sign, and physical-device behaviour, remain unconfirmed (checklist row 6).
- **Ambient: not supported.** Entered by screen timeout into always-on display; no documented shell command, so there is no toggle. `observe` reports `wakefulness: "Dozing"` when the device reports it. Candidates to try if row 7 is run: `KEYCODE_SLEEP` then wake, and the AOD settings key.
- **Round screens.** `observe` reports `isScreenRound` for `watch` devices (`BootedDevice.formFactor`), read over adb from `dumpsys display` (`FLAG_ROUND` on the default display's `DisplayInfo`/`DisplayDeviceInfo` record), not from the CtrlProxy.
- **Swipe-to-dismiss.** Wear OS 3+ back is a right-swipe from the left edge; the `back` global action should work; check a left-edge `swipeOn`.

## Android Auto (DHU): no-go

The DHU is a host desktop app; the phone's Android Auto app streams the car UI as video over an ADB-forwarded socket (`tcp:5277`), and Car App Library templates are rendered by the host, not the app under test. So the phone's accessibility tree has no car screen, and driving the DHU is desktop automation outside the ADB model. `androidx.car.app.testing` (`TestCarContext`, `ScreenController`) tests templates in unit tests and is the recommended route.

## Android Automotive OS: investigate

### CtrlProxy setup for the foreground user (#14918)

An automotive image usually has a headless system user, so the driver is a secondary user (often 10).
`pm grant` and `pm path` default to user 0, `pm list packages` to all users, and `dumpsys accessibility`
dumps every user's state in id order (so an untargeted read sees user 0's empty one); `settings` already
follows the current user on Android 10+. When the booted device's `formFactor` is `automotive`,
`resolveSetupUser` (`src/ctrlProxy/setupUser.ts`) reads `am get-current-user` and CtrlProxy's install
check, enabled-services read, enable, disable, rebind writes and the local-network grant target that user,
and the rebind health check reads that user's `User state[` block. A device that is not automotive issues
no extra command and the exact commands it always did. An unreadable user is an `ActionableError` naming
the user problem. User 0 is the driver only on a build without a headless system user: when an automotive
device reports user 0, `ro.fw.mu.headless_system_user` (what `UserManager.isHeadlessSystemUserMode()`
reads) is checked, and on a headless build the read throws `ForegroundUserPendingError`. Runner readiness
treats that like a missing framework service and retries setup within its budget, so `sys.boot_completed`
alone never lets CtrlProxy be set up for user 0 before the switch to the driver user. Unverified on an AAOS emulator (#14916); the gate relies on the AVD's form factor, so a
physical head unit is not covered.

An AAOS image is a normal Android build with a car SystemUI; app windows are in the accessibility tree. Same three questions as TV (service enables, `observe` returns a hierarchy, multi-display behaviour for cluster/passenger screens; see `docs/design-docs/plat/android/windowing.md`).

## Device selection change

1. Extend `FormFactor` and `BINDING_DEVICE_FAMILIES` with `tv`, `watch`, `automotive`.
2. In `formFactorFrom`, classify from the system-image tag before geometry.
3. Surface form factor in `getAndroid` and the device description so a `requires` clause (#4680) can ask for it.

Needs no device to build; phones, tablets and foldables keep the same geometry path.

## Verification checklist

Record command, image id and API level.

| #   | Image                                    | Check                                                                                                                                                               |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TV (`android-tv` or `google-tv`, API 34) | `avdmanager create avd` with `--device tv_1080p` succeeds; the AVD boots                                                                                            |
| 2   | TV                                       | `adb install` of the CtrlProxy APK succeeds; the service can be enabled from the host; `observe` returns a hierarchy                                                |
| 3   | TV                                       | `sendKeys` with `arrow_right` moves focus and `observe.focusedElement` changes; `enter` and, if that does not work, `KEYCODE_DPAD_CENTER` activate the focused item |
| 4   | TV                                       | `tapOn` works on an image with no touchscreen                                                                                                                       |
| 5   | Wear (`android-wear`, API 34)            | The same install, enable and `observe` checks as TV                                                                                                                 |
| 6   | Wear                                     | Each rotary candidate against a `ScalingLazyColumn`: which one changes the scroll position                                                                          |
| 7   | Wear                                     | Which command, if any, enters and leaves ambient mode                                                                                                               |
| 8   | Wear                                     | `isScreenRound` is true on `wearos_small_round`; the left-edge swipe dismisses a screen                                                                             |
| 9   | Automotive (`android-automotive`)        | Install, enable and `observe`; behavior of the secondary displays                                                                                                   |
| 10  | Any                                      | `sdkmanager --list` shows the tags named above; `avdmanager list device` shows the profile ids                                                                      |

## Not covered

Android Auto projection is a documented no-go; Automotive OS has no follow-up until rows 9 and 10 run.
