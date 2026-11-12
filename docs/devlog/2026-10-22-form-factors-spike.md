# Android form-factor spike: TV, Wear OS and Android Auto

- Kind: idea
- Date: 2026-10-22
- Source: moved from `how-it-works/plat/android/form-factors.md`; #4680, #14949, #15053
- Shaped: [Android form factors: TV, Wear OS and Android Auto](../how-it-works/plat/android/form-factors.md)

## Spike plan: device selection change

1. Extend `FormFactor` and `BINDING_DEVICE_FAMILIES` with `tv`, `watch`, `automotive`.
2. In `formFactorFrom`, classify from the system-image tag before geometry.
3. Surface form factor in `getAndroid` and the device description so a `requires` clause (#4680) can ask for it.

Needs no device to build; phones, tablets and foldables keep the same geometry path.

The TV step of the spike's tool plan was the same: extend `FormFactor` with `tv`, classified from the
system-image tag first, geometry second.

## Why `focusNavigate` is a tool, not an agent loop

One call replaces up to 30 round-trips, and stuck detection needs the previous observation.

## Hypotheses to confirm

- Unconfirmed sdkmanager tags: `android-wear`, `android-wear-cn`, `android-automotive`, `android-automotive-playstore` (`sdkmanager --list`). Unconfirmed avdmanager profiles: `wearos_small_round`, `wearos_large_round`, `wearos_rect`, `wearos_square`, `automotive_1024p_landscape` (`avdmanager list device`). TV tags and profiles are confirmed below.
- CtrlProxy installation, host-side accessibility enable and hierarchy observation work unchanged on the verified TV image. Wear has a different Settings app and its enable path remains unverified; service connect plus hierarchy is the first check per Wear image.

## Verification checklist

Record command, image id and API level.

| #   | Image                                    | Check                                                                                                                                                                    |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | TV (`android-tv` or `google-tv`, API 34) | `avdmanager create avd` with `--device tv_1080p` succeeds; the AVD boots                                                                                                 |
| 2   | TV                                       | `adb install` of the CtrlProxy APK succeeds; the service can be enabled from the host; `observe` returns a hierarchy                                                     |
| 3   | TV                                       | `sendKeys` with `arrow_right` moves focus and `observe.focusedElement` changes; `enter` and, if that does not work, `KEYCODE_DPAD_CENTER` activate the focused item      |
| 4   | TV                                       | `tapOn` works on an image with no touchscreen                                                                                                                            |
| 5   | Wear (`android-wear`, API 34)            | The same install, enable and `observe` checks as TV                                                                                                                      |
| 6   | Wear                                     | Each rotary candidate against a `ScalingLazyColumn`: which one changes the scroll position                                                                               |
| 7   | Wear                                     | `ambient` uses `KEYCODE_SLEEP`/`KEYCODE_WAKEUP`; `inAmbient` in `dumpsys wear_service` follows it (verified on API 37). Hardware wake by tilt or touch remains untested. |
| 8   | Wear                                     | `isScreenRound` is true on `wearos_small_round`; the left-edge swipe dismisses a screen                                                                                  |
| 9   | Automotive (`android-automotive`)        | Behavior of the cluster and passenger displays (install, enable and `observe` are in the baseline above)                                                                 |
| 10  | Any                                      | `sdkmanager --list` shows the tags named above; `avdmanager list device` shows the profile ids                                                                           |
