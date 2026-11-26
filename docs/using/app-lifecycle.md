# App lifecycle

| Tool                         | What it does                                                               | Platforms                                                                                                                                                   | Needs                             |
| ---------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 🔄 <code>appLifecycle</code> | State-preserving background-process kill for saved-state restoration tests | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span></span> | <span class="tool-needs">—</span> |

`appLifecycle` acts on one running app without a force-quit, so the app keeps its saved state.

| Parameter | Meaning                                                      |
| --------- | ------------------------------------------------------------ |
| `appId`   | Android package name or iOS bundle id of a running app       |
| `action`  | `background`, `killBackgrounded` or `trimMemory`             |
| `level`   | Required for `trimMemory` and rejected for the other actions |

## Memory pressure with trimMemory

| Platform      | `level`                                                                                                  | What the app receives                          |
| ------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Android       | `RUNNING_MODERATE`, `RUNNING_LOW`, `RUNNING_CRITICAL`, `UI_HIDDEN`, `BACKGROUND`, `MODERATE`, `COMPLETE` | `onTrimMemory(level)`                          |
| iOS simulator | `memoryWarning`                                                                                          | `didReceiveMemoryWarning` and its notification |
| iOS device    | none                                                                                                     | Not supported (`supported: false`)             |

On Android, a foreground app takes only the `RUNNING_*` levels.

On an iOS simulator, `memoryWarning` is only sure to reach the app in front: a backgrounded app may
be suspended and miss it. Bring the app to the front with `launchApp` first, then call
`{ "appId": "com.example.app", "action": "trimMemory", "level": "memoryWarning" }`.
The result has `mechanism: "simulator-memory-warning-file"`. The simulator must be booted.
The app keeps running; read its logs with `getLogs` to see how it reacted.

| `errorCode`                 | Cause                                            | What to do                                         |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `app_not_running`           | The app is not running                           | Launch it with `launchApp`                         |
| `app_not_foreground`        | iOS: another app is in front                     | Bring the app to the front, then retry             |
| `trim_level_required`       | `trimMemory` without `level`                     | Pass a level from the table above                  |
| `trim_level_not_applicable` | A level for the other platform or action         | Use a level listed for this platform               |
| `trim_failed`               | The device refused the level or the write failed | Read `error`; on iOS, boot the simulator and retry |

If AutoMobile cannot read which app is in front, it still sends the iOS warning and says in
`message` that delivery was not verified.
