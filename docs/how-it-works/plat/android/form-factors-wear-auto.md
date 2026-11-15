# Android form factors: Wear OS, Android Auto and Automotive

Part of [Android form factors](form-factors.md).

## Wear OS: conditional go

Hierarchy and tap path should match a phone's; the gaps are three Wear-specific inputs, none confirmed.

- **Rotary.** `rotaryScroll({ delta })` (`src/features/wear/RotaryScroll.ts`, opt-in like `windowMode`) tries, in order, `adb shell input rotaryencoder scroll --axis SCROLL,<-delta>`, `adb emu event send EV_REL:REL_WHEEL:<delta>` (emulator serials only) and a vertical centre-column `input swipe` sized from `wm size`. After each it re-reads the CtrlProxy hierarchy; a candidate counts only if the structural fingerprint changed. The result names the first working `method` and lists every attempt; on a device whose `ro.build.characteristics` does not name `watch` (device traits `formFactor`) the input is still sent and the result carries a `warning`. The hierarchy has no scroll offset, so a list already at its end reports `unchanged`, and an unreadable hierarchy (CtrlProxy disconnected) makes no attempt. The native SCROLL axis command is confirmed on a Wear OS emulator, with its sign inverted relative to delta: positive delta reveals lower items. The emulator-console `REL_WHEEL` mapping and sign, and physical-device behaviour, remain unconfirmed.
- **Ambient.** `ambient({ action: "enter" | "exit" })` sends `KEYCODE_SLEEP` or `KEYCODE_WAKEUP` through the existing power client, then reads wakefulness and `watchFaceState=WatchFaceState{watchFaceVisible=…, inAmbient=…}` from `dumpsys wear_service` (parsed in `src/features/wear/wearServiceDumpsys.ts`, shared with watch-face observation). Enter succeeds on `inAmbient=true`; exit on `inAmbient=false` with `Awake`. Without that line (or when the read fails) the result reports `ambient: "unknown"` and falls back to wakefulness: enter on `Dozing` or `Asleep`, exit on `Awake`. On the API 37 image `KEYCODE_SLEEP` also takes the display to `DOZE_SUSPEND`, and `svc power stayon true` keeps it awake. Hardware wake by tilt or touch remains untested.
- **Round screens.** `observe` reports `isScreenRound` for `watch` devices (`BootedDevice.formFactor`), read over adb from `dumpsys display` (`FLAG_ROUND` on the default display's `DisplayInfo`/`DisplayDeviceInfo` record), not from the CtrlProxy.
- **Swipe-to-dismiss.** Wear OS 3+ back is a right-swipe from the left edge; the `back` global action should work; check a left-edge `swipeOn`.

## Android Auto (DHU): no-go

The DHU is a host desktop app. The phone's Android Auto app streams the car UI as video over an ADB-forwarded socket (`tcp:5277`), and the host renders Car App Library templates, not the app under test. So the phone's accessibility tree has no car screen, and driving the DHU is desktop automation outside the ADB model. `androidx.car.app.testing` (`TestCarContext`, `ScreenController`) tests templates in unit tests and is the recommended route. AutoMobile can still provision projection headlessly and send head-unit input through the DHU console ([Android Auto projection provisioning](android-auto-projection-provisioning.md)), and reads opted-in apps' templates ([Car App Library template snapshots](car-app-templates.md)).

## Android Automotive OS: go

### CtrlProxy setup for the foreground user (#14918)

An automotive image usually has a headless system user, so the driver is a secondary user (often 10).
The commands `pm grant` and `pm path` default to user 0, and `pm list packages` to all users. The command `dumpsys accessibility`
dumps every user's state in id order, so an untargeted read sees user 0's empty one. The `settings` command already
follows the current user on Android 10+.

When the booted device's `formFactor` is `automotive`,
`resolveSetupUser` (`src/ctrlProxy/setupUser.ts`) reads `am get-current-user`. CtrlProxy's install
check, enabled-services read, enable, disable, rebind writes and the local-network grant then target that user,
and the rebind health check reads that user's `User state[` block. A device that is not automotive issues
no extra command and the exact commands it always did. An unreadable user is an `ActionableError` naming
the user problem.

User 0 is the driver only on a build without a headless system user. When an automotive
device reports user 0, setup checks `ro.fw.mu.headless_system_user` (what `UserManager.isHeadlessSystemUserMode()`
reads), and on a headless build the read throws `ForegroundUserPendingError`. Runner readiness
treats that like a missing framework service and retries setup within its budget. So `sys.boot_completed`
alone never lets CtrlProxy be set up for user 0 before the switch to the driver user.

A freshly
created AVD can also answer the first setup command with `adb: device still authorizing` before it
finishes the adb key handshake. Readiness retries that within the same budget too, so the
create-and-boot path does not roll back the new AVD for it. This is verified on the API 34 image below. The gate relies on the AVD's form factor, so it does not cover a
physical head unit.

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
  list, grid, pane and place-list navigation templates with fixed rows and four fixed places, plus a
  `List 30` screen with `List long row 01`..`List long row 30` (`list_long_row_01`..`list_long_row_30`).
  Debug builds enable the AutoMobile SDK template route and record every screen's returned template,
  including all thirty rows regardless of host truncation; release builds omit the SDK. It accepts every
  templates host, so a non-Play image needs a templates host of its own to render it.

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
