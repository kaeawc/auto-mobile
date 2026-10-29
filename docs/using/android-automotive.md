# Android Automotive OS emulators

AutoMobile can drive an Android Automotive OS (AAOS) emulator: a full Android build for the car, with a
car SystemUI and an accessibility tree like any other Android image. This guide covers setting one up,
what to expect, and what is out of scope.

> [!WARNING]
> **Image support varies.** Some emulator interactions below remain unverified. Vehicle conditions
> check the effective driving or night state before reporting success; a command accepted by the car
> service alone does not confirm that the requested state took effect.

## Create the emulator by hand

Automatic creation through `provisionDevice` is out of scope for now; create the AVD with the Android
command-line tools.

```bash
# Pick an automotive system image. Use a current API level; the playstore variant adds Google Play.
sdkmanager --list | grep android-automotive
sdkmanager "system-images;android-34;android-automotive;x86_64"

# List device profiles and pick the automotive one.
avdmanager list device | grep -i automotive

avdmanager create avd \
  --name aaos-34 \
  --package "system-images;android-34;android-automotive;x86_64" \
  --device automotive_1024p_landscape

emulator -avd aaos-34
```

The exact image and profile ids vary by SDK version; take them from `sdkmanager --list` and
`avdmanager list device` (unverified).

AutoMobile classifies the device as `automotive` from the system-image tag (`android-automotive`) and the
profile id, so `formFactor: "automotive"` appears in the device description and can be asked for in a
device `requires` clause.

## What to expect

An AAOS image is a normal Android build, so the tools that need only adb and the accessibility tree
(`observe`, `tapOn`, `swipeOn`, `sendKeys`, `launchApp`) are expected to work unchanged. Layout is wide and
landscape, and the cluster or passenger displays may appear as extra displays. The pass/fail matrix from
the baseline run will live in `docs/design-docs/plat/android/form-factors.md`; until it exists, treat all
of this as unverified.

## Headless system user

Most AAOS images run a headless system user (user 0 has no UI) and the driver is a secondary user,
often user 10. On an automotive device AutoMobile reads the foreground user with `am get-current-user`
and targets that user when it installs, enables and rebinds CtrlProxy and grants its permissions,
when it reads the accessibility state to check the binding, and when launching apps without an explicit
`userId`. An explicit `userId` always wins. Other devices issue exactly the commands they
always did. If the foreground user cannot be read you get an error that names the user problem.

The gate uses the AVD's form factor, so a physical head unit is not covered.

## Simulating driving and night mode

Call `setDeviceState` with a `deviceCondition` object as its only field; do not combine it with
other `setDeviceState` fields. It is behind the `device-condition` feature flag, which is disabled
by default. The `vehicle` family supports emulators:

```json
{ "deviceCondition": { "vehicle": { "motion": "driving", "nightMode": "on" } } }
```

- `vehicle.motion`: `parked` or `driving` (gear, speed and parking brake are set together), or `unset`.
- `vehicle.nightMode`: `on`, `off`, or `unset`.

Motion uses gear and parking-brake events with continuous speed events that renew while driving is
active. The result includes `Current Driving State`: driving must remain MOVING (2) for two seconds;
parked accepts PARKED (0) or IDLING (1). Night mode uses the car service's day/night override and checks
the effective UI night mode. A state that cannot be confirmed returns `unsupported`.

When you `unset`, call `reset`, release the session or the lease expires, motion returns to the values
before the first change and night mode returns to automatic sensor control. Motion reset can take about
ten seconds while the last speed events expire. Phones, physical head units and iOS return `unsupported`.

## Rotary input

`pressButton` accepts `rotary_rotate_cw` and `rotary_rotate_ccw` (with `steps`, 1 to 50),
`rotary_nudge_up`, `rotary_nudge_down`, `rotary_nudge_left`, `rotary_nudge_right` and `rotary_select`.
Nudges and select send the rotary navigation key events; rotation uses the car service's rotary
injection. Other devices refuse these buttons. Unverified on an emulator.

## Prototypes

The `prototype` tool's Android renderer is phone-oriented. On an AAOS emulator it may render in a wide
landscape layout that was not designed for it, may be limited while driving restrictions are on, and
`save` relies on pinned launcher shortcuts that the car launcher may not support. The goal is a working
smoke path with truthful results, not a car design system (#14922).

## Not supported

- Android Auto projection and the Desktop Head Unit (see #14118).
- Physical head units.
- Car App Library templates as a prototype target.
