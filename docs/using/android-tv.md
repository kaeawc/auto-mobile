# Android TV emulators

AutoMobile can create, boot and drive an Android TV or Google TV emulator with the same device tools
it uses for a phone, plus D-pad focus navigation. This guide covers creating one, the lifecycle calls,
and what is out of scope.

> [!WARNING]
> Verified on the Android 36 `android-tv` `arm64-v8a` image. The Google TV image and devices
> without a touchscreen are not verified.

## Install a TV system image

AutoMobile never downloads system images. Install one first; use API 34 or newer.

```bash
sdkmanager --list | grep -E "android-tv|google-tv"
```

```bash
sdkmanager "system-images;android-36;android-tv;x86_64"
```

On an Apple silicon or other ARM host use `arm64-v8a` in place of `x86_64`. Not every API level
publishes every ABI; `sdkmanager --list` shows what exists.

## Create and start a TV emulator

Ask for a TV with `startDevice` and allow creation:

```bash
auto-mobile --cli startDevice --platform android --form-factor tv --create-if-missing
```

As an MCP call: `startDevice { platform: "android", formFactor: "tv", createIfMissing: true }`.
Creation must be allowed; see `AUTOMOBILE_ALLOW_DEVICE_CREATE` in
[Environment variables](environment-variables.md).

- Only installed `android-tv`, `google-tv` and `google-tv-ps16k` images are candidates. A phone,
  tablet, foldable or unspecified request never creates a TV, and a TV request never creates a phone.
- The newest API level in range wins, then an ABI the host can run, then the tag in the order above.
  `android-tv` is preferred over `google-tv` because Google TV images ship the Play Store, which
  usually blocks `adb root`. The verified `android-tv` user build also refuses `adb root`; this
  preference does not guarantee root access.
- The AVD uses the `tv_1080p` hardware profile and is named `AutoMobile-android-tv-<api>-<id>`
  unless you pass `name`.
- `minOsVersion` and `maxOsVersion` narrow the API range as they do for a phone.
- With no TV image installed in range, the call fails with the exact `sdkmanager` command to run.
- A repeat request with `formFactor: "tv"` reuses the created AVD instead of creating another.

For another profile such as `tv_4k` or `tv_720p`, call `provisionDevice` with an explicit spec:

```json
{
  "device": {
    "platform": "android",
    "name": "tv-36-4k",
    "spec": {
      "runtime": "system-images;android-36;android-tv;x86_64",
      "deviceType": "tv_4k"
    }
  }
}
```

## Create the emulator by hand

The Android command-line tools work too:

```bash
avdmanager create avd \
  --name tv-36 \
  --package "system-images;android-36;android-tv;x86_64" \
  --device tv_1080p
```

```bash
emulator -avd tv-36
```

`avdmanager list device | grep -i tv` lists the TV profiles.

## How AutoMobile recognises a TV

A device is `tv` when its AVD uses a TV system image or a `tv_*` profile, so `formFactor: "tv"`
appears in `listDevices` and can be asked for in a device `requires` clause or a broker
`deviceFamily`. Booted device resources derive `traits.formFactor` from `ro.build.characteristics`, and an
emulator whose value carries no form factor reports `tv` when it has the
`android.software.leanback` feature.

## Lifecycle

| Step       | Call                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| Detect     | `listDevices`                                                                     |
| Create     | `startDevice` with `formFactor: "tv"` and `createIfMissing`, or `provisionDevice` |
| Start/boot | `startDevice { platform: "android", formFactor: "tv" }`                           |
| Shut down  | `killDevice`                                                                      |
| Delete     | `deleteDevice`, or `avdmanager delete avd -n <name>`                              |

## Navigating a TV app

TV apps are driven by focus, not touch. Use `focusNavigate` to move D-pad focus to an element and
`sendKeys` with `enter` to activate the focused item; activation is verified on this image.
`pressButton` handles back and home.

`focusNavigate` matches a target on the focused element or on a node inside its bounds, so a label
on a child view of the focused row counts. A large focused container that holds the target also
counts as focused.

`tapOn` and `swipeOn` were checked only on an image that reports a touchscreen. Their behaviour
on devices without a touchscreen is unverified.

Prototype overlays can be shown and dismissed, but their buttons are not reachable with D-pad
focus. Use `prototype` with `dismiss` to close the overlay.

## Out of scope

- Physical TVs and Chromecast hardware.
- Casting.
- Downloading system images.
