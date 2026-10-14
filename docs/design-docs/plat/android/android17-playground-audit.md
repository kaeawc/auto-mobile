# Android 17 (targetSdk 37) audit: Playground app

Tracks #12275 (part of #12270, consumed by #12276). Scope: `android/playground/*`
on main. Playground currently builds with `compileSdk = 37`, `targetSdk = 36`
(`android/gradle/libs.versions.toml:8-10`); every playground module reads these
from the version catalog. This audit does not change either value.

## Results

| Change                                                                                        | Verdict                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background audio restrictions                                                                 | Not affected by any test; no supported background path | `mediaplayer/.../MediaPlayerViewModel.kt:57` builds ExoPlayer with no `AudioAttributes`, `setHandleAudioFocus` or wake mode; `:198` pauses only in `togglePlayPause()`; `VideoPlayerScreen.kt:228-231` and `AudioPlayerComponent.kt:78-81` release the player on dispose. No `Service`, `MediaSession` or `FOREGROUND_SERVICE` anywhere in playground (`app/src/main/AndroidManifest.xml:5-6` declares only INTERNET and POST_NOTIFICATIONS).                                        |
| Large-screen orientation / resizability                                                       | Not affected                                           | No `screenOrientation`, `setRequestedOrientation`, `resizeableActivity`, `maxAspectRatio` or `minAspectRatio` in any playground manifest or source (`app/src/main/AndroidManifest.xml:17-21,41-44`). Layouts already adapt to orientation (`login/.../LoginScreen.kt:94-104`, `slides/.../LargeTextSlideItem.kt:39-41`, `mediaplayer/.../VideoPlayerScreen.kt:90`). Fixed sizes are small and incidental (e.g. `MediaPlayerScreen.kt:250`, `OnboardingScreen.kt:144`).               |
| Reflection on `static final` fields                                                           | Not affected, but fixed                                | `LoginScreen.kt` set the instance property `isAuthenticated` reflectively. `UserPreferences.isAuthenticated` (`storage/.../UserPreferences.kt:19-23`) is a custom-accessor property with no backing field, so the lookup could not succeed. Replaced with a direct `userPreferences.isAuthenticated = true`, and the parameter is now typed `UserPreferences`. Other reflection: only a `java.lang.reflect.Proxy` in a test (`discover/src/test/.../LoggingInputConnectionTest.kt`). |
| Background activity launch via `IntentSender`, `System.load`, Contacts / SMS, content capture | Not affected                                           | No `IntentSender`, `System.load`/`loadLibrary`, `ContactsContract`, Telephony/SMS, `ContentCapture` or `PendingIntent` in playground. `startActivity` is reached only from UI (`app/.../navigation/DeepLinkManager.kt:614`, `discover/.../ictrace/IcTraceScreen.kt:99`); the only receivers are debug-only (`app/src/debug/AndroidManifest.xml:4-19`) and start no activity.                                                                                                         |
| Certificate Transparency / ECH                                                                | Not affected                                           | No `TrustManager`, `SSLContext`, `networkSecurityConfig`, cleartext flag or mock TLS server in playground. OkHttp (`app/.../App.kt:12-25`, `demos/.../NetworkTestScreen.kt:66-76`) talks to public HTTPS hosts with platform trust; mocking is in-process via the SDK interceptor.                                                                                                                                                                                                   |

## Checklist for #12276 (targetSdk 37 bump)

- [ ] Decide whether background playback is part of any scenario. No test, plan,
      script or doc expects playback to continue after Home or recents
      (`slides/src/test/resources/test-plans/auto-mobile-playground.yaml:45-56`
      only plays a video and returns). If none is added, nothing changes; if one
      is, add a media-session foreground service with a `mediaPlayback` type, the
      matching permission, and `AudioAttributes` with `setHandleAudioFocus(true)`
      on the ExoPlayer.
- [ ] After the bump, run the emulator suites on a tablet or foldable profile
      (smallest width of 600dp or more) and confirm the layouts above still
      render, since orientation and aspect locks are ignored there.
- [ ] Re-run the login flow on a device: the direct-API change above makes the
      success path navigate to Home, which the reflective code could not do.
      This change is not device-verified.
- [ ] Re-grep for the not-found items (`IntentSender`, `System.load`, Contacts,
      SMS, content capture, TLS trust code) in case playground code lands
      between this audit and the bump.
- [ ] Verify the playground suites on API 37 (#12273) and on the existing API levels.
