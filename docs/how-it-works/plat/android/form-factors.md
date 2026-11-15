# Android form factors: TV, Wear OS and Android Auto

Form-factor support, navigation contracts and remaining verification gaps.

> [!WARNING]
> **Wear OS remains unverified on emulators.** The TV section is verified on the Android 36 `android-tv` and `google-tv` `arm64-v8a` user images and the Automotive OS baseline on the images named in its section below. "Verified in the repo" means read from this checkout; "Hypothesis" means from AOSP and Android documentation.

Per-form-factor detail is on these pages:

- [Common behaviour](form-factors-common.md)
- [Android TV](form-factors-tv.md)
- [TV behaviour, limits and fixture apps](form-factors-tv-fixtures.md)
- [Wear OS, Android Auto and Android Automotive OS](form-factors-wear-auto.md)

## Verdicts

| Form factor                                  | Verdict            | Smallest useful tool surface                                                                       | Main risk                                                                                          |
| -------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Android TV / Google TV                       | **Go**             | `focusNavigate`, a `select` key on `sendKeys` only if `enter` falls short, TV form-factor matching | Real touchless hardware and touch-only `tapOn` options unverified; child-label `focusNavigate` gap |
| Wear OS                                      | **Conditional go** | rotary scroll, `isScreenRound` in `observe`, ambient toggle                                        | Ambient reads `inAmbient` from `dumpsys wear_service`; hardware wake is untested                   |
| Android Auto (projection to a DHU)           | **No-go**          | none                                                                                               | The car UI is not in any accessibility tree AutoMobile can read                                    |
| Android Automotive OS (an AAOS system image) | **Go**             | existing tools; rotary `pressButton` buttons; `vehicle` `deviceCondition`                          | Play Store `user` images refuse vehicle-motion injection; secondary displays                       |

Android Auto projects a phone's UI to a head unit; Automotive OS is a full Android build on the car. Only the latter is feasible.

## Not covered

- Android Auto projection UI in the phone's accessibility tree (no-go above).
- Automotive OS cluster and passenger displays.
- The Wear Settings app differs, so CtrlProxy's enable path on Wear is unverified; service connect plus hierarchy is the first check per Wear image.

## Background

- [Android form-factor spike: TV, Wear OS and Android Auto](../../../devlog/2026-10-22-form-factors-spike.md)
- [Android Auto stub and DHU 2.1 on a Play emulator](../../../devlog/2026-11-08-form-factors-android-auto-dhu-stub.md)
