# Android form factors: TV, Wear OS and Android Auto

Form-factor support, navigation contracts and remaining verification gaps.

> [!WARNING]
> **Wear OS remains unverified on emulators.** The TV section is verified on the Android 36 `android-tv` `arm64-v8a` user image and the Automotive OS baseline on the images named in its section below. "Verified in the repo" means read from this checkout; "Hypothesis" means from AOSP and Android documentation.

## Verdicts

| Form factor                                  | Verdict            | Smallest useful tool surface                                                                       | Main risk                                                                        |
| -------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Android TV / Google TV                       | **Go**             | `focusNavigate`, a `select` key on `sendKeys` only if `enter` falls short, TV form-factor matching | Google TV and no-touchscreen devices unverified; child-label `focusNavigate` gap |
| Wear OS                                      | **Conditional go** | rotary scroll, `isScreenRound` in `observe`, ambient toggle                                        | Ambient has power-state readback only; hardware wake is untested                 |
| Android Auto (projection to a DHU)           | **No-go**          | none                                                                                               | The car UI is not in any accessibility tree AutoMobile can read                  |
| Android Automotive OS (an AAOS system image) | **Go**             | existing tools; rotary `pressButton` buttons; `vehicle` `deviceCondition`                          | Play Store `user` images refuse vehicle-motion injection; secondary displays     |

Android Auto projects a phone's UI to a head unit; Automotive OS is a full Android build on the car. Only the latter is feasible.

## What the repo does today (verified)

- **Matching.** The vocabulary is `phone | tablet | foldable | tv | watch | automotive | xr-headset | xr-glasses | unknown` (`src/models/DeviceMatchCriteria.ts`); binding `family` takes the same values except `unknown` (`BINDING_DEVICE_FAMILIES`, `src/utils/provisionDeviceSpecSchemas.ts`). `formFactorFrom` (`src/models/formFactor.ts`) classifies `tv`, `watch` and `automotive` from the system-image tag first (`android-tv`, `android-wear`, `android-automotive`), then the avdmanager profile id, then geometry (fold/flip by profile name; diagonal >= 7in is a tablet, else phone), so a TV is never matched as a tablet. iOS accepts only `phone` and `tablet`. `startDevice` `formFactor`, the broker binding `deviceFamily` and the device description accept the new values; `getAndroid` has no `formFactor` input. `startDevice` with `createIfMissing` creates `tv`, `watch` and `automotive` AVDs. A `watch` request picks only installed `android-wear-signed`, `android-wear` and `android-wear-cn` images (in that order, behind API level and host ABI) and creates the AVD with `wearos_small_round`, or `wearos_square` when `requires.screenRound` is `false`; with no Wear image installed it fails naming the `sdkmanager` command. `requires.screenRound` also restricts matching, stopped or booted, to a Wear profile whose id names that shape (`wearProfileScreenRound`), so a square request never reuses a round watch, and it is refused for creation outside an Android `watch` request. A physical watch has no profile id, so it never satisfies `requires.screenRound`; physical watches stay out of scope. An `automotive` request picks only installed `android-automotive-playstore` / `android-automotive` images (Play first, behind API level and host ABI, with the CtrlProxy minSdk floor), creates the AVD with `automotive_1024p_landscape`, and with no car image installed fails with the exact `sdkmanager` command; a repeated request reuses the AVD because those tags classify it as `automotive`. `requires.vehicle.motion: "supported"` restricts matching and creation to non-Play `android-automotive` images (`isMotionCapableAutomotiveTag`), since Play car images are `user` builds whose car service refuses driving-state injection; a booted automotive device's traits carry `vehicle` derived from `ro.build.type` (then `ro.debuggable`), both `unsupported` unless `ro.kernel.qemu` marks an emulator, read only when `ro.build.characteristics` announces `automotive`, with no probe that changes car state. The tag and profile names are still unconfirmed on real images.
- **Android XR.** `xr-headset` classifies the `google-xr`, `android-xr-v3-playstore` and `android-xr-preview-playstore` tags and `xr_headset*` profiles; `xr-glasses` classifies the `ai-glasses` tag and `xr_glasses_*` / `ai_glasses_*` profiles. A request for either picks only its own images in that order (behind API level and host ABI) and creates the AVD with `xr_headset_device` or `ai_glasses_device` (the profile `avdmanager list device` tags `ai-glasses`); with none installed it fails naming the `sdkmanager` package and `--channel=3`. `requires.playStore` on a headset picks only the Play variants; glasses have no known Play image. Booted-device traits read `xr` (headset) or `glasses` in `ro.build.characteristics`. The tags, profiles and characteristics tokens are unconfirmed until an XR emulator boots (`sdkmanager --list --channel=3`, `avdmanager list device`).
- **Provisioning.** `provisionDevice` takes `runtime` as a system-image package id; `parseAndroidSystemImageRuntime` accepts any tag between API level and ABI (only `google_apis_playstore` is special-cased). Default creation (`pickAndroidSystemImage`, `src/devices/deviceProvisioning.ts`) picks an image family from the requested form factor (`androidImageFamilyFor`): handheld tags for phone, tablet, foldable or none (#14900), and only the TV tags for `tv`, ranked `android-tv`, `google-tv`, `google-tv-ps16k` behind API level and host ABI. `android-tv` leads because Play Store builds usually refuse `adb root`; this ordering rationale concerns Play Store images only and does not guarantee root on `android-tv`. The verified `android-tv` user build also refuses `adb root`. A TV AVD gets the `tv_1080p` profile. The tag lists and default profiles live once in `src/models/formFactor.ts` and the broker's family defaults read them. With no TV image in range the error names the `sdkmanager` command; nothing is downloaded.
- **CtrlProxy.** `minSdk` 24 (`android/gradle/libs.versions.toml`) is not a blocker. The manifest declares no `<uses-feature>` and only a `LAUNCHER` category (no `LEANBACK_LAUNCHER`). The accessibility config requests window content, interactive windows and gesture dispatch.
- **Input.** `sendKeys` supports arrows (`KEYCODE_DPAD_*`), enter, tab, escape, backspace, delete (`INPUT_KEY_CODE_MAP`, `src/features/action/InputKey.ts`); there is no D-pad centre, menu or media key. `pressButton` sends back/home/recent as global actions with ADB fallback, plus volume/power via ADB.
- **Focus.** `observe` returns `focusedElement` (`ActiveWindowAttribution.ts`, `HierarchyFocus.ts`) from the `focused` property; TalkBack focus is separate (`accessibility-focused`).
- `observe` reports `isScreenRound` for `watch` devices; `ambient` changes power state with no Wear ambient readback.

## Hypotheses to confirm

- Unconfirmed sdkmanager tags: `android-wear`, `android-wear-cn`, `android-automotive`, `android-automotive-playstore` (`sdkmanager --list`). Unconfirmed avdmanager profiles: `wearos_small_round`, `wearos_large_round`, `wearos_rect`, `wearos_square`, `automotive_1024p_landscape` (`avdmanager list device`). TV tags and profiles are confirmed below.
- CtrlProxy installation, host-side accessibility enable and hierarchy observation work unchanged on the verified TV image. Wear has a different Settings app and its enable path remains unverified; service connect plus hierarchy is the first check per Wear image.

## Android TV: go

TV navigation is a focus problem: D-pad keys can be sent and the focused element comes back in every observation. `focusNavigate` is the loop that connects them. `launchApp` tries `MAIN/LEANBACK_LAUNCHER` when `LAUNCHER` resolution finds no activity, including activity-query and package-dump fallbacks. `listApps` includes Leanback entry points in launchability on devices with `formFactor: "tv"`.

1. **Activate focused item.** `enter` activates the focused item on the verified image; `KEYCODE_DPAD_CENTER` is not needed and no `select` key exists. If a future TV image shows that `enter` does not activate, add `select` (`KEYCODE_DPAD_CENTER`) to **both** `SUPPORTED_INPUT_KEYS` and `INPUT_KEY_CODE_MAP`: `InputKeyName` derives from the first and the second is checked against it, so one entry alone does not compile.
2. **`focusNavigate({ until, direction?, maxSteps?, settleMs?, select? })`** (`src/features/action/FocusNavigate.ts`, Android only). Observe; stop if the focused element matches `until`; else press one D-pad key and repeat. `until` matches on `text`, `contentDesc`, `label` (text or content-desc, like `tapOn`'s text selector) and `resourceId` (the native id or synthetic `view-id`, else by name as `tapOn` resolves ids: `name` matches `pkg:id/name` and `pkg:id/name` matches a bare Compose `name`). Labels match case-insensitively as substrings, except that an exact match (label and id) anywhere on screen restricts matching to exact ones, as `tapOn`'s resolver prefers exact text and qualified ids. Returns the path of focused elements. With `select`, a `focused` result also presses `enter`; `selected` (always present, so a spilled response keeps it inline) is true only then, and a refused key throws. The select press is reported as the call's dispatch (`ToolDispatchContext`), so the navigation graph times a recorded `focusNavigate` from the key that navigates, not from the first arrow.
   - Direction: given `direction`, else the arrow from the focused element's bounds centre toward the nearest `until` match; with no match on screen, `arrow_down`.
   - Stops on match, `maxSteps` (default 30), or when every direction toward the target has left focus unchanged on the current element (ranked dominant axis first; a direction that did not move focus is blocked for that element for the rest of the call; an explicit `direction` stops after two unchanged presses). Statuses: `focused`, `max_steps`, `stuck`.
   - Why a tool, not an agent loop: one call replaces up to 30 round-trips, and stuck detection needs the previous observation.
   - **Explore and navigateTo** (`src/features/navigation/focusDrivenInput.ts`). Both resolve an input mode once per call: D-pad when the device's form factor or `ro.build.characteristics` says `tv`, touch otherwise (an unreadable trait falls back to touch). In D-pad mode `explore` replaces each tap with `focusNavigate { until, select: true }`, where `until` is the element's resource id, else the text or content description its tap selector uses (an element whose selector needs an occurrence `index` is skipped, since `until` cannot tell duplicates apart); it records that call, so the edge replays as the same D-pad walk. It does not swipe scrollable containers, since moving focus scrolls them. Like a tap, the walk flushes pending post-action captures first, and a successful select waits a bounded settle (1 s) while its record is live, so the navigation it causes is attributed to it. Validate mode replays a recorded `focusNavigate` edge with its recorded `until`, and finds the on-screen element with `focusNavigate`'s own matcher (every `until` field on one element, exact first, `view-id` included), falling back to the label fields alone when the target is a label inside a clickable row. The abort signal reaches each key press, so a cancelled run sends no further keys. `navigateTo` in D-pad mode rewrites a plain recorded `tapOn` (only `elementId` or `text`, action `tap`) into the same `focusNavigate` call, text becoming `until.label`; a tap with any other qualifier (`container`, `index`, `duration`, ...) has no D-pad equivalent and replays unchanged; other recorded calls, scroll-position setup and UI-state setup taps replay unchanged.
3. **TV matching.** Extend `FormFactor` with `tv`, classified from system-image tag first, geometry second.

`focusedElement` follows Leanback's focus ring (`focused: true`). `tapOn` and `swipeOn` work on the verified image, which reports a touchscreen; no-touchscreen behaviour remains unverified. Google TV is unverified. `focusNavigate` can reach a row but return `max_steps` or `stuck` when the target text belongs only to a child view (#16029); match the focused element's own `contentDesc` or `resourceId` instead. Prototype overlay buttons are not reachable with D-pad focus.

### Android TV: behaviour and limits

The TV image is `system-images;android-36;android-tv;arm64-v8a` with profile `tv_1080p` (1920×1080 at 320 dpi), a user build that refuses `adb root`. The SDK tags `android-tv`, `google-tv`, `google-tv-ps16k` and the profiles `tv_1080p`, `tv_4k`, `tv_720p` match `src/models/formFactor.ts`. CtrlProxy installs and its accessibility service enables from the host with no TV-specific setup, and `observe` returns the hierarchy for the launcher and Settings.

`focusedElement` follows the Leanback focus ring. `sendKeys` arrows move focus and `enter` activates. `focusNavigate` matches the target's own `contentDesc` or `resourceId`, and a target inside the focused node's bounds counts as focused, so child-view label text matches too. `pressButton` back and home, screenshots and video recording work. `launchApp` and `terminateApp` work for apps that only have a `LEANBACK_LAUNCHER` entry, and `listApps` includes them. The prototype overlay renders and dismisses, but its button is not reachable with D-pad focus. `observe.accessibilityState` reports the service as disabled and unknown while it is bound, which is an unexplained oddity.

**Signals and classification.** `ro.build.characteristics` is `emulator`, with no `tv`. Booted-device traits (`src/utils/android-cmdline-tools/deviceTraits.ts`) derive `formFactor` from this property, and on an emulator with no form factor there they fall back to `pm has-feature android.software.leanback`. AVD classification comes from the config's system-image tag or `tv_*` profile. The image reports `android.software.leanback`, `android.hardware.type.television`, `android.software.leanback_only` and `android.hardware.touchscreen` as present.

**Not covered:**

- The Google TV image; only `android-tv` was booted.
- Real no-touchscreen behaviour.
- D-pad reach of prototype overlays (known gap).

## Wear OS: conditional go

Hierarchy and tap path should match a phone's; the gaps are three Wear-specific inputs, none confirmed.

- **Rotary.** `rotaryScroll({ delta })` (`src/features/wear/RotaryScroll.ts`, opt-in like `windowMode`) tries, in order, `adb shell input rotaryencoder scroll --axis SCROLL,<-delta>`, `adb emu event send EV_REL:REL_WHEEL:<delta>` (emulator serials only) and a vertical centre-column `input swipe` sized from `wm size`. After each it re-reads the CtrlProxy hierarchy; a candidate counts only if the structural fingerprint changed. The result names the first working `method` and lists every attempt; on a device whose `ro.build.characteristics` does not name `watch` (device traits `formFactor`) the input is still sent and the result carries a `warning`. The hierarchy has no scroll offset, so a list already at its end reports `unchanged`, and an unreadable hierarchy (CtrlProxy disconnected) makes no attempt. The native SCROLL axis command is confirmed on a Wear OS emulator, with its sign inverted relative to delta: positive delta reveals lower items. The emulator-console `REL_WHEEL` mapping and sign, and physical-device behaviour, remain unconfirmed (checklist row 6).
- **Ambient.** `ambient({ action: "enter" | "exit" })` sends `KEYCODE_SLEEP` or `KEYCODE_WAKEUP` through the existing power client, then reads wakefulness once. Enter succeeds on `Dozing` or `Asleep`; exit succeeds on `Awake`. This is a power-state change with no Wear ambient readback, so success does not prove ambient mode. Hardware wake by tilt or touch remains untested.
- **Round screens.** `observe` reports `isScreenRound` for `watch` devices (`BootedDevice.formFactor`), read over adb from `dumpsys display` (`FLAG_ROUND` on the default display's `DisplayInfo`/`DisplayDeviceInfo` record), not from the CtrlProxy.
- **Swipe-to-dismiss.** Wear OS 3+ back is a right-swipe from the left edge; the `back` global action should work; check a left-edge `swipeOn`.

## Android Auto (DHU): no-go

The DHU is a host desktop app; the phone's Android Auto app streams the car UI as video over an ADB-forwarded socket (`tcp:5277`), and Car App Library templates are rendered by the host, not the app under test. So the phone's accessibility tree has no car screen, and driving the DHU is desktop automation outside the ADB model. `androidx.car.app.testing` (`TestCarContext`, `ScreenController`) tests templates in unit tests and is the recommended route.

## Android Automotive OS: go

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
alone never lets CtrlProxy be set up for user 0 before the switch to the driver user. A freshly
created AVD can also answer the first setup command with `adb: device still authorizing` before it
finishes the adb key handshake; readiness retries that within the same budget too, so the
create-and-boot path does not roll back the new AVD for it. Verified on the API 34 image below; the gate relies on the AVD's form factor, so a
physical head unit is not covered.

An AAOS image is a normal Android build with a car SystemUI; app windows are in the accessibility tree.

### Automotive baseline on an emulator

Main image: `system-images;android-34-ext9;android-automotive;arm64-v8a` (`userdebug`, headless system
user, driver user 10), profile `automotive_1024p_landscape`. Rows marked _Play_ were run on
`android-35-ext15` `android-automotive-playstore` (`user` build, `adb root` refused).

| Tool or behaviour                                               | Result | Notes                                                                                                           |
| --------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `provisionDevice` with an explicit `android-automotive` runtime | Pass   | Creates and boots the AVD                                                                                       |
| `startDevice` `formFactor: "automotive"`, `createIfMissing`     | Pass   | Finds `android-<api>-ext<N>` images; repeated creation on a _Play_ image still needs a device run (#15879)      |
| `formFactor` in `listDevices` / `getAndroid`                    | Pass   | `automotive`                                                                                                    |
| CtrlProxy install and enable for the driver user                | Pass   | Enabled for user 10 only; readiness waits for the switch from user 0                                            |
| `observe` (hierarchy and screenshot)                            | Pass   | Main display only                                                                                               |
| `tapOn`, `tapAt`, `swipeOn`                                     | Pass   |                                                                                                                 |
| `launchApp`, `listApps`                                         | Pass   | Launch targets the foreground user                                                                              |
| `pressButton` `home`                                            | Pass   | The home screen is hosted by `com.android.car.mapsplaceholder`                                                  |
| `pressButton` `rotary_rotate_cw` / `_ccw`, `rotary_nudge_*`     | Pass   | `rotary_select` succeeds with no observable effect tied to it                                                   |
| `rotaryScroll`                                                  | n/a    | Wear-only; on a car it warns and falls back to a swipe                                                          |
| `performanceTrace`                                              | Pass   |                                                                                                                 |
| `deviceCondition` `vehicle.motion` driving / parked / reset     | Pass   | `Current Driving State` 2 held, then 0; on _Play_ the car service refuses it and the tool returns `unsupported` |
| `deviceCondition` `vehicle.nightMode`                           | Pass   | Effective UI night mode flips and restores; car service accepts it on _Play_ too                                |
| `prototype` `show` / `status` / `dismiss` (_Play_)              | Pass   | Reports `formFactor: "automotive"`; `save` `pin:true` reports `pinned: "unsupported"`                           |

Car-service commands: `inject-vhal-event`, `emulate-driving-state` and `get-property-value` need a
non-`user` build; `enable-uxr` is refused from `adb shell` on every build (system signature); restriction
state is read from `dumpsys car_service --services CarUxRestrictionsManagerService` and
`CarDrivingStateService`, which work on both builds. Cluster and passenger displays are unchecked.

### Automotive fixture app

`android/automotive-fixture` (`dev.jasonpearson.automobile.automotivefixture`) is the deterministic
target for automotive checks: no network and no Google services, so it installs on non-Play images.
All text and ids come from `FixtureCatalog` and `MediaBrowseTree`; changing them is a contract change.

- `DrivingSafeActivity` (launcher "AutoMobile Fixture", declared `distractionOptimized`): a status line
  (`fixture_status`) and a list (`fixture_rows`) whose first row opens `ParkedOnlyActivity` and whose
  `Row 01`..`Row 20` set the status to `Selected Row NN`.
- `ParkedOnlyActivity`: no `distractionOptimized` meta-data, so it is blocked while driving.
- `FixtureMediaBrowserService`: a framework `MediaBrowserService` serving two albums and a playlist of
  three tracks each; playing an item only updates the session state.
- `FixtureCarAppService` (navigation category, launcher "AutoMobile Templates" via `CarAppActivity`):
  list, grid, pane and place-list navigation templates with fixed rows and four fixed places. It accepts
  every templates host, so a non-Play image needs a templates host of its own to render it.

### Wear fixture app

`android/wear-fixture` (`dev.jasonpearson.automobile.wearfixture`, launcher "AutoMobile Wear Fixture")
is the deterministic target for watch checks: Compose for Wear OS, no network and no Google account,
standalone, so it installs on any Wear image. All text and ids come from `WearFixtureCatalog`; changing
them is a contract change. Compose test tags are exposed as resource ids.

- Home (`fixture_list`, a `ScalingLazyColumn`): the status line (`fixture_status`, starts `Ready`), six
  action buttons (`action_picker`, `action_dismiss`, `action_confirm`, `action_notify`,
  `action_ongoing_start`, `action_ongoing_stop`), then `Item 01`..`Item 30` (`item_01`..`item_30`).
- Detail (`detail_title`, `detail_text` = `Detail for Item NN`): back or a right swipe returns home.
- Rotary picker (`picker`, `picker_value`): `Level 0`..`Level 11`, clamped. Only rotary scroll events
  move it (48 px per step); it has no touch handler. Each step sets the status to `Picked Level N`.
- Swipe-to-dismiss screen (`dismiss_screen`): a right swipe pops it and sets the status to `Dismissed`.
  Detail and picker pop the same way.
- Confirmation dialog: `Confirm` (`confirm_button`) or `Cancel` (`cancel_button`) set the status to
  `Confirmed` or `Cancelled`.
- Notification (`Fixture alert`): actions `Reply` and `Archive` reopen the app with the status
  `Notification action: Reply` / `Archive`. The ongoing activity (`Fixture run`) is an ongoing
  notification started and stopped from home. Both need `POST_NOTIFICATIONS`; the app asks on first use,
  and `pm grant` skips the prompt.
- `FixtureTileService`: one clickable (`tile_open_item`) that opens `Item 07`'s detail.
- `FixtureComplicationService`: `SHORT_TEXT` (`Item` / `07`) and `RANGED_VALUE` (7 of 0..10, `7/10`);
  tapping opens `Item 07`'s detail. Values are fixed and never polled.

## Device selection change

1. Extend `FormFactor` and `BINDING_DEVICE_FAMILIES` with `tv`, `watch`, `automotive`.
2. In `formFactorFrom`, classify from the system-image tag before geometry.
3. Surface form factor in `getAndroid` and the device description so a `requires` clause (#4680) can ask for it.

Needs no device to build; phones, tablets and foldables keep the same geometry path.

## Verification checklist

Record command, image id and API level.

| #   | Image                                    | Check                                                                                                                                                                              |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TV (`android-tv` or `google-tv`, API 34) | `avdmanager create avd` with `--device tv_1080p` succeeds; the AVD boots                                                                                                           |
| 2   | TV                                       | `adb install` of the CtrlProxy APK succeeds; the service can be enabled from the host; `observe` returns a hierarchy                                                               |
| 3   | TV                                       | `sendKeys` with `arrow_right` moves focus and `observe.focusedElement` changes; `enter` and, if that does not work, `KEYCODE_DPAD_CENTER` activate the focused item                |
| 4   | TV                                       | `tapOn` works on an image with no touchscreen                                                                                                                                      |
| 5   | Wear (`android-wear`, API 34)            | The same install, enable and `observe` checks as TV                                                                                                                                |
| 6   | Wear                                     | Each rotary candidate against a `ScalingLazyColumn`: which one changes the scroll position                                                                                         |
| 7   | Wear                                     | `ambient` uses `KEYCODE_SLEEP`/`KEYCODE_WAKEUP` as a power-state change; wakefulness is read once, with no Wear ambient readback. Hardware wake by tilt or touch remains untested. |
| 8   | Wear                                     | `isScreenRound` is true on `wearos_small_round`; the left-edge swipe dismisses a screen                                                                                            |
| 9   | Automotive (`android-automotive`)        | Behavior of the cluster and passenger displays (install, enable and `observe` are in the baseline above)                                                                           |
| 10  | Any                                      | `sdkmanager --list` shows the tags named above; `avdmanager list device` shows the profile ids                                                                                     |

## Not covered

Android Auto projection is a documented no-go. Automotive OS secondary displays (row 9) remain unchecked.
