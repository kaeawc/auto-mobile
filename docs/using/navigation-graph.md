# Navigation graph

AutoMobile can learn which screens an app has and how they connect, then take
the device straight to a screen by name. Three tools make up the workflow:

- `explore` drives the app on its own and records what it finds.
- `getNavigationGraph` shows the screens and transitions learned so far.
- `navigateTo` replays a learned path to a named screen.

## Availability

The three tools are listed without `--debug`, but they are off by default and
need two things:

1. The server runs with `--embedded-sdk`. Screen names come from navigation
   events sent by the AutoMobile SDK embedded in the app under test, so an app
   without the SDK produces an empty or sparse graph.
2. The tools are enabled for your session. Declare them when you acquire the
   device, or later with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)):

```json
{
  "name": "getAndroid",
  "arguments": {
    "enableTools": ["explore", "getNavigationGraph", "navigateTo"]
  }
}
```

If the tools are missing from `tools/list`, check that the server was started
with `--embedded-sdk` and that they appear in the `enabledTools` of the response.

### Platform support

| Platform | Support                                           |
| -------- | ------------------------------------------------- |
| Android  | Supported.                                        |
| iOS      | Supported through the embedded iOS SDK.           |
| tvOS     | Not supported. `navigateTo` rejects tvOS devices. |

## Building the graph

Launch the app first, then call `explore`:

```json
{
  "name": "explore",
  "arguments": { "packageName": "com.example.app", "maxInteractions": 40 }
}
```

`explore` taps and swipes through the app until it reaches a limit or runs out
of new things to try. On an Android TV it moves D-pad focus to an element and
selects it instead, recorded as `focusNavigate` with `select: true`. It never
explores the on-screen keyboard: when a field opens it over the app, `explore`
presses back once to hide it, and it skips the keyboard's keys if it stays open.
It also hides a keyboard its last interaction opened before it returns. An
element whose tap or select left the screen unchanged is not tried again on that
screen. It interacts with the device, so run it on a test device and test account.

| Parameter         | Default    | Meaning                                                                                                |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `packageName`     | none       | App to stay inside. It must be installed; if exploration leaves the app, it relaunches it.             |
| `maxInteractions` | `200`      | Stop after this many interactions.                                                                     |
| `timeoutMs`       | `300000`   | Stop after this many milliseconds.                                                                     |
| `strategy`        | `weighted` | `breadth-first`, `depth-first`, or `weighted` (scores elements by how likely they lead somewhere new). |
| `mode`            | `hybrid`   | `discover` favors new elements, `validate` re-walks known transitions, `hybrid` balances both.         |
| `resetToHome`     | `false`    | Periodically press the device home button, then relaunch `packageName`.                                |
| `resetInterval`   | `15`       | Interactions between resets when `resetToHome` is on.                                                  |
| `dryRun`          | `false`    | Plan without interacting. Returns `currentScreen`, `plannedInteractions`, and `estimatedCoverage`.     |

Start with a small `maxInteractions` and `dryRun: true` to see what `explore`
would tap before letting it run.

### Result

| Field                   | Meaning                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- |
| `interactionsPerformed` | Interactions actually made.                                                       |
| `screensDiscovered`     | Screens added to the graph by this run.                                           |
| `edgesAdded`            | Transitions added by this run.                                                    |
| `coverage`              | `totalScreens`, `exploredScreens`, and `percentage`.                              |
| `explorationPath`       | Screens visited, in order.                                                        |
| `stopReason`            | Why the run ended, such as the interaction or time limit.                         |
| `navigationGraph`       | The recorded graph of `packageName`, whose `appId` names that app.                |
| `graphTraversal`        | In `validate` mode: which known transitions were re-walked and whether each held. |

`explore` is not the only source of the graph. Taps, swipes, and other
interaction tools you call yourself also record transitions while the tools are
enabled, so walking a flow by hand teaches the graph that flow.

## Inspecting the graph

```json
{ "name": "getNavigationGraph", "arguments": { "appId": "com.example.app" } }
```

Without `appId`, the graph of the device's current foreground app is returned.
Pass `appId` whenever you know it, so a system screen in the foreground does not
redirect the read. This tool only reads and never touches the device.

| Field                             | Meaning                                                                                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestedAppId`, `observedAppId` | The app you asked for and the app seen in the foreground.                                                                                                                                                      |
| `currentScreen`                   | The screen the graph believes the app is on, or `null`.                                                                                                                                                        |
| `nodeCount`, `edgeCount`          | Screens and transitions in the graph.                                                                                                                                                                          |
| `knownEdges`, `unknownEdges`      | Transitions with and without a recorded action. A transition without one is replayed only as Back, when its destination was recorded at a shallower back-stack depth than its source; otherwise it is skipped. |
| `screens`                         | Each screen's `name`, `visitCount`, and `lastVisited`.                                                                                                                                                         |
| `transitions`                     | Each transition's `from`, `to`, `type` (`tool`, `back`, `unknown`), and the `tool` and `args` that caused it.                                                                                                  |

Use the names in `screens` as `navigateTo` targets.

`getNavigationGraph` can also compare the graph with a prototype spec
(`prototypeSpec` or `prototypeSpecPath`, optionally with `screenMapping` or
`screenMappingPath`). The result adds `prototypeDiff`, listing matched screens,
prototype screens and transitions the app lacks, and app screens the prototype
lacks.

## Labeling builds with their git revision

The graph records which app build reached each screen. By default a build is
shown as `v<versionCode> (<hash prefix>)`. To show `branch@shortsha` instead
(for example `main@3f2a9c1`), declare the git branch and full commit sha the app
was built from. Builds that declare nothing keep the default label, and the
declaration never changes which builds are told apart.

On Android, add both values as manifest meta-data, typically filled from your
Gradle build:

```xml
<application>
  <meta-data android:name="dev.jasonpearson.automobile.build.gitBranch"
             android:value="${gitBranch}" />
  <meta-data android:name="dev.jasonpearson.automobile.build.gitSha"
             android:value="${gitSha}" />
</application>
```

```kotlin
android {
  defaultConfig {
    manifestPlaceholders["gitBranch"] = providers.exec {
      commandLine("git", "rev-parse", "--abbrev-ref", "HEAD")
    }.standardOutput.asText.get().trim()
    manifestPlaceholders["gitSha"] = providers.exec {
      commandLine("git", "rev-parse", "HEAD")
    }.standardOutput.asText.get().trim()
  }
}
```

On iOS, add the same two keys as strings to the app's `Info.plist`, for example
from a build phase that runs `git rev-parse`. iOS builds are labeled on
simulators only.

Both values are required. The branch must be 1–255 characters; the sha must be
7–64 hexadecimal characters, and a full 40-character sha is recommended (Android
reads an all-digit short sha as a number and ignores it). An invalid pair is
ignored. The label takes effect the next time AutoMobile observes the app after
it is installed; rebuilding the same version and content from a later commit
updates the label.

## Going to a screen

```json
{ "name": "navigateTo", "arguments": { "targetScreen": "Settings" } }
```

`navigateTo` finds the shortest known path from the current screen and replays
the recorded action for each step, checking that each step lands on the
expected screen. Steps `explore` recorded on an Android TV replay as the same D-pad
focus moves and select.

| Field           | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `success`       | `true` only when the device ended on `targetScreen`.                |
| `currentScreen` | Where the device is now.                                            |
| `stepsExecuted` | Steps replayed.                                                     |
| `path`          | Steps taken on a completed replay.                                  |
| `partialPath`   | Steps taken before a replay stopped early.                          |
| `error`         | Why navigation failed. Failed calls are also marked as tool errors. |

If the device is already on the target, the call succeeds with
`"Already on target screen"` and no steps.

## Limits

- A path is only as good as its recorded actions. Changed UI, dynamic content,
  feature flags, or a different login state can break a step that worked before.
- Transitions are one-way. Learning `Home` → `Settings` does not teach
  `Settings` → `Home` unless that direction was also recorded.
- Cold-starting or clearing an app's data makes the graph forget which screen
  that app was on, so the next action does not create a false transition.
- The graph is saved per app and kept across server restarts. Stale transitions
  stay until a later run corrects them.

## Errors and what to do

| Error                                                                               | What to do                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Package not installed: <app>`                                                      | Install the app, then call `explore` again.                                                                                                                                                               |
| `Could not confirm that <app> is installed`                                         | The installed-app listing was incomplete. Retry.                                                                                                                                                          |
| `Cannot determine current screen. No navigation events recorded yet.`               | Interact with the app once (or run `explore`), and confirm the app embeds the SDK and the server runs with `--embedded-sdk`.                                                                              |
| `No known path from "A" to "B". Known screens: ...`                                 | Check the target name against the list. If it is right, walk from A to B once by hand or run `explore` from A to record a path. A note about ignored transitions means some edges had no recorded action. |
| `Failed to execute step N: ...` or `Navigation did not reach "B"; currently on "C"` | A recorded step no longer works. Call `observe`, recover to a known screen, and run `explore` with `mode: "validate"` to refresh the graph.                                                               |
| `Not trying a fallback edge: ... no longer confirmed on "A"`                        | A dialog or other app is in the way. Dismiss it, then call `navigateTo` again.                                                                                                                            |
| `Navigation timeout (30 seconds)`                                                   | The replay took too long. Check `partialPath` and `currentScreen`, then retry from there.                                                                                                                 |
| `stopReason` starts with `Left target app`                                          | Exploration kept leaving the app (for example, through an external link) and could not get back. Check the app opens with `launchApp`, then run again with a lower `maxInteractions`.                     |
