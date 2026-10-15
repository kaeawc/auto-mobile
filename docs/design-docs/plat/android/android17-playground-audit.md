# Android 17 (targetSdk 37) audit: Playground app

Tracks #12275 (part of #12270, consumed by #12276). Scope: `android/playground/*`
on this base. Playground `targetSdk` is bumped to 37 by #12276, with
`buildTools = 37.0.0` and `compileSdk = 37` unchanged
(`android/gradle/libs.versions.toml`); every playground module reads these
from the version catalog. Robolectric remains capped at SDK 35, with the app
test pin at SDK 30 and CtrlProxy at SDK 24.

## Results

| Change                                                                                        | Verdict                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background audio restrictions                                                                 | Foreground-only decision implemented by #12276 | No scenario requires background playback. `VideoPlayerScreen.kt` and `AudioPlayerComponent.kt` observe `ON_STOP` via `LocalLifecycleOwner` and call `MediaPlayerViewModel.onHostStopped()`, removing observers on disposal. The ViewModel delegates to the pure `HostPlayback` seam, which pauses media with play intent, including while buffering; paused/idle hosts stay unchanged. No automatic resume, services or permissions were added. This gives the same explicit stop policy at targetSdk 36 and 37. `FullscreenMediaPlayer` only simulates progress; it has no media player. |
| Large-screen orientation / resizability                                                       | Not affected                                   | No `screenOrientation`, `setRequestedOrientation`, `resizeableActivity`, `maxAspectRatio` or `minAspectRatio` in any playground manifest or source (`app/src/main/AndroidManifest.xml:17-21,41-44`). Layouts already adapt to orientation (`login/.../LoginScreen.kt:94-104`, `slides/.../LargeTextSlideItem.kt:39-41`, `mediaplayer/.../VideoPlayerScreen.kt:90`). Fixed sizes are small and incidental (e.g. `MediaPlayerScreen.kt:250`, `OnboardingScreen.kt:144`).                                                                                                                    |
| Reflection on `static final` fields                                                           | Not affected, but fixed                        | `LoginScreen.kt` set the instance property `isAuthenticated` reflectively. `UserPreferences.isAuthenticated` (`storage/.../UserPreferences.kt:19-23`) is a custom-accessor property with no backing field, so the lookup could not succeed. Replaced with a direct `userPreferences.isAuthenticated = true`, and the parameter is now typed `UserPreferences`. Other reflection: only a `java.lang.reflect.Proxy` in a test (`discover/src/test/.../LoggingInputConnectionTest.kt`).                                                                                                      |
| Background activity launch via `IntentSender`, `System.load`, Contacts / SMS, content capture | Not affected                                   | No `IntentSender`, `System.load`/`loadLibrary`, `ContactsContract`, Telephony/SMS, `ContentCapture` or `PendingIntent` in playground. `startActivity` is in UI code (`discover/.../ictrace/IcTraceScreen.kt:99`) and in `app/.../navigation/DeepLinkManager.kt:614`, which only the unreferenced `navigateTo*ForTest` helpers (`:461-518`) call; the only receivers are debug-only (`app/src/debug/AndroidManifest.xml:4-19`) and start no activity.                                                                                                                                      |
| Certificate Transparency / ECH                                                                | Not affected                                   | No `TrustManager`, `SSLContext`, `networkSecurityConfig`, cleartext flag or mock TLS server in playground. OkHttp (`app/.../App.kt:12-25`, `demos/.../NetworkTestScreen.kt:66-76`) talks to public HTTPS hosts with platform trust; mocking is in-process via the SDK interceptor.                                                                                                                                                                                                                                                                                                        |

## Checklist for #12276 (targetSdk 37 bump)

- [x] Bump `targetSdk` to 37 and `buildTools` to 37.0.0 in #12276; preserve `compileSdk` and Robolectric pins.
- [x] Decide background playback is unnecessary and pause active audio/video on `ON_STOP`.
      The pure host-stop seam is covered by fake-player JUnit tests for playing,
      buffering with play intent, already-paused, idle and uninitialized hosts,
      including repeated stops. No Robolectric is needed.
- [ ] After the bump, run the emulator suites on a tablet or foldable profile
      (smallest width of 600dp or more) and confirm the layouts above still
      render, since orientation and aspect locks are ignored there (owed: API 37 lane (#12273)).
- [ ] Re-run the login flow on a device: the direct-API change above makes the
      success path navigate to Home, which the reflective code could not do.
      This change is not device-verified (owed: API 37 lane (#12273)).
- [x] Repeat the non-test source re-grep at bump time (results below).
- [ ] Verify the playground suites on API 37 and on the existing API levels (owed: API 37 lane (#12273), plus existing-level driver coverage).

## Bump-time re-grep (#12276)

Repeated on 2026-10-15 across `android/control-proxy/src/main` and
`android/playground`, excluding `test`, `androidTest`, `testFixtures` and `build`
directories: no matches for `IntentSender`, `MODE_BACKGROUND_ACTIVITY_START`,
`setAccessible`, `MessageQueue`, `System.load`, `ContactsContract` or `TrustManager`.
The additional Playground SMS/content-capture/TLS terms (`Telephony`, `SmsManager`,
`ContentCapture`, `SSLContext`, `networkSecurityConfig`) also had no matches.
`SavedPrototypeActivity` exists on this base in CtrlProxy; its manifest entry has
no orientation, resizability or aspect-ratio locks (see the CtrlProxy audit).
Device-only validation remains owed: API 37 lane (#12273).
