# Android Automotive OS emulators

AutoMobile can drive an Android Automotive OS (AAOS) emulator: a full Android build for the car, with a
car SystemUI and an accessibility tree like any other Android image.

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

Pass that to `startDevice`.

| Aspect             | Behavior                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Candidate images   | Installed `android-automotive-playstore` and `android-automotive` images only                                             |
| Preference order   | The Play image, then the newest API level in your `minOsVersion` / `maxOsVersion` range, then an ABI your machine can run |
| Profile            | `automotive_1024p_landscape`                                                                                              |
| Other form factors | A phone, tablet or foldable request never gets a car image                                                                |
| No image in range  | The error names the `sdkmanager` command to run                                                                           |
| Repeat request     | Reuses the car emulator instead of creating another                                                                       |
| Verified images    | Creating and booting works with an `android-automotive` image; unverified with a Play Store car image                     |

If the test will drive the car, ask for that up front so you never get a Play image:

```json
{
  "platform": "android",
  "formFactor": "automotive",
  "createIfMissing": true,
  "requires": { "vehicle": { "motion": "supported" } }
}
```

`requires.vehicle.motion: "supported"` works on `startDevice` and `getAndroid`. It matches only an
emulator built from an `android-automotive` image, and creates one from such an image instead of the
Play image. If none is installed in the range, the error names the `sdkmanager` package to install.
AutoMobile refuses it for a non-automotive request. To read what a device supports, see
[Checking support](#checking-support).

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

AutoMobile classifies the device as `automotive` from the system-image tag (`android-automotive`) and
the profile id. The device description then shows `formFactor: "automotive"`, and a device `requires`
clause can ask for it.

## What to expect

An AAOS image is a normal Android build, so the tools that need only adb and the accessibility tree
work unchanged. On an API 34 `android-automotive` emulator, `observe`, screenshots, `tapOn`, `tapAt`,
`swipeOn`, `launchApp`, `listApps`, `pressButton` `home` and `performanceTrace` all pass. Layout is
wide and landscape. Behaviour on the cluster and passenger displays is unchecked. The full pass/fail
matrix, including which car-service commands each image accepts, is in
[Android form factors](../how-it-works/plat/android/form-factors.md#automotive-baseline-on-an-emulator).

On automotive devices, `observe.automotive` reports these fields. Other device types omit the whole
block.

| Field                                            | Meaning                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drivingState`                                   | `parked`, `idling` or `moving`                                                                                                                                                                              |
| `uxRestrictions.requiresDistractionOptimization` | Whether the car requires distraction-optimized activities                                                                                                                                                   |
| `uxRestrictions.activeRestrictions`              | Numeric restrictions bitmask for the observed display                                                                                                                                                       |
| `foregroundActivity.distractionOptimized`        | Whether the foreground activity is distraction optimized, when known                                                                                                                                        |
| `blocked`                                        | `true` when distraction optimization is required and the known foreground activity is not distraction optimized, or when the car's blocking screen ("You can’t use this feature while driving") is in front |
| `blockedBy`                                      | The car's blocking activity, when its blocking screen is in front                                                                                                                                           |
| `blockedActivity`                                | Your activity that the blocking screen covers                                                                                                                                                               |
| `hostRenderedUi`                                 | Present when the car host draws the foreground screen from Car App Library templates (see below)                                                                                                            |

When a service read fails, AutoMobile omits the affected fields, so `blocked: false` alone does not
show that the app is usable.

| `hostRenderedUi` value                                                                            | Meaning                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ "kind": "carAppLibrary", "hostPackage": "com.google.android.apps.automotive.templates.host" }` | The template nodes' resource ids name the host                                                                                                                              |
| `{ "kind": "carAppLibrary" }` without `hostPackage`                                               | Only the foreground activity (`androidx.car.app.activity.CarAppActivity`) identified the screen; this also matches the library's error screen when it cannot reach the host |
| Absent                                                                                            | Any other screen, or a template screen whose capture was incomplete; absence does not prove that the app drew the screen                                                    |

The template rows, titles and the toolbar `Back` button are ordinary hierarchy nodes owned by the
host, so tap them by text or resource id.

## Headless system user

Most AAOS images run a headless system user (user 0 has no UI), and the driver is a secondary user,
often user 10. On an automotive device AutoMobile reads the foreground user with
`am get-current-user` and targets that user when it:

- installs, enables and rebinds CtrlProxy and grants its permissions;
- reads the accessibility state to check the binding;
- launches apps without an explicit `userId`.

An explicit `userId` always wins. Other devices are unaffected. If AutoMobile cannot read the
foreground user, you get an error that names the user problem.

Right after boot the system user can stay in the foreground for a moment before the driver user takes
over. Device readiness waits for that switch before setting CtrlProxy up. If the driver user never
comes to the foreground, readiness times out with an error naming the headless system user. Start the
driver user with `adb shell am switch-user <id>` and retry.

This handling uses the AVD's form factor, so it does not cover a physical head unit.

## Simulating driving and night mode

Call `setDeviceState` with a `deviceCondition` object as its only field; do not combine it with
other `setDeviceState` fields. It sits behind the `device-condition` feature flag, which is off by
default; see [Device condition fixtures](device-condition.md). The `vehicle` family supports emulators:

```json
{ "deviceCondition": { "vehicle": { "motion": "driving", "nightMode": "on" } } }
```

| Field               | Values                                                                     | Image                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `vehicle.motion`    | `parked`, `driving` (sets gear, speed and parking brake together), `unset` | Non-user build (userdebug or eng, such as `android-automotive` API 34 ext9); `unsupported` on a `user` build such as the Play Store image |
| `vehicle.nightMode` | `on`, `off`, `unset`                                                       | Both                                                                                                                                      |

A test plan step takes the same object: `tool: setDeviceState` with `params.deviceCondition.vehicle`.

Motion sends gear and parking-brake events, plus speed events that keep renewing while driving. The
result includes `Current Driving State`. Driving must stay MOVING (2) for two seconds; parked accepts
PARKED (0) or IDLING (1). Night mode uses the car service's day/night override and checks the
effective UI night mode. A state that AutoMobile cannot confirm returns `unsupported`.

While driving, `launchApp` of an activity that is not distraction optimized fails right away. The
error contains `blocked_by_driving_restrictions` and names the blocked activity and the car's blocking
activity. Park with `{ "deviceCondition": { "vehicle": { "motion": "parked" } } }` and launch again,
or launch an activity declared `distractionOptimized`.

Reset happens when you `unset`, call `reset`, release the session, or the lease expires.

- Motion returns to the values before the first change. This can take about ten seconds while the
  last speed events expire.
- Night mode returns to automatic sensor control and does not restore a prior manual override.

Phones, physical head units and iOS return `unsupported`.

### Checking support

Read `vehicle` in a device's `listDevices` or `getAndroid` description, or in its booted-devices
resource entry (`traits.vehicle`). Only automotive devices have it, as
`{ "motion": ..., "nightMode": ... }`.

| Device                                           | `motion`      |
| ------------------------------------------------ | ------------- |
| `android-automotive` image                       | `supported`   |
| `android-automotive-playstore` image             | `unsupported` |
| No known car image tag                           | `unknown`     |
| Booted emulator whose build props cannot be read | `unknown`     |
| Physical head unit                               | `unsupported` |

A booted car emulator reports `nightMode` `supported`. A physical head unit reports both
`unsupported`, because AutoMobile injects vehicle state on emulators only. In the booted-devices
resource, a booted car emulator's build props take precedence over the image tag. Motion is then
known there even when the image is not.

## Rotary input

| `pressButton` button                                                              | Effect                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `rotary_rotate_cw`, `rotary_rotate_ccw` (with `steps`, 1 to 50)                   | Rotation through the car service's rotary injection; moves focus on an emulator   |
| `rotary_nudge_up`, `rotary_nudge_down`, `rotary_nudge_left`, `rotary_nudge_right` | Rotary navigation key events; moves focus on an emulator                          |
| `rotary_select`                                                                   | Rotary navigation key event; succeeds, but its effect depends on the focused item |

Other devices refuse these buttons. The Wear-only `rotaryScroll` warns on a car and falls back to a
swipe.

## Prototypes

The `prototype` tool's Android renderer targets phones, so on a car display a prototype renders in a
wide landscape layout not designed for it. A successful `show` on a car reports
`formFactor: "automotive"` so you can tell why. `save` with `pin: true` keeps the saved prototype and
reports `pinned: "unsupported"` when the car launcher cannot pin shortcuts. It is unverified whether
the dismiss button clears the car system bars, and whether a prototype stays visible under driving
restrictions.

## Car App Library templates in `observe`

An app built on the Car App Library (`androidx.car.app`) can report its template stack to `observe`,
on a phone emulator or on AAOS, without a head unit. Only a debug build of an app that enabled the
AutoMobile SDK template route reports it. While the foreground app has the route on, `observe`
carries a `carAppTemplates` block:

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

### Adding the SDK template route

The template route is in the AutoMobile SDK, `dev.jasonpearson.auto-mobile:auto-mobile-sdk`. Maven
Central has the SDK only up to `0.0.67`, which predates the template route. Build a newer release from
its tag and publish it to your local Maven repository (`~/.m2`). This needs JDK 21 and an Android SDK
(`ANDROID_HOME` set, or `sdk.dir` in `android/local.properties`):

```bash
git clone --depth 1 --branch <version> https://github.com/kaeawc/auto-mobile.git
cd auto-mobile/android
./gradlew :protocol:publishToMavenLocal :auto-mobile-sdk:publishToMavenLocal -PVERSION_NAME=<version>
```

Add `mavenLocal()` to the app's repositories and the SDK to the app module. Use `implementation`,
not `debugImplementation`, because the `record` call sits in main source. A release build carries the
SDK with the route off, since `enable` does nothing in a non-debuggable build.

```kotlin
android {
  compileSdk = 37
}

dependencies {
  implementation("dev.jasonpearson.auto-mobile:auto-mobile-sdk:<version>")
}
```

The SDK requires `compileSdk` 37 or newer and brings a Kotlin 2.4 standard library, so build the app
with Kotlin 2.3 or newer. The app already depends on the Car App Library (`androidx.car.app`); the SDK
does not add it.

Turn the route on once and pass each template through `record` as `onGetTemplate` returns it:

```kotlin
// Once, e.g. in your CarAppService or Session.
AutoMobileCarAppTemplates.enable(context)

override fun onGetTemplate(): Template =
  AutoMobileCarAppTemplates.record(this, ListTemplate.Builder() /* ... */.build())
```

`enable` returns `false` and does nothing in a non-debuggable build.

### Back on Car App Library templates

On an Android Automotive emulator, the Car App Library templates host ignores the BACK key, so
`pressButton` `back` first sees no change. The press then taps one of the host's recognized Back
controls if the screen shows it:

| Control                                             | `backFallback` on success |
| --------------------------------------------------- | ------------------------- |
| Toolbar Back on list, grid, pane and detail screens | `toolbar_nav_icon`        |
| Unlabelled header button on a navigation place list | `primary_header_action`   |

When no recognized control is visible, such as on a root template, the press still fails with
`No visual change observed`. If the tap went out but its result never arrived, the press reports
`code: "indeterminate_outcome"` with `retryable: false`. Observe before pressing again, because the
screen may already have gone back. Other screens are unchanged.

## Secondary displays

To drive an app on another display, such as a passenger screen, see
[Android Automotive secondary displays](android-automotive-displays.md).

## Not supported

- Android Auto projection and the Desktop Head Unit; see [Android Auto and the Desktop Head Unit](android-auto.md).
- Physical head units.
- Car App Library templates as a prototype target.
