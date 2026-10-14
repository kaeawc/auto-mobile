# Android 17 behaviour changes for targetSdk 37 (CtrlProxy audit)

Issue #12274 (part of #12270, blocks #12276). Audit of `android/control-proxy` on
main against the Android 17 behaviour changes that apply once an app targets API 37.
`targetSdk` is still 36 (`android/gradle/libs.versions.toml`); `compileSdk` is 37.
No code change was needed before the bump, so this document is the deliverable and
the checklist that #12276 consumes.

Method: static search of `android/control-proxy/src/main` (manifest, Kotlin, resources).
Nothing here is device-verified; items marked "device check" are owed to the API 37
emulator lane (#12273).

## Results

| Change                                                      | Result                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background activity launches through `IntentSender`         | Not affected                      | No `PendingIntent`, `IntentSender` or `MODE_BACKGROUND_ACTIVITY_START_*` in `src/main`. The only `startActivity` calls are `MainActivity.kt:164` (`ACTION_ACCESSIBILITY_SETTINGS`, from the foreground activity) and `PermissionManager.kt:76` (`ACTION_MANAGE_OVERLAY_PERMISSION`, `FLAG_ACTIVITY_NEW_TASK`). Neither passes an `IntentSender`.                                                                                                                                                                                        |
| Reflective `static final` writes, `MessageQueue` reflection | Not affected                      | No `setAccessible`, `MessageQueue` or `Unsafe` in `src/main`. Reflection in main is read-only lookup: `DeviceStateTransitions.kt:48-50` and `CtrlProxy.kt:6952-6953` (both owned by #12271), and `PrototypeIcons.kt:56` (`Class.forName` of a bundled Compose icon class). Robolectric tests use `ReflectionHelpers.setField`/`getField` on instance fields and Java `getDeclaredMethod`, never static finals (`CtrlProxyGestureServiceFixture.kt:44-71`, `SdkAnrBroadcastHandlerTest.kt:276-294`, `CtrlProxyOnDestroyTest.kt:80-209`). |
| Local network permission (`ACCESS_LOCAL_NETWORK`)           | Likely not affected; device check | The only listener binds loopback: `WebSocketServer.kt:612` (`embeddedServer(CIO, host = "127.0.0.1", ...)`) and the port probe at `WebSocketServer.kt:47`. CtrlProxy opens no outbound LAN connections. The host reaches the port through `adb forward`. Owed: confirm on the API 37 lane that `observe` over the forwarded port works with no `ACCESS_LOCAL_NETWORK` grant.                                                                                                                                                            |
| Cross-profile loopback block                                | Not affected                      | Work-profile reads do not use loopback. `SdkCapabilitiesDiscovery.kt:25-26,75-78` addresses another user's provider through `content://<userId>@<authority>` (binder, gated on `INTERACT_ACROSS_USERS`, declared at `AndroidManifest.xml:21`). No socket crosses profiles.                                                                                                                                                                                                                                                              |
| Certificate Transparency, ECH                               | Not affected                      | CtrlProxy makes no TLS connections of its own: no `HttpURLConnection`, `HttpClient`, `SSLContext`, `TrustManager` or `DownloadManager` in `src/main`, and the Ktor client is `testImplementation` only (`build.gradle.kts:148-151`). `MANAGE_CA_CERTIFICATES` (`AndroidManifest.xml`) serves the target apps' interception, not CtrlProxy traffic.                                                                                                                                                                                      |
| Large screens (orientation/resizability locks ignored)      | Not affected                      | The manifest has no `screenOrientation`, `resizeableActivity`, `minAspectRatio` or `maxAspectRatio`, and `MainActivity` never sets `requestedOrientation`. `SavedPrototypeActivity` (#12264) does not exist on main yet; re-check it when it lands.                                                                                                                                                                                                                                                                                     |
| IME `TextAttribute.Builder.setTextSuggestionSelected()`     | Follow-up, not required           | `CtrlProxyIme.kt` commits text with `commitText` and uses no `TextAttribute`. An optional accessibility improvement, API 37 only, so it must be `SDK_INT`-guarded.                                                                                                                                                                                                                                                                                                                                                                      |
| Memory limits (`MemoryLimiter:AnonSwap` exits)              | Device check                      | No `ApplicationExitInfo` use in `src/main`. Owed: read `ActivityManager.getHistoricalProcessExitReasons` for CtrlProxy after a long soak on the API 37 lane (#12273).                                                                                                                                                                                                                                                                                                                                                                   |

## Checklist for #12276 (the bump)

- [ ] Set `build-android-targetSdk = "37"` and keep `compileSdk` at 37.
- [ ] Run the `control-proxy` unit tests, `detektMain detektTest` and `scripts/prepush-android.sh`.
- [ ] On the API 37 emulator, confirm the WebSocket over `adb forward` works with no `ACCESS_LOCAL_NETWORK` grant.
- [ ] After a long soak, check `ApplicationExitInfo` for `MemoryLimiter:AnonSwap` exits.
- [ ] Verify `MainActivity` and the IME keyboard in multi-window and large-screen configurations.
- [ ] Re-grep the diff for `IntentSender`, `MODE_BACKGROUND_ACTIVITY_START_*`, `setAccessible` and `MessageQueue`, and re-check `SavedPrototypeActivity` once #12264 lands.
- [ ] Sequence after #12271 (non-SDK reflection) and #12272 (Robolectric SDK pins).

## Not done here

`targetSdk` and `compileSdk` are unchanged. The reflective call sites owned by
#12271 were not touched.
