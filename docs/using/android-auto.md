# Android Auto and the Desktop Head Unit

Android Auto projects a phone app's car UI to a head unit. The Desktop Head Unit (DHU) is Google's
desktop stand-in for that head unit. `provisionDevice` can set up projection on a phone emulator and
start a headless DHU for you, and `startDevice` can start the DHU again for a phone that is already set
up. `tapAt` and `pressButton` can then act on the head unit. This page covers the setup, the manual
steps it automates, acting on the head unit, and what to expect.

For a full car Android build that AutoMobile drives directly, use an
[Android Automotive OS emulator](android-automotive.md) instead.

## Testing Car App Library templates without a head unit

To check which templates your app built, enable the AutoMobile SDK template route in a debug build and
read the `carAppTemplates` block from `observe` on a phone emulator. See
[Car App Library templates in `observe`](android-automotive.md#car-app-library-templates-in-observe).
It reports what the app built, not what the head unit rendered. For template unit tests, use
`androidx.car.app.testing` (`TestCarContext`, `ScreenController`).

## Setting up projection with `provisionDevice`

Pass `androidAuto` to `provisionDevice` for an Android phone AVD on a Google Play system image (such as
`google_apis_playstore`). After boot, AutoMobile installs Android Auto from your APKs, prepares it and
starts a headless DHU against the emulator. No Google account is needed.

```json
{
  "device": {
    "platform": "android",
    "name": "Pixel_9_Play_36",
    "spec": {
      "runtime": "system-images;android-36;google_apis_playstore;arm64-v8a",
      "deviceType": "pixel_9"
    }
  },
  "androidAuto": { "apkDirectory": "/path/to/android-auto-apks" }
}
```

| Parameter                            | Required | Description                                                                                                                                                                                                                                       |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `androidAuto.apkDirectory`           | yes      | Host directory with the Android Auto split APKs you supplied: `base.apk` plus its `split_*.apk` files for the emulator's ABI, language and density. AutoMobile never downloads them. They are installed only while the phone still runs the stub. |
| `androidAuto.dhuPath`                | no       | The `desktop-head-unit` binary. Defaults to `$ANDROID_HOME/extras/google/auto/desktop-head-unit`.                                                                                                                                                 |
| `androidAuto.dhuConfig`              | no       | Head unit config (`.ini`). Defaults to `config/default_720p.ini` beside the DHU binary.                                                                                                                                                           |
| `androidAuto.acceptAndroidAutoTerms` | no       | Tap **Continue** on **Welcome to Android Auto**, which accepts Android Auto's terms. Set it only when you have decided to accept them. Without it, a pending welcome screen is reported, not tapped.                                              |

`androidAuto` requires `boot: true` (the default). The emulator's language must be English, because
Android Auto's settings are driven by their visible labels.

### Result

The response gains an `androidAuto` block:

- `steps`: one entry per step, in order: `android-auto-apk`, `keyguard`, `stay-awake`,
  `notification-access`, `developer-mode`, `unknown-sources`, `head-unit-server`, `transport`,
  `desktop-head-unit` and `onboarding`. Each has a `status` of `applied`, `already-done` or `skipped`,
  and sometimes a `detail`. Running it again on a phone that is already set up reports `already-done`
  and reuses the running DHU.
- `desktopHeadUnit.running`: whether the DHU holds its connection.
- `desktopHeadUnit.configPath`: the head unit config the DHU started with.

An `onboarding` step with status `skipped` means the welcome screen is waiting. Tap **Continue** on the
phone, or provision again with `acceptAndroidAutoTerms: true`.

### Errors

| Error                                                                                                  | What to do                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsupported`: Android Auto projection is missing the APK directory, `base.apk`, the DHU or the config | Nothing was created or booted. The message names every missing path. Install the DHU with `sdkmanager "extras;google;auto"`, or pass `dhuPath`.                                                                              |
| adb still reports the emulator as not ready (`offline`) after 60 s                                     | Nothing on the phone changed. Wait until `adb -s <serial> get-state` prints `device` (run `adb kill-server` if it stays offline), then retry.                                                                                |
| The phone still runs the Android Auto stub and the APK signer check fails                              | Supply the APKs of an official Android Auto release. Android rejects an update signed by a different key.                                                                                                                    |
| A Desktop Head Unit is already projecting another emulator, or one is unhealthy but still running      | One emulator per host can project, because the DHU dials host port 5277. Release that emulator's session or call `killDevice` on it, which stops its DHU, or provision that emulator again, which restarts an unhealthy DHU. |
| The DHU did not exit after SIGTERM and SIGKILL                                                         | End the `desktop-head-unit` process yourself, then provision again. Until it exits, other emulators are refused.                                                                                                             |
| Host port 5277 is held by a redirect or process AutoMobile did not create                              | Remove it (`adb -s <serial> emu redir del tcp:5277`) or stop the process, then retry.                                                                                                                                        |
| The head unit server is not listening, or the DHU did not hold a connection                            | Check developer mode in Android Auto and start the head unit server from its overflow menu, then retry.                                                                                                                      |

A failure after boot fails the whole request: an emulator the request created is rolled back, and a DHU
that request started is stopped. A DHU an earlier provision started keeps running. `killDevice` on an emulator also stops its DHU.
When the session holding the phone ends (you release it, its heartbeat lapses, it idles out or is
cancelled), AutoMobile stops the DHU it started for that phone and removes its port 5277 redirect, so
another emulator can project. The phone keeps running.

## Starting the head unit with `startDevice`

For a phone emulator that `provisionDevice` already set up for Android Auto, pass `androidAuto.headUnit`
to `startDevice`. Once the phone is ready, AutoMobile checks the same setup steps, starts a headless DHU
against it and reports it. It never installs Android Auto here.

```json
{
  "platform": "android",
  "avdName": "Pixel_9_Play_36",
  "androidAuto": { "headUnit": {} }
}
```

| Parameter                            | Required | Description                                                                                                                              |
| ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `androidAuto.headUnit`               | yes      | Start the head unit. Pass `{}` for the SDK's DHU and `default_720p.ini`.                                                                 |
| `androidAuto.headUnit.dhuPath`       | no       | The `desktop-head-unit` binary. Defaults to `$ANDROID_HOME/extras/google/auto/desktop-head-unit`.                                        |
| `androidAuto.headUnit.dhuConfig`     | no       | Head unit config (`.ini`). Defaults to `config/default_720p.ini` beside the DHU binary.                                                  |
| `androidAuto.acceptAndroidAutoTerms` | no       | Tap **Continue** on **Welcome to Android Auto**, as for `provisionDevice`. Without it, a pending welcome screen is reported, not tapped. |

The response gains the same `androidAuto` block as `provisionDevice` (`steps` and `desktopHeadUnit`). If
a DHU is already projecting this phone, it is reused and reported as `already-done`, with the config
it started with; to use another config, call `killDevice` first.

If the head unit does not start, `startDevice` fails with a message that names the phone and its
session. The phone stays ready and held by that session: fix the cause and call `startDevice` again,
or release the device. The errors are the ones in the `provisionDevice` table above, plus:

| Error                                         | What to do                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| The phone still runs the Android Auto stub    | Run `provisionDevice` with `androidAuto.apkDirectory` first.                                                                        |
| The Android Auto head unit is missing a DHU   | The message names the missing path. Install the DHU with `sdkmanager "extras;google;auto"`, or pass `androidAuto.headUnit.dhuPath`. |
| Timed out starting the Android Auto head unit | Raise `timeoutMs` and call `startDevice` again. A DHU that connects after the timeout is stopped.                                   |

`killDevice` on the phone, or the end of the session holding it, stops its DHU. The first
`startDevice` after killing a projected phone is a cold boot (about 60 seconds). AutoMobile only ever
stops a DHU it started itself.

## Acting on the head unit

Pass `display: "headUnit"` to `tapAt` or `pressButton` to send input to the head unit instead of the
phone. It uses the DHU that `provisionDevice` or `startDevice` started for that phone; it never starts
or stops one.

```json
{ "x": 640, "y": 200, "display": "headUnit" }
```

| Tool          | Head unit input                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tapAt`       | `x` and `y` in head-unit pixels (1280x720 with `default_720p.ini`), sent as `tap <x> <y>`. Only a plain tap: `action`, `durationMs`, `coordinateSpace`, `image`, `pointer`, `layer` and `snapshotId` are refused.                                    |
| `pressButton` | `up`, `down`, `left`, `right`, `select` and `back` as `dpad` input; `home`, `playPause`, `next` and `previous` as `keycode` input; the `rotary_*` buttons as `dpad` rotate, nudge and click (`steps` repeats a rotation). Other buttons are refused. |

The result gains a `headUnit` block:

- `commands`: the console commands sent.
- `effect`: `screenChanged` and its `basis`. The change is read from the projected apps' template
  stacks (`carAppTemplates.projected[]`): each app's top screen class, template type and title, and
  stack depth. Without the AutoMobile template route in any projected app, `basis` is
  `no template data` and `screenChanged` is absent: the input was sent, but whether it changed the
  screen is unknown.
- `idle`: whether two template reads in a row agreed (`stable`) and how long the wait took
  (`waitedMs`). A screen that still looks the same is waited on for about a second, so a slow screen
  push is not reported as no change. The wait ends after about three seconds either way.
- `before` and `after`: the top screen of each projected session, read before and after the input.

`dpad back` pops the current screen on the head unit, so `pressButton back` needs no fallback.

| Error                                          | What to do                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No Desktop Head Unit is running for the device | Start one with `startDevice` and `androidAuto.headUnit`, or `provisionDevice` with `androidAuto`, then retry. |
| The Desktop Head Unit is not running           | The DHU exited. Call `startDevice` with `androidAuto.headUnit` again.                                         |
| A button or field has no head unit equivalent  | Use one of the inputs in the table above.                                                                     |

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
  To act on the head unit, use `tapAt` or `pressButton` with `display: "headUnit"` (see
  [Acting on the head unit](#acting-on-the-head-unit)).
- While projecting, the phone's foreground app is Android Auto, not your app. If your app enabled the
  AutoMobile template route, `observe` reads it from every app Android Auto has bound and returns
  `carAppTemplates.projected[]`, one entry per app (`packageName`, `sessions`, `error`), with
  `projectedBy` naming Android Auto. Android Auto does not report which bound app the head unit shows,
  so with several apps bound, check each entry's top screen rather than assuming the first is visible.
  The entries are what the app built, not what the head unit rendered.
- While the head unit hosts Car App Library templates, `observe` also returns an `androidAuto` block:
  `projecting: true`, `projectedBy`, `templateHosts` (Android Auto's bound template host services)
  and `apps[]`, each bound app whose template route answered, with its `userId` and bound `services`.
  No app is marked visible: an app stays bound while another app is on the head unit, so check
  `carAppTemplates.projected[]` and the head unit itself. Apps without the template route, the head
  unit's config and resolution, and a head unit screenshot are not reported. Without a projection,
  `observe` has no `androidAuto` block.
- The first `observe` on a fresh emulator installs AutoMobile's on-device service. If the DHU is
  connected through `adb forward`, a dropped adb connection at that point ends the projection; use the
  emulator redirect.
