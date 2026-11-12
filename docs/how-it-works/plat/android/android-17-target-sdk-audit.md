# Android 17 behaviour changes for targetSdk 37 (CtrlProxy audit)

CtrlProxy reads `targetSdk = 37`, `compileSdk = 37` and `buildTools = 37.0.0` from
`android/gradle/libs.versions.toml`. The Robolectric maximum stays 35, with the CtrlProxy SDK 24
and Playground SDK 30 test pins.

Facts the targetSdk 37 behaviour changes depend on:

- **Local network.** The only listener binds loopback: `embeddedServer(CIO, host = "127.0.0.1", ...)`
  in `WebSocketServer.kt`, reached from the host through `adb forward`. The prototype device client
  makes outbound LAN calls (for example to 10.0.2.2), so CtrlProxy declares `ACCESS_LOCAL_NETWORK`.
- **Cross-profile reads** use no socket: `SdkCapabilitiesDiscovery` addresses another user's provider
  through `content://<userId>@<authority>` (binder, gated on `INTERACT_ACROSS_USERS`).
- **No TLS of its own.** CtrlProxy main has no `HttpURLConnection`, `HttpClient`, `SSLContext`,
  `TrustManager` or `DownloadManager`; the Ktor client is `testImplementation` only.
  `MANAGE_CA_CERTIFICATES` serves target apps' interception, not CtrlProxy traffic.
- **No background launches through `IntentSender`** and no orientation, resizability or aspect-ratio
  locks in the manifest (including `SavedPrototypeActivity`, whose `configChanges` handles orientation
  and screen-size changes without locking them).
- **IME.** `CtrlProxyIme.kt` commits with `commitText` and uses no `TextAttribute`;
  `TextAttribute.Builder.setTextSuggestionSelected()` is API 37 only and would need an `SDK_INT` guard.

## Background

- [Android 17 CtrlProxy targetSdk 37 audit](../../../devlog/2026-10-14-android-17-target-sdk-audit.md)
