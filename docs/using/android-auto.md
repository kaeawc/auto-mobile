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

1. Use a phone emulator with a Google Play system image, such as `google_apis_playstore`.
2. Sign in to Google Play on the emulator yourself. The image ships Android Auto as a stub
   (`versionName=1.2.551000-stub`) with no head-unit server. Opening its settings goes to the Play
   sign-in screen until a person signs in, or until a trusted Android Auto APK is sideloaded.
3. After Android Auto updates, open its Developer settings and choose **Start head unit server**.
4. Forward the port and start the DHU from `$ANDROID_HOME/extras/google/auto`:

   ```bash
   adb forward tcp:5277 tcp:5277
   ./desktop-head-unit --config config/default_720p.ini
   ```

   Add `--headless` to run without a window.

If the head-unit server is not running, the DHU still prints `connected.` (the adb forward accepted the
connection) and then exits with:

```
> [E]: Failed to read from transport - disconnect. Exiting...
```

Finish steps 2 and 3, then start the DHU again.

## DHU console commands

The DHU reads commands on its console. DHU 2.1 includes:

| Command                                                                                                                                              | Purpose                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `dpad <up\|down\|left\|right\|click\|back\|soft left\|soft right\|flick left\|flick right\|rotate left\|rotate right\|ul\|ur\|dl\|dr\|0-9\|#\|*\|+>` | D-pad and keypad input                    |
| `rotary`                                                                                                                                             | Rotary controller input                   |
| `day`, `night`                                                                                                                                       | Force day or night mode                   |
| `mic begin\|reject\|repeat`                                                                                                                          | Microphone requests                       |
| `focus <audio\|nav\|video\|video toggle>`                                                                                                            | Audio, navigation or video focus          |
| `screenshot <filename.png>`                                                                                                                          | Save a screenshot of the head unit as PNG |
| `sleep <seconds>`                                                                                                                                    | Pause, for scripted command sequences     |
| `quit`                                                                                                                                               | Quit the DHU                              |

There is no command to tap at a coordinate. Touch comes from the mouse pointer in the DHU window, so a
script has to navigate with `dpad` or `rotary`.

## Head unit configs

Pass a config with `-c`/`--config`. The DHU ships these in `config/`: `all_720p`, `auxillary_nav`,
`cluster`, `default`, `default_1080p`, `default_6in`, `default_720p`, `default_sensors`, `default_wide`,
`hybrid`, `loaded_720p`, `rotary` and `touchpad` (each a `.ini` file). Without a config the DHU uses
default values, the same as `default.ini`: 800x480 at 160 dpi and 30 fps.

## What to expect from AutoMobile

- The car UI is drawn by the DHU on your computer, not on the phone, so `observe`, `tapOn` and other
  tools see only the phone screen.
- Whether the DHU's `screenshot` and `help` behave as described above during a live projection, and what
  `observe` returns on the phone while projecting, has not been checked yet.
