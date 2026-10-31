# Launcher "Add to home screen" pin dialog capture for #12266 (manual test 20261018i, 2026-10-18)

Device: emulator-5554, Android 17 (API 37) google_apis emulator. Launcher: Pixel Launcher
(`com.google.android.apps.nexuslauncher`), pin dialog hosted by the Launcher3 widget picker
(`com.android.launcher3.widgetpicker`, ids `widget_details`, `pin_widgets_catalog`, `widget_preview`).

Produced by saving a prototype pin (`PinFixture`, CtrlProxy) so the launcher showed its pin dialog,
then, with the dialog on screen:

- `adb exec-out uiautomator dump` -> `pin-dialog-api37-uiautomator.xml`
- AutoMobile `observe {"project":"full"}` -> `pin-dialog-api37-observe-full.json` (MCP envelope; the
  parsed observation is the JSON in `content[0].text`, its `viewHierarchy` is what the
  pin-confirmation capture returns).

Dialog texts: "Add to home screen", "Cancel", "PinFixture", "CtrlProxy", "1 x 1". Notably the two
buttons are Compose text nodes with `clickable=false` and no `click` action (the click handler is
on an unreported ancestor), so a matcher must not require the button node itself to be clickable.

The screenshot (`pin-dialog-api37.png`) is binary and is not kept in the repository.

Additional captures copied verbatim from the saved #12261 comments (comment order in scratch/issue.md; comment IDs were not supplied):

- `pin-dialog-api37-issue12261-uiautomator.xml`: #12261 comment 4, API 37, Pixel Launcher; differs from the earlier API 37 capture above.
- `pin-dialog-api33-uiautomator.xml`: #12261 comment 5, API 33, Pixel Launcher.
- `pin-dialog-api30-launcher3-uiautomator.xml`: #12261 comment 5, API 30, AOSP Launcher3.
