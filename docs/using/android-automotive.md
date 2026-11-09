# Android Automotive OS emulators

AutoMobile can drive an Android Automotive OS (AAOS) emulator: a full Android build for the car, with a
car SystemUI and an accessibility tree like any other Android image. This guide covers setting one up,
what to expect, and what is out of scope.

> [!WARNING]
> **Image support varies.** Some emulator interactions below remain unverified. Vehicle conditions
> check the effective driving or night state before reporting success; a command accepted by the car
> service alone does not confirm that the requested state took effect.

## Create the emulator

Install an automotive system image, then ask for an automotive device and let AutoMobile create it:

```bash
sdkmanager "system-images;android-34;android-automotive;x86_64"
```

```json
{ "platform": "android", "formFactor": "automotive", "createIfMissing": true }
```

Pass that to `startDevice`. AutoMobile picks only from installed `android-automotive-playstore` and
`android-automotive` images (the Play image first, newest API level in your `minOsVersion` /
`maxOsVersion` range, an ABI your machine can run) and creates the AVD with the
`automotive_1024p_landscape` profile. A phone, tablet or foldable request never gets a car image. If no
car image is installed in the range, the error names the `sdkmanager` command to run. Asking again
reuses the car emulator instead of creating another. Creating and booting a car emulator this way works
with an `android-automotive` image; with a Play Store car image it is unverified.

If the test will drive the car, ask for that up front so you never get a Play image:

```json
{
  "platform": "android",
  "formFactor": "automotive",
  "createIfMissing": true,
  "requires": { "vehicle": { "motion": "supported" } }
}
```

`requires.vehicle.motion: "supported"` (on `startDevice` and `getAndroid`) matches only an emulator
built from an `android-automotive` image and creates one from such an image instead of the Play
image. If none is installed in the range, the error names the `sdkmanager` package to install. It is
refused for a non-automotive request. A booted car emulator's `traits.vehicle` in the booted-devices
resource reports `motion` (`supported`, `unsupported`, or `unknown` when the build props could not be
read) and `nightMode` (`supported`). A physical head unit reports both `unsupported`, because vehicle
state is injected on emulators only. Other devices have no `vehicle` field.

To choose the exact image and profile yourself, call `provisionDevice` with an `android-automotive`
system image as `runtime` and an automotive profile as `deviceType`:

```json
{
  "device": {
    "platform": "android",
    "name": "aaos-34",
    "spec": {
      "runtime": "system-images;android-34;android-automotive;x86_64",
      "deviceType": "automotive_1024p_landscape"
    }
  }
}
```

### By hand

You can still create the AVD with the Android command-line tools:

```bash
sdkmanager --list | grep android-automotive
avdmanager list device | grep -i automotive

avdmanager create avd \
  --name aaos-34 \
  --package "system-images;android-34;android-automotive;x86_64" \
  --device automotive_1024p_landscape

emulator -avd aaos-34
```

The exact image and profile ids vary by SDK version; take them from `sdkmanager --list` and
`avdmanager list device`.

AutoMobile classifies the device as `automotive` from the system-image tag (`android-automotive`) and the
profile id, so `formFactor: "automotive"` appears in the device description and can be asked for in a
device `requires` clause.

## What to expect

An AAOS image is a normal Android build, so the tools that need only adb and the accessibility tree work
unchanged: on an API 34 `android-automotive` emulator `observe`, screenshots, `tapOn`, `tapAt`, `swipeOn`,
`launchApp`, `listApps`, `pressButton` `home` and `performanceTrace` all pass. Layout is wide and landscape.
Behaviour on the cluster and passenger displays is unchecked. The full pass/fail matrix,
including which car-service commands each image accepts, is in
[Android form factors](../design-docs/plat/android/form-factors.md#automotive-baseline-on-an-emulator).

On automotive devices, `observe.automotive` reports `drivingState` (`parked`, `idling`, or `moving`),
`uxRestrictions.requiresDistractionOptimization`, the numeric `uxRestrictions.activeRestrictions`
bitmask for the observed display, and `foregroundActivity.distractionOptimized` when the foreground
activity and its DO status are known. `blocked` is true when distraction optimization is required and
the known foreground activity is not distraction optimized. Unavailable service reads omit the affected
fields; `blocked: false` alone does not establish that the app is usable. Other device types omit the
entire `automotive` block.

When the foreground screen is Car App Library templates drawn by the car host rather than the app's
own views, `observe.automotive.hostRenderedUi` is `{ "kind": "carAppLibrary", "hostPackage": ... }`.
`hostPackage` is `com.google.android.apps.automotive.templates.host` when the template nodes' resource
ids name it. Without `hostPackage`, only the foreground activity
(`androidx.car.app.activity.CarAppActivity`) identified the screen, which also matches the library's
own error screen when it cannot reach the host. Other screens omit the field; so can a template screen
whose capture was incomplete, so absence is not proof that the app drew the screen.
The template rows, titles and the toolbar `Back` button are ordinary hierarchy nodes owned by the host,
so tap them by text or resource id.

## Headless system user

Most AAOS images run a headless system user (user 0 has no UI) and the driver is a secondary user,
often user 10. On an automotive device AutoMobile reads the foreground user with `am get-current-user`
and targets that user when it installs, enables and rebinds CtrlProxy and grants its permissions,
when it reads the accessibility state to check the binding, and when launching apps without an explicit
`userId`. An explicit `userId` always wins. Other devices issue exactly the commands they
always did. If the foreground user cannot be read you get an error that names the user problem.

Right after boot the system user can still be in the foreground for a moment before the driver user takes
over. Device readiness waits for that switch before setting CtrlProxy up. If the driver user never comes
to the foreground, readiness times out with an error naming the headless system user; start the driver
user with `adb shell am switch-user <id>` and retry.

The gate uses the AVD's form factor, so a physical head unit is not covered.

## Simulating driving and night mode

Call `setDeviceState` with a `deviceCondition` object as its only field; do not combine it with
other `setDeviceState` fields. It is behind the `device-condition` feature flag, which is disabled
by default; see [Device condition fixtures](device-condition.md). The `vehicle` family supports emulators:

```json
{ "deviceCondition": { "vehicle": { "motion": "driving", "nightMode": "on" } } }
```

- `vehicle.motion`: `parked` or `driving` (gear, speed and parking brake are set together), or `unset`.
- `vehicle.nightMode`: `on`, `off`, or `unset`.

`vehicle.motion` needs a non-user image (userdebug or eng, such as `android-automotive` API 34 ext9); on a `user` build such as the Play Store AAOS image it returns `unsupported`; `vehicle.nightMode` works on both.

To check before calling, read `vehicle` in a device's `listDevices` or `getAndroid` description. It is
present only on automotive devices, as `{ "motion": ..., "nightMode": ... }` with each value
`supported`, `unsupported` or `unknown`: an `android-automotive` image reports motion `supported`, an
`android-automotive-playstore` image reports it `unsupported`, and motion is `unknown` when no car image
tag is known. A physical head unit reports both `unsupported`.

Motion uses gear and parking-brake events with continuous speed events that renew while driving is
active. The result includes `Current Driving State`: driving must remain MOVING (2) for two seconds;
parked accepts PARKED (0) or IDLING (1). Night mode uses the car service's day/night override and checks
the effective UI night mode. A state that cannot be confirmed returns `unsupported`.

When you `unset`, call `reset`, release the session or the lease expires, motion returns to the values
before the first change and night mode returns to automatic sensor control without preserving a prior
manual override. Motion reset can take about ten seconds while the last speed events expire. Phones,
physical head units and iOS return `unsupported`.

## Rotary input

`pressButton` accepts `rotary_rotate_cw` and `rotary_rotate_ccw` (with `steps`, 1 to 50),
`rotary_nudge_up`, `rotary_nudge_down`, `rotary_nudge_left`, `rotary_nudge_right` and `rotary_select`.
Nudges and select send the rotary navigation key events; rotation uses the car service's rotary
injection. Rotation and nudges move focus on an emulator; `rotary_select` succeeds but its effect depends
on the focused item. Other devices refuse these buttons. The Wear-only `rotaryScroll` warns on a car and
falls back to a swipe.

## Prototypes

The `prototype` tool's Android renderer is phone-oriented, so on a car display a prototype renders in a
wide landscape layout that was not designed for it. A successful `show` on a car reports
`formFactor: "automotive"` so you can tell why. `save` with `pin: true` keeps the saved prototype and
reports `pinned: "unsupported"` when the car launcher cannot pin shortcuts. Whether the dismiss button
clears the car system bars and whether a prototype stays visible while driving restrictions are on is
unverified.

## Car App Library templates in `observe`

An app built on the Car App Library (`androidx.car.app`) can report its template stack to `observe`, on a
phone emulator or on AAOS, without a head unit. The block appears only for a debug build of an app that
enabled the AutoMobile SDK template route; the app-side setup is in the
[design doc](../design-docs/plat/android/car-app-templates.md#app-setup). While the foreground app has the
route on, `observe` carries a `carAppTemplates` block:

- `sessions[]`: one per screen stack, with `screens[]` listed root first; the top screen has `top: true`.
- Each screen: `screenClass`, `marker`, and the `template` it last recorded (absent if it never did).
- Each template: `type` (`ListTemplate`, `GridTemplate`, `PaneTemplate`, `MessageTemplate`,
  `SearchTemplate`, `TabTemplate`, `NavigationTemplate`, ...), `title`, `headerActions`, `items` (title,
  texts, `hasImage`, `toggle` checked state, `browsable`), `actions`, `actionStrips` and, for tabs,
  `tabs` and `tabContent`.
- Every element has a stable path `id`, such as `session0/screen1/template/items/2`.

The block reports what the app built, not what the car host rendered; its `note` says so. If the app's
main thread did not answer in time, the block has `error: "main_thread_timeout"` and no sessions. Apps
that do not enable the route add nothing to `observe`.

### Back on Car App Library templates

On an Android Automotive emulator, the Car App Library templates host ignores the BACK key, so
`pressButton` `back` first sees no change. If the screen then shows one of the host's recognized Back
controls (the toolbar Back on list, grid, pane and detail screens, or the unlabelled header button on a
navigation place list), `pressButton` taps it. A press that popped the screen this way succeeds with
`backFallback` set to `toolbar_nav_icon` or `primary_header_action`. When no recognized control is
visible, such as on a root template, the press still fails with `No visual change observed`. If the tap
was sent but its result never arrived, the press reports `code: "indeterminate_outcome"` with
`retryable: false`: observe before pressing again, because the screen may already have gone back. Other
screens are unchanged.

## Secondary displays

To drive an app on another display, such as a passenger screen, pass `display` (a panel key, a role or
`active`) to `observe`, `tapOn` and `pressButton`. You can also pin it once for the session with
`setActiveDevice` `display`. An explicit `display` overrides the pin. `pressButton` sends the key to that
display and checks that display for the visual change. For `pressButton`, `active` is the focused display
(the one `observe` reads when neither `display` nor a pin is set), not the display you last observed
explicitly. An explicit `active` overrides the pin like any other `display`. A `back` that finds a Car App Library template
there taps the host's Back control on the same display. A `home` that changes nothing because that
display already shows its launcher succeeds, as it does on the default display. System actions (such
as `lock` or `quick_settings`) and rotary input still act device-wide; `display` only picks the display
that is checked. The session pin does not apply to `lock`, `power`, `power_dialog`, `volume_up`,
`volume_down` or rotary buttons: they act on the whole device, so they work even when the pinned display
is gone. Without `display` or a pin, `pressButton` presses on the default display as before. `display`
on `pressButton` is Android only.

On an emulator, create the extra display as public: the last field of `-multidisplay` must be `1`, for
example `-multidisplay 1,1280,720,160,1`. Android accessibility does not track a private virtual display
(`0`), so it has no view hierarchy and `observe` refuses it.

## Not supported

- Android Auto projection and the Desktop Head Unit; see [Android Auto and the Desktop Head Unit](android-auto.md).
- Physical head units.
- Car App Library templates as a prototype target.
