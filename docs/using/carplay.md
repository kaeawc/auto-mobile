# CarPlay on the iOS Simulator

An iPhone simulator can show a CarPlay screen next to the phone screen, with no Simulator.app
window. Ask for it with `startDevice`.

## Requirements

- An iPhone simulator on an iOS 26.x runtime from Xcode 26.x. Apple does not support CarPlay on the
  iOS 27 Simulator.
- Two local executables, named by environment variables on the daemon:
  - `AUTOMOBILE_CARPLAY_POWER_HELPER_PATH`: the carplay-power-helper, which turns on the CarPlay
    screen.
  - `AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH`: the CarPlay projection probe, which confirms the
    screen is the car display. Use an absolute path.

## Requesting the CarPlay screen with `startDevice`

Pass `carPlay: {}` to `startDevice` for an iPhone simulator:

```json
{
  "platform": "ios",
  "deviceId": "<simulator UDID>",
  "carPlay": {}
}
```

Once the simulator is ready and bound to your session, AutoMobile turns on its CarPlay screen and
checks that the simulator now reports it as the car display. The response gains a `carPlay` block:

| Field       | Description                                       |
| ----------- | ------------------------------------------------- |
| `display`   | The car display's identity, for example `Car[2]`. |
| `displayId` | The simulator screen id of the car display.       |

The simulator forgets the CarPlay screen whenever it boots, including after `killDevice` or when a
released device is reset. Pass `carPlay: {}` on each `startDevice` call that needs it; asking again
on a simulator that already shows CarPlay is harmless.

## Errors

| Error                                                                                                            | What to do                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `carPlay needs an iOS iPhone simulator`                                                                          | Use `platform: "ios"`. Android phones use [Android Auto](android-auto.md).                                                                                                                                                      |
| `[unsupported-runtime] Headless CarPlay needs an iOS 26.x runtime ...`                                           | The simulator runs iOS 27 or later. Create an iOS 26.x simulator with Xcode 26.x and request it there.                                                                                                                          |
| A message asking you to set `AUTOMOBILE_CARPLAY_POWER_HELPER_PATH` or `AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH` | Build the executable, set the variable for the daemon, restart the daemon and retry.                                                                                                                                            |
| `... is ready and bound to session ..., but its CarPlay display is not available`                                | The simulator stays ready and held by your session. The rest of the message says what failed. Fix it and call `startDevice` again, or release the device. If the screen is not the car display, reboot the simulator and retry. |
