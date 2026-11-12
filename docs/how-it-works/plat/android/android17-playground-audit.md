# Android 17 (targetSdk 37) audit: Playground app

Playground modules read `targetSdk = 37`, `compileSdk = 37` and `buildTools = 37.0.0` from the
version catalog (`android/gradle/libs.versions.toml`). Robolectric stays capped at SDK 35, with the
app test pin at SDK 30 and CtrlProxy at SDK 24.

Behaviour that the targetSdk 37 audit fixed in place:

- **No background playback.** `VideoPlayerScreen.kt` and `AudioPlayerComponent.kt` observe `ON_STOP`
  through `LocalLifecycleOwner` and call `MediaPlayerViewModel.onHostStopped()`, removing observers on
  disposal. The ViewModel delegates to the pure `HostPlayback` seam, which pauses media with play
  intent, including while buffering; paused or idle hosts stay unchanged. There is no automatic
  resume and no service or permission for playback, so the policy is the same at targetSdk 36 and 37.
  `FullscreenMediaPlayer` only simulates progress and has no media player.
- **No reflection in login.** `LoginScreen.kt` sets `userPreferences.isAuthenticated = true`
  directly; the parameter is typed `UserPreferences`.

## Background

- [Android 17 Playground audit](../../../devlog/2026-10-14-android17-playground-audit.md)
