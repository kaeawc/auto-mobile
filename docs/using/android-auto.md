# Android Auto and the Desktop Head Unit

Android Auto projects a phone app's car UI to a head unit. The Desktop Head Unit (DHU) is Google's
desktop stand-in for that head unit. AutoMobile has no tool that drives the DHU or reads the projected
car screen; this page covers what you can set up yourself and what to expect.

For a full car Android build that AutoMobile drives directly, use an
[Android Automotive OS emulator](android-automotive.md) instead.

## Testing Car App Library templates without a head unit

To check which templates your app built, enable the AutoMobile SDK template route in a debug build and
read the `carAppTemplates` block from `observe` on a phone emulator. See
[Car App Library templates in `observe`](android-automotive.md#car-app-library-templates-in-observe).
It reports what the app built, not what the head unit rendered. For template unit tests, use
`androidx.car.app.testing` (`TestCarContext`, `ScreenController`).

## Setting up projection by hand

1. Use a phone emulator with a Google Play system image, such as `google_apis_playstore`. No Google
   account is needed: projection works on an emulator with no accounts, because Android Auto is
   sideloaded (step 2) rather than updated from Play. AutoMobile takes no Google credentials and does
   not sign in for you: Google does not allow scripted sign-in, and new emulators get "Verify it's you"
   and CAPTCHA challenges that automation must not get past. For an app only available from Play, use
   an AVD snapshot that you signed in to yourself.
2. Replace the Android Auto stub. The image ships Android Auto as a stub
   (`versionName=1.2.551000-stub`) with no head-unit server, and on the API 36 emulator image Google
   Play reports Android Auto as not compatible, so it cannot be updated from Play. Install a current
   Android Auto release yourself from a source you trust, for example a split-APK bundle with
   `adb install-multiple base.apk split_config.arm64_v8a.apk split_config.en.apk split_config.xxhdpi.apk`.
   Android rejects the update unless it is signed with the same Google key as the stub.
3. Open Android Auto's settings
   (`adb shell am start -a com.android.settings.action.IA_SETTINGS -p com.google.android.projection.gearhead`),
   tap **Version** ten times and accept the prompt to turn on developer mode.
4. In the overflow menu, open **Developer settings** and turn on **Unknown sources** so Android Auto
   lists apps you installed yourself. Then choose **Start head unit server** from the overflow menu.
5. Expose the server and start the DHU from `$ANDROID_HOME/extras/google/auto`:

   ```bash
   adb emu redir add tcp:5277:5277
   ./desktop-head-unit --config config/default_720p.ini
   ```

   `adb forward tcp:5277 tcp:5277` also works, but the DHU's video stream then shares the adb
   connection with AutoMobile, and when that connection drops the forward is removed and the DHU exits.
   The emulator redirect keeps the DHU off adb.

6. The first connection shows **Welcome to Android Auto** on the phone. Tap **Continue**, then give
   Android Auto notification access when the head unit asks for it (or grant it with
   `adb shell cmd notification allow_listener com.google.android.projection.gearhead/com.google.android.gearhead.notifications.SharedNotificationListenerManager\$ListenerService`).
   The launcher then appears on the head unit.

If the head-unit server is not running, the DHU still prints `connected.` and then exits with:

```
> [E]: Failed to read from transport - disconnect. Exiting...
```

Start the head-unit server (step 4), then start the DHU again. If the DHU connects but the TLS handshake
never completes, stop and start the head-unit server.

## Making your app appear in Android Auto

Android Auto on a phone lists a Car App Library app only when its manifest has
`com.google.android.gms.car.application` meta-data pointing at the app's `automotive_app_desc` XML. The
`com.android.automotive` key alone is read only by Android Automotive OS. Declare both if the app targets
both. Apps installed with adb appear only while **Unknown sources** is on. Apps must target SDK 24 or
higher to install on current emulator images, which excludes the Media Browser Simulator shipped in
`extras/google/simulators`.

## DHU console commands

The DHU reads commands on its console (stdin). `help` in DHU 2.1 lists:

| Group                | Commands                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller           | `dpad up\|down\|left\|right\|ur\|dl\|ul\|dr\|click\|back\|soft left\|soft right\|0-9\|*\|#\|+\|rotate left\|rotate right\|flick left\|flick right` |
| Touch                | `tap <x> <y>` in head-unit pixels                                                                                                                  |
| Keycode              | `keycode home\|back\|call\|endcall\|search\|media_play_pause\|media_next\|media_previous\|media_play\|media_pause\|media\|navigation\|tel`         |
| Day/Night Sensor     | `day`, `night`, `daynight`, `nightday`                                                                                                             |
| Driving Restrictions | `restrict none`, `restrict all`                                                                                                                    |
| Focus                | `focus audio`, `focus nav`, `focus video`, `focus video toggle`                                                                                    |
| Microphone           | `mic begin`, `mic play`, `mic repeat`, `mic reject`                                                                                                |
| Sensors              | `fuel`, `range`, `lowfuel`, `accel`, `compass`, `gyro`, `location`, `odometer`, `speed`, `tollcard insert`, `tollcard remove`                      |
| System               | `help`, `quit`, `exit`, `licenses`, `sleep <seconds>`, `screenshot <file.png>`                                                                     |

`tap` coordinates use the head unit's resolution (for example 1280x720 with `default_720p.ini`).
`dpad back` pops the current screen; `dpad` input shows a focus highlight on the focused row.

## Capturing the head unit

`screenshot <file.png>` saves a PNG at the config's full resolution: 1280x720 with
`default_720p.ini`, 1920x1080 with `default_1080p.ini`. It works with or without a window.

`--headless` projects without a window. It starts without video focus, so `screenshot` fails with
`Don't have video focus - nothing to screenshot.` until you send `focus video`; the first capture after
that can be black until the next frame arrives.

## Head unit configs

Pass a config with `-c`/`--config`. The DHU ships these in `config/`: `all_720p`, `auxillary_nav`,
`cluster`, `default`, `default_1080p`, `default_6in`, `default_720p`, `default_sensors`, `default_wide`,
`hybrid`, `loaded_720p`, `rotary` and `touchpad` (each a `.ini` file). Without a config the DHU uses
default values, the same as `default.ini`: 800x480 at 160 dpi and 30 fps.

## What to expect from AutoMobile

- Android Auto renders the projected UI on virtual displays on the phone. `observe` lists them under
  `otherDisplays` (for example `TemplateCarFragment`, `Dashboard` and `GhFacetBar`) and may report the
  projection display as the active one, with a warning that it has no accessible content. The projected
  UI is not in the accessibility tree; `observe`, `tapOn` and other tools act only on the phone screen.
- While projecting, the phone's foreground app is Android Auto, not your app. If your app enabled the
  AutoMobile template route, `observe` reads it from every app Android Auto has bound and returns
  `carAppTemplates.projected[]`, one entry per app (`packageName`, `sessions`, `error`), with
  `projectedBy` naming Android Auto. Android Auto does not report which bound app the head unit shows,
  so with several apps bound, check each entry's top screen rather than assuming the first is visible.
  The entries are what the app built, not what the head unit rendered.
- The first `observe` on a fresh emulator installs AutoMobile's on-device service. If the DHU is
  connected through `adb forward`, a dropped adb connection at that point ends the projection; use the
  emulator redirect.
