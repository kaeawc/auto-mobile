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

- **Matching.** The vocabulary is `phone | tablet | foldable | tv | watch | automotive | unknown` (`src/models/DeviceMatchCriteria.ts`); binding `family` takes the same values except `unknown` (`BINDING_DEVICE_FAMILIES`, `src/utils/provisionDeviceSpecSchemas.ts`). `formFactorFrom` (`src/models/formFactor.ts`) classifies `tv`, `watch` and `automotive` from the system-image tag first (`android-tv`, `android-wear`, `android-automotive`), then the avdmanager profile id, then geometry (fold/flip by profile name; diagonal >= 7in is a tablet, else phone), so a TV is never matched as a tablet. iOS accepts only `phone` and `tablet`. `startDevice` `formFactor`, the broker binding `deviceFamily` and the device description accept the new values; `getAndroid` has no `formFactor` input, and `startDevice` with `createIfMissing` does not create `tv`, `watch` or `automotive` AVDs (it fails with an actionable error). The tag and profile names are still unconfirmed on real images.
- **Provisioning.** `provisionDevice` takes `runtime` as a system-image package id; `parseAndroidSystemImageRuntime` accepts any tag between API level and ABI (only `google_apis_playstore` is special-cased). TV/Wear/Automotive ids already parse; no code names those tags.
- **CtrlProxy.** `minSdk` 24 (`android/gradle/libs.versions.toml`) is not a blocker. The manifest declares no `<uses-feature>` and only a `LAUNCHER` category (no `LEANBACK_LAUNCHER`). The accessibility config requests window content, interactive windows and gesture dispatch.
- **Input.** `sendKeys` supports arrows (`KEYCODE_DPAD_*`), enter, tab, escape, backspace, delete (`INPUT_KEY_CODE_MAP`, `src/features/action/InputKey.ts`); there is no D-pad centre, menu or media key. `pressButton` sends back/home/recent as global actions with ADB fallback, plus volume/power via ADB.
- **Focus.** `observe` returns `focusedElement` (`ActiveWindowAttribution.ts`, `HierarchyFocus.ts`) from the `focused` property; TalkBack focus is separate (`accessibility-focused`).
- Nothing reads `isScreenRound` or handles ambient mode (as written; see the Wear status below).

## Hypotheses to confirm

- sdkmanager tags: `android-tv`, `google-tv`, `android-wear`, `android-wear-cn`, `android-automotive`, `android-automotive-playstore` (`sdkmanager --list`). avdmanager profiles: `tv_1080p`, `tv_4k`, `wearos_small_round`, `wearos_large_round`, `wearos_rect`, `wearos_square`, `automotive_1024p_landscape` (`avdmanager list device`).
- `adb install` does not filter on `<uses-feature>`, so the APK installs everywhere. Enabling the accessibility service from the host should work, but TV and Wear ship a different Settings app and the enable path has never run there; service connect plus hierarchy is the first check per image.

## Android TV: go

TV navigation is a focus problem; D-pad keys can be sent and the focused element comes back in every observation. Missing: a loop connecting them, and possibly one key.

1. **Activate focused item.** Android treats `KEYCODE_ENTER` and `KEYCODE_DPAD_CENTER` both as select, so `enter` may suffice (test first, checklist row 3). If not, add `select` (`KEYCODE_DPAD_CENTER`) to **both** `SUPPORTED_INPUT_KEYS` and `INPUT_KEY_CODE_MAP`: `InputKeyName` derives from the first and the second is checked against it, so one entry alone does not compile.
2. **`focusNavigate({ until, direction?, maxSteps?, settleMs? })`.** Observe; stop if the focused element matches `until`; else press one D-pad key and repeat. Returns the path of focused elements.
   - Direction: given `direction`, else the arrow from the focused element's bounds centre toward the nearest `until` match; with no match on screen, `arrow_down`.
   - Stops on match, `maxSteps` (default 30), or two consecutive presses leaving focus unchanged. Statuses: `focused`, `max_steps`, `stuck`.
   - Why a tool, not an agent loop: one call replaces up to 30 round-trips, and stuck detection needs the previous observation.
3. **TV matching.** Extend `FormFactor` with `tv`, classified from system-image tag first, geometry second.

Open on-device: does `tapOn`/`swipeOn` work with no touchscreen (gesture dispatch needs a display, not a digitizer)? Does `focused` appear for Leanback's focus ring, or only input-focused views (if so `focusNavigate` needs accessibility focus too)?

## Wear OS: conditional go

Hierarchy and tap path should match a phone's; the gaps are three Wear-specific inputs, none confirmed.

- **Rotary (hypothesis).** Candidates in order, each verified by a changed scroll position in the next `observe`: `adb shell input rotaryencoder scroll <delta>` (first API level unknown); the emulator console rotary control; `KEYCODE_STEM_*` (buttons, not scroll). Fallback: vertical `swipeOn`.
- **Ambient (hypothesis).** Entered by screen timeout into always-on display; no documented shell command. Try `KEYCODE_SLEEP` then wake, and the AOD settings key. If none works, ambient testing is no-go and the rest of Wear is unaffected.
- **Round screens.** `observe` should report `isScreenRound` (`Configuration.isScreenRound`); a new display-info field.
- **Swipe-to-dismiss.** Wear OS 3+ back is a right-swipe from the left edge; the `back` global action should work; check a left-edge `swipeOn`.

### Status (#14948)

Implemented host-side and unit-tested against a fake adb; **nothing has run on a Wear emulator**, so rows 6-8 stay open.

- **`rotaryScroll({ delta })`** (`src/server/rotaryScrollTool.ts`, `src/features/wear/RotaryScroll.ts`; opt-in like `windowMode`). Candidates, in order: `adb shell input rotaryencoder scroll <delta>`, `adb emu event send EV_REL:REL_WHEEL:<delta>` (emulator serials only), then a vertical centre-column `input swipe` sized from `wm size`. Each is followed by a CtrlProxy hierarchy read-back (the structural fingerprint, `hierarchyFingerprint`, differs from before); the result lists `method` (first that moved the screen) and every attempt. The read-back is "the visible tree changed", not a scroll offset: the hierarchy carries none, so a list that is already at its end reports `unchanged`. The `emu event send` command is the least-grounded candidate: the Wear emulator's mapping of `REL_WHEEL` to the crown is a guess, and the sign of `delta` is unverified for the first two candidates (only the swipe's direction is by construction).
- **`isScreenRound`** in `observe`, for `watch` devices only (`BootedDevice.formFactor`, so a watch whose form factor was not resolved reports nothing). Read from `dumpsys display`: `FLAG_ROUND` on the default display's `DisplayInfo`/`DisplayDeviceInfo` record. It is not read from the CtrlProxy, so there is no `Configuration.isScreenRound` and no Kotlin change. The fixtures under `test/fixtures/wear-os/` are hand-reconstructed, not captured.
- **Ambient mode: not implemented.** No reliable enter/leave command is known (row 7 unrun). `observe` already reports `wakefulness: "Dozing"` when the device reports ambient/doze, which may be enough to observe the state; a toggle is dropped until row 7 finds a command, per the issue.
- **Swipe-to-dismiss:** unchanged, row 8 still to run.

## Android Auto (DHU): no-go

The DHU is a host desktop app; the phone's Android Auto app streams the car UI as video over an ADB-forwarded socket (`tcp:5277`), and Car App Library templates are rendered by the host, not the app under test. So the phone's accessibility tree has no car screen, and driving the DHU is desktop automation outside the ADB model. `androidx.car.app.testing` (`TestCarContext`, `ScreenController`) tests templates in unit tests and is the recommended route.

## Android Automotive OS: investigate

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

## Follow-ups (under #14072)

- **#14946** form-factor vocabulary (`tv`, `watch`, `automotive`); buildable first.
- **#14947** TV: `focusNavigate`, `select` key if needed (rows 1-4).
- **#14948** Wear OS: rotary scroll, `isScreenRound`, ambient toggle if row 7 finds a command (rows 5-8). Host side landed; rows 5-8 and the Wear sample screen still need an emulator.

Android Auto projection is a documented no-go; Automotive OS has no follow-up until rows 9 and 10 run.
