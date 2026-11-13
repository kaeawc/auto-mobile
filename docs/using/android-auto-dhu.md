# Desktop Head Unit by hand

This page covers setting up Android Auto projection yourself. It also covers the Desktop Head Unit
(DHU) console, capture and configs. `provisionDevice` automates the setup; see
[Android Auto and the Desktop Head Unit](android-auto.md).

## Setting up projection

1. Use a phone emulator with a Google Play system image, such as `google_apis_playstore`. You need no
   Google account, because you sideload Android Auto (step 2) rather than update it from Play.
   AutoMobile takes no Google credentials and does not sign in for you. Google does not allow scripted
   sign-in, and new emulators get "Verify it's you" and CAPTCHA challenges. For an app only available
   from Play, use an AVD snapshot that you signed in to yourself.
2. Replace the Android Auto stub. The image ships Android Auto as a stub
   (`versionName=1.2.551000-stub`) with no head-unit server. On the API 36 emulator image, Google Play
   reports Android Auto as not compatible, so Play cannot update it. Install a current
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
