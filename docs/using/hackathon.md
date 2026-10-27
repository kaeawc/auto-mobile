# Hackathon demo kit

Build a clickable mobile prototype with an agent in minutes, then demo it on an emulator,
simulator or phone. This guide covers a starting point (eight template prototypes), the loop for
changing them, and a checklist for demo day.

## Zero to prototype in 10 minutes

1. **Install AutoMobile** and add it to your agent: see [Install](../index.md#install).
2. **Boot a device.** Ask the agent to start an Android emulator or an iOS simulator, or plug in an
   Android phone. Prototypes run on Android devices and emulators, and on iOS simulators.
3. **Pick a template.** Ask the agent to show one from the gallery below, for example:

   > Show `test/fixtures/prototype-spec/valid/template-onboarding.json` from this checkout.

   The agent calls the `prototype` tool with `action: "show"` and the file's absolute path as
   `specPath`. To write a spec from scratch, the agent reads the `automobile:prototype` resource,
   the full authoring guide.

4. **Iterate.** Describe a change in plain words ("make the checkout button green, add a promo
   code field"). On Android the agent updates what is on screen with `patch`: content under
   `/data`, state under `/state`, or one node by its `id`. On iOS, and for layout or theme changes,
   it shows the whole spec again; showing the same prototype `id` replaces it in place.
5. **Drive it.** Tap through it yourself, or have the agent tap and type with `tapOn` and
   `sendKeys` using `layer: "prototype"`. Every interactive node in the templates has a
   `testTag`, so a script can find it.

## Template gallery

Each template is a complete multi-screen prototype built on a `stack`: push and pop between
screens, with Android Back and the iOS edge swipe going back. The files live in
[`test/fixtures/prototype-spec/valid/`](https://github.com/kaeawc/auto-mobile/tree/main/test/fixtures/prototype-spec/valid)
and are validated on every change, so they stay valid as the spec evolves.

| Template                    | Shape                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `template-onboarding.json`  | Welcome, sign-up form, done. Field checks, a button disabled until valid, `requireValid`.       |
| `template-feed-detail.json` | Feed of posts from `/data` with a `repeat`, pull to refresh, tap a post for its detail.         |
| `template-tabbed-home.json` | Three pages in a pager driven by a `bottomNav`, plus a pushed settings screen.                  |
| `template-checkout.json`    | Cart with a quantity stepper, delivery form with select and date picker, confirm sheet.         |
| `template-settings.json`    | Switch and radio rows, slider, reset dialog, snackbar. Values persist with `storage`.           |
| `template-search.json`      | Docked search bar, results list, empty state, result detail.                                    |
| `template-chat.json`        | Inbox and a conversation with a list pinned to the newest message and a composer. Android only. |
| `template-dashboard.json`   | Line, bar and ring charts, a week/month switch and a start/stop timer.                          |

Notes on running them:

- A template that needs something the connected device lacks is refused before anything is
  shown, and the error names the missing capability. Update CtrlProxy, or relaunch the iOS app with
  `launchApp prototype: true`, then show again.
- Names, posts and prices are placeholders. Ask the agent to replace them, or edit the file's
  `data` and `state`.
- A typed value, a chosen option or a toggle reaches the agent as an event
  (`prototype` with `action: "awaitEvent"`). The onboarding, checkout and chat templates emit
  `signup_submit`, `order_placed` and `message_sent`, so the agent can respond live in a demo.

## Demo-day checklist

- **Run offline.** A prototype with no `request` actions needs no network. Save it on the device so
  it runs without the laptop. On Android, `prototype` with `action: "save"` and `pin: true` pins it
  to the launcher. With ProtoViewer installed on an Android device or iOS simulator, `save`
  imports it into the ProtoViewer library, and `action: "open"` with the returned `libraryId`
  launches it. An iOS simulator gets a standalone app icon from `save`.
- **Stream to a projector.** Follow [WebRTC streaming](../webrtc-streaming.md) to send the device
  screen to a browser.
- **Record the submission video.** `videoRecording` with `action: "start"` before you begin and
  `action: "stop"` after. `qualityPreset` and `maxDuration` bound size and length.
- **Snapshot before the pitch.** `deviceSnapshot` with `action: "capture"` and a `snapshotName`
  once the device is in its ready state. If the demo breaks, `action: "restore"` with the same
  name. Set `useVmSnapshot: true` on an emulator for a full restore.
- **Script an autopilot fallback.** If live typing is risky, run the walkthrough with
  `executePlan`:

  ```yaml
  name: demo-autopilot
  platform: android
  steps:
    - tool: prototype
      action: show
      specPath: /absolute/path/to/template-onboarding.json
    - tool: tapOn
      layer: prototype
      selector:
        testTag: welcome_start
    - tool: tapOn
      layer: prototype
      selector:
        testTag: name_field
    - tool: sendKeys
      commands:
        - action: type
          text: Ada
    - tool: observe
      label: Capture the sign-up screen
  ```

- **Rehearse timers.** `prototype` with `action: "simulate"` and `advanceTimeMs` moves prototype
  timers forward without waiting, so the dashboard timer can be shown mid-run on demand.

## Known limits

- iOS prototypes run on simulators only today.
- `patch` is Android only. iOS does not advertise `prototype_patch_v1`, so every change there is a
  full `show` with the same `id`.
- The spec is a closed vocabulary: a fixed set of node types and actions, with limits on size,
  depth and counts. There is no custom code and no arbitrary views. The `automobile:prototype`
  resource lists every node, action and limit.
- Some features are not on every platform; for example the chat list is Android only. The refusal
  message names what is missing.
- `request` actions call real endpoints. A copy imported into ProtoViewer keeps requests off until
  you allow network in the app.

## After the hackathon

Turn a prototype into part of a real app with the published renderer libraries: see
[Embedding a prototype in an app](prototype-embedding.md).
