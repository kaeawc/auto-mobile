---
description: Build, inspect, and replay an app's navigation graph with explore, getNavigationGraph, and navigateTo
allowed-tools: mcp__auto-mobile__explore, mcp__auto-mobile__getNavigationGraph, mcp__auto-mobile__navigateTo, mcp__auto-mobile__observe, mcp__auto-mobile__launchApp, mcp__auto-mobile__setToolEnabled
---

Learn which screens an app has and how they connect, then jump straight to a screen by name.

## Availability

`explore`, `navigateTo`, and `getNavigationGraph` are listed in `tools/list` without `--debug`.
They stay opt-in: they are off by default and require embedded SDK mode (`--embedded-sdk`)
because screen identity comes from the app's embedded AutoMobile SDK. Enable them with
`setToolEnabled` when the app under test embeds the SDK.

## Workflow

1. Launch the app, then build the graph:

```
explore with packageName: "com.example.app", maxInteractions: 200
explore with dryRun: true
```

`strategy` is `breadth-first`, `depth-first`, or `weighted` (default); `mode` is `discover`,
`validate`, or `hybrid` (default). Use `resetToHome` to return home periodically.

2. Inspect what was learned:

```
getNavigationGraph with appId: "com.example.app"
```

3. Replay a learned path:

```
navigateTo with targetScreen: "Settings"
```

## Platform support and limits

- Android and iOS both build graphs through the embedded SDK; screens the SDK cannot name
  are not added, so a sparse graph usually means the app has no SDK screen events.
- `navigateTo` replays the shortest recorded path. Paths are only as reliable as the
  recorded interactions: dynamic content, login state, or changed UI can break a step.

## Recovery

If a replayed step does not reach the expected screen, `navigateTo` reports where it stopped.
Use `observe` to see the current screen, call `getNavigationGraph` to check the path still
exists, and re-run `explore` (`mode: "validate"`) to refresh stale edges.
