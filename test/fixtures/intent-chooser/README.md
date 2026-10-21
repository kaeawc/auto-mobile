# Intent-chooser fixtures for #11838 (batch 20261016c, 2026-10-16)

Device: AVD amslot-093002ab-0-g1-f46be778 (android-36 google_apis arm64), emulator-5556, private daemon on port 3189. No apps installed.

Why not a VIEW http link: the only http(s) browser on the image is Chrome (a second handler only exists for verified app links: Maps, YouTube), so
`am start -a android.intent.action.VIEW -d http://example.com` opens Chrome directly and maps/youtube links open their verified app. No VIEW chooser can be shown without installing a second browser.
The resolver below was produced by sharing the http link as text instead.

Steps:
1. `adb -s emulator-5556 shell input keyevent 3` (home)
2. `adb -s emulator-5556 shell "am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT 'http://example.com'"`
   -> focus `android/com.android.internal.app.ResolverActivity` (dumpsys window mCurrentFocus), with `android:id/button_always` ("Always"), `android:id/button_once` ("Just once"), `android:id/resolver_list` and rows Chrome, Gmail, Drive, Chat, Bluetooth, Quick Share, Copy to clipboard (text1 labels).
3. Raw device hierarchy: `adb -s emulator-5556 shell uiautomator dump /sdcard/c.xml; adb exec-out cat /sdcard/c.xml` -> `resolver-uiautomator-raw.xml`.
4. Through the private daemon (proxy-session call, deviceId emulator-5556):
   - `observe {"deviceId":"emulator-5556","raw":true}` -> `observe-raw.json` (envelope; the raw payload spilled to a 120 KB artifact, copied as `observe-raw-artifact.json`).
   - `observe {"deviceId":"emulator-5556","project":"full"}` -> `observe-full.json` (parsed full hierarchy).
   - `observe {"deviceId":"emulator-5556"}` -> `observe-skeleton.json` (parsed skeleton: actionable elements).
   (`*.out` files are the harness stdout for each call.)
5. Dismissed with Back, then Home. No default was set ("Always" was never tapped).

Not captured: a custom (non-system) app row (no non-system app on the image handles SEND text/plain), and the framework ChooserActivity/sharesheet variant (needs a CHOOSER intent with an Intent parcelable, which `am start` cannot build).

## Files kept in the repository

`resolver-uiautomator-raw.xml`, `observe-raw-artifact.json` (the `ObserveResult` the daemon spilled
for `raw: true`; its `viewHierarchy` is what `DeepLinkManager.handleIntentChooser` receives),
`observe-full.json` and `observe-skeleton.json`. The `*.out` harness stdout files and the
`observe-raw.json` call envelope (which names local paths) are not kept. The recents list in the
capture includes the AutoMobile playground app.
