# Apple TV app tools

These tools act on apps in an Apple TV simulator. Name the platform on every call: `platform: "tvos"`,
or the `sessionUuid` of an Apple TV session. For setup, observing and focus navigation, see
[Apple TV simulators](apple-tv.md).

## Explore an app

`explore` needs the server to run with `--embedded-sdk`, like the other
[navigation graph](navigation-graph.md) tools; the Apple TV app itself does not need the SDK.
Without the flag, `explore` is missing from `tools/list`. A call fails with
`Unknown tool: explore. embedded SDK mode is disabled; ...`, followed by these steps:

1. Add `--embedded-sdk` to the AutoMobile MCP server command and reconnect. AutoMobile restarts a
   running daemon that started without it.
2. Enable `explore` for the session with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)).

Launch the app with `launchApp`, then call `explore` with `platform: "tvos"`. Explore selects every
item it can focus on a screen and observes after every remote press. It records each screen a
`select` opens in the navigation graph, and presses `menu` to go back.

- It accepts `maxInteractions` (default 200), `timeoutMs` (default 300000) and `packageName`.
  `strategy`, `mode`, `resetToHome`, `resetInterval` and `dryRun` are refused.
- With `packageName`, that app must already be in the foreground.
- It stops at either limit, when the first screen has nothing left to select, or when the app
  cannot be brought back after leaving it (`stopReason`).
- A recorded transition replays as `tapOn` with the item's identifier, or its text when it has
  no identifier; going back replays as `pressButton menu`. Explore still records a screen opened
  from an item with neither, but `navigateTo` cannot replay that transition and says so.

## Run a plan

`executePlan` with `platform: "tvos"` runs plan steps that use Apple TV tools: `pressButton`,
`tapOn`, `sendKeys`, `observe` and the app tools. A step whose tool is not in the
[supported tools](apple-tv.md#supported-tools) fails the plan with the same error the tool returns
on its own. The runner's hierarchy checks step `expectations`, as with `observe` `waitFor`.

- A plan may declare `platform: tvos`, and a device in its `devices` list may use `platform: tvos`.
- AutoMobile records Apple TV plans on video like iOS plans. A recording that cannot start adds a
  `videoWarnings` entry, and the plan still runs.

## Open a deep link

`openLink` opens a URL on the Apple TV, such as `myapp://episode/42`, and the app that declares the
scheme shows that screen. Call `observe` afterwards to see where it landed.

- `getDeepLinks` with the app's bundle ID lists the custom URL schemes the installed app declares.
- The call fails when no installed app handles the URL. Apple TV has no web browser, so an
  `http` or `https` URL opens only if an app claims it.
- `waitFor`, `settled`, `acceptOpenAlert` and `chooserAppPackage` are refused.

## Notifications and permissions

`postNotification` sends a simulated remote push to the app named by `appId`, with the same
payload options as on an iOS Simulator. A successful result means the simulator accepted the push.
The app and tvOS decide whether to show a banner, so observe to check.

`setAppPermissions` takes `action` (`grant`, `revoke` or `reset`) and `permissions`, such as
`photos`, or `all` with `reset`. A permission the tvOS simulator does not have fails that entry with
the simulator's error; the others still apply.

- The fields `notificationsEnabled`, `notificationPolicyAccess` and `scheduleExactAlarm` are refused.
- The result reports a change as applied without reading it back, and `getAppPermissions` is not
  available.
