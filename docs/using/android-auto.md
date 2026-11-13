# Android Auto and the Desktop Head Unit

Android Auto projects a phone app's car UI to a head unit. The Desktop Head Unit (DHU) is Google's
desktop stand-in for that head unit.

- `provisionDevice` can set up projection on a phone emulator and start a headless DHU for you.
- `startDevice` can start the DHU again for a phone that is already set up.
- `tapAt` and `pressButton` can then act on the head unit.

To do the setup yourself, or for the DHU console, capture and configs, see
[Desktop Head Unit by hand](android-auto-dhu.md).

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

| Error                                                                                                                | What to do                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unsupported`: Android Auto projection is missing the APK directory, `base.apk`, the DHU or the config               | Nothing was created or booted. The message names every missing path. Install the DHU with `sdkmanager "extras;google;auto"`, or pass `dhuPath`.                                                                                      |
| adb still reports the emulator as not ready (`offline`) after 60 s, or when the provision deadline left no more time | Error code `device_offline`; nothing on the phone changed. Wait until `adb -s <serial> get-state` prints `device` (run `adb kill-server` if it stays offline), then retry, with a larger `timeoutMs` if the deadline ended the wait. |
| The phone still runs the Android Auto stub and the APK signer check fails                                            | Supply the APKs of an official Android Auto release. Android rejects an update signed by a different key.                                                                                                                            |
| A Desktop Head Unit is already projecting another emulator, or one is unhealthy but still running                    | One emulator per host can project, because the DHU dials host port 5277. Release that emulator's session or call `killDevice` on it, which stops its DHU, or provision that emulator again, which restarts an unhealthy DHU.         |
| The DHU did not exit after SIGTERM and SIGKILL                                                                       | End the `desktop-head-unit` process yourself, then provision again. Until it exits, other emulators are refused.                                                                                                                     |
| Host port 5277 is held by a redirect or process AutoMobile did not create                                            | Remove it (`adb -s <serial> emu redir del tcp:5277`) or stop the process, then retry.                                                                                                                                                |
| The head unit server is not listening, or the DHU did not hold a connection                                          | Check developer mode in Android Auto and start the head unit server from its overflow menu, then retry.                                                                                                                              |

A failure after boot fails the whole request. AutoMobile rolls back an emulator the request created
and stops a DHU that request started. A DHU an earlier provision started keeps running. `killDevice`
on an emulator also stops its DHU.

The session holding the phone can end (you release it, its heartbeat lapses, it idles out or is
cancelled) or move to another device. AutoMobile then stops the DHU it started for that phone and
removes its port 5277 redirect, so another emulator can project. A provision of that phone still
running finishes first. The phone keeps running.

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
- `effect`: `screenChanged` and its `basis` (see below).
- `idle`: whether two reads in a row agreed (`stable`), what they were (`basis`: `carAppTemplates`,
  `screenshot` or `none`) and how long the wait took (`waitedMs`). AutoMobile waits about a second on
  a screen that still looks the same, so it does not report a slow screen push as no change. The wait
  ends after about three seconds either way.
- `before` and `after`: the top screen of each projected session, read before and after the input.
  Absent with the screenshot fallback.

AutoMobile reads `effect` from the first source available:

| Source                                                           | `basis`                                                  | What it tells                                                                                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projected apps' template stacks (`carAppTemplates.projected[]`)  | `carAppTemplates changed` or `carAppTemplates unchanged` | Each app's top screen class, stack depth and top template content; a tab switch or changed item on the same screen counts. A list scroll counts only when the template reports different items |
| DHU screenshot, when no projected app has the template route     | `screenshot changed` or `screenshot unchanged`           | Changed pixels from unchanged ones, but not which screen is shown                                                                                                                              |
| Nothing (a `--headless` DHU without video focus returns at once) | `no template data`; `screenChanged` is absent            | The input went out, but whether it changed the screen is unknown                                                                                                                               |

Before sending input, the action checks that the head unit is still the one the previous head-unit
action left. That means the same DHU process, the same config, and the same projected apps and car
sessions. If any of them changed, the action sends nothing and fails. The check counts only apps with
the template route, so it misses a switch to an app without it.

`dpad back` pops the current screen on the head unit, so `pressButton back` needs no fallback.

| Error                                          | What to do                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No Desktop Head Unit is running for the device | Start one with `startDevice` and `androidAuto.headUnit`, or `provisionDevice` with `androidAuto`, then retry. |
| The Desktop Head Unit is not running           | The DHU exited. Call `startDevice` with `androidAuto.headUnit` again.                                         |
| A button or field has no head unit equivalent  | Use one of the inputs in the table above.                                                                     |
| Head unit input not sent                       | The DHU restarted, its config changed, or the projected apps changed. Observe again, then retry the input.    |

## Making your app appear in Android Auto

Android Auto on a phone lists a Car App Library app only when its manifest has
`com.google.android.gms.car.application` meta-data pointing at the app's `automotive_app_desc` XML. The
`com.android.automotive` key alone is read only by Android Automotive OS. Declare both if the app targets
both. Apps installed with adb appear only while **Unknown sources** is on. Apps must target SDK 24 or
higher to install on current emulator images, which excludes the Media Browser Simulator shipped in
`extras/google/simulators`.

## What to expect from AutoMobile

Android Auto renders the projected UI on virtual displays on the phone. `observe` lists them under
`otherDisplays` (for example `TemplateCarFragment`, `Dashboard` and `GhFacetBar`). It may report the
projection display as the active one, with a warning that it has no accessible content.

The projected UI is not in the accessibility tree; `observe`, `tapOn` and other tools act only on the
phone screen. To act on the head unit, use `tapAt` or `pressButton` with `display: "headUnit"` (see
[Acting on the head unit](#acting-on-the-head-unit)).

The first `observe` on a fresh emulator installs AutoMobile's on-device service. If the DHU connects
through `adb forward`, a dropped adb connection at that point ends the projection; use the emulator
redirect.

### Projected templates in `observe`

While projecting, the phone's foreground app is Android Auto, not your app. If your app enabled the
AutoMobile template route, `observe` reads it from every app Android Auto has bound. It returns
`carAppTemplates.projected[]` and `projectedBy` naming Android Auto.

| `projected[]` field | Content                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `packageName`       | The bound app                                                                               |
| `sessions`          | What the app built, not what the head unit rendered                                         |
| `error`             | `template_read_failed`, with no sessions, when an app that answered before failed this time |

Android Auto does not report which bound app the head unit shows. With several apps bound, check each
entry's top screen rather than assuming the first is visible.

While the head unit hosts Car App Library templates, `observe` also returns an `androidAuto` block.
Without a projection, `observe` has no `androidAuto` block.

| `androidAuto` field | Content                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `projecting`        | `true`                                                                     |
| `projectedBy`       | Android Auto                                                               |
| `templateHosts`     | Android Auto's bound template host services                                |
| `apps[]`            | Each bound app whose template route answered, with `userId` and `services` |

No app is marked visible, because an app stays bound while another app is on the head unit. Check
`carAppTemplates.projected[]` and the head unit itself. The block leaves out apps without the
template route, and has no head unit screenshot.

### The head unit in `listDevices`

While AutoMobile runs a healthy DHU for a phone, `listDevices` reports it on the phone's entry as
`headUnit`. It is not one of the phone's `displays.panels`.

| `headUnit` field | Content                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `display`        | `"headUnit"`, the value `tapAt` and `pressButton` take                                                    |
| `role`           | `projected`                                                                                               |
| `projectedBy`    | `androidAuto`                                                                                             |
| `console`        | The DHU process; it changes when the DHU restarts                                                         |
| `configPath`     | The head unit config                                                                                      |
| `sizePx`         | Head-unit pixels from the config's `resolution`; 800x480 when it sets none, absent when it cannot be read |
