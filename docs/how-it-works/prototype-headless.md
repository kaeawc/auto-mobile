# Headless prototype mode

Headless mode runs the `prototype` tool against a virtual device the daemon holds in memory.
Show, patch, dismiss, status, inspect, awaitEvent, mock backends, the accessibility lint and the
`automobile:prototype/<id>/web` and `automobile:prototype/native?id=<id>` resources then work with
no adb, emulator or simulator.

## Selection

Headless mode is explicit. Setting `AUTOMOBILE_HEADLESS=1` (any `readEnvBool` truthy value) or
passing `--headless` selects it. The `--headless` flag sets the variable during startup, before the
CLI spawns a daemon, so the daemon inherits it through `daemonProcessEnvironment`. The host never
picks headless mode automatically when it finds no device. A daemon that is already running keeps the mode it started with.

`registerPrototypeTools` passes `shouldEnsureDevice: () => !headless` and a `nonDeviceHandler`
to `ToolRegistry.registerDeviceAware`. In headless mode the registry resolves no device (no
discovery, readiness or holder check) and calls the prototype handler with
`VIRTUAL_PROTOTYPE_DEVICE` (`deviceId` `automobile-virtual-prototype`, platform `android`). Every
other tool is unaffected.

## Virtual device contract

`VirtualPrototypeDevice` (`src/features/prototype/headless/`) implements `AndroidPrototypeClient`,
the CtrlProxy surface `AndroidPrototypeTransport` forwards to. The prototype runtime's
`clientFactory` returns the host's virtual device for the virtual device id. The shared Android
path therefore runs unchanged: spec validation, capability gates, asset staging, the status store, the
shown-spec mirror and spec revisions, the event coordinator and the patch queue. The virtual device
keeps state only:

- `show` stores a copy of the spec, its `state`, `pages` and a revision. A same-id show without
  `reset` keeps pages; `replaceOthers: false` keeps other ids. Sequences never rewind for an id.
  Referenced image, font and shader asset ids with no upload are returned as `missingAssets`, so
  the host's re-upload path runs as on hardware.
- `patch` applies ops with `applyPrototypePatch` and raises the revision. As in CtrlProxy, each
  state key keeps the revision that last wrote it (a show, a patch or an input). The device refuses
  a `/state` patch without a `baseRevision` or with one newer than the device's. It also refuses,
  with `conflict` naming them, a patch touching keys written after its `baseRevision`.
- `inspect` reports every shown id with its state, pages, data and last sequence.
- `dismiss` removes one id or all of them.
- Saved prototypes are refused.

It is an injected dependency (`PrototypeToolDependencies.virtualDevice`); tests construct one with
`FakeTimer` and drive it directly.

## Capabilities

`supportsCommand` answers from `VIRTUAL_PROTOTYPE_CAPABILITIES`: the spec features the web renderer
draws and the in-memory protocol (`prototype_patch_v1`, `prototype_persistence_replay_v1`,
`prototype_show_in_place_v1`). The `VIRTUAL_PROTOTYPE_UNSUPPORTED_CAPABILITIES` list names what
needs a real device:

- system windows and `window.layer`/`persistence` (`prototype_window_options_v1`);
- window chrome, displays and multi-surface;
- element anchors, appearance pinning, blur backdrops, custom shaders and dead taps;
- device-side network;
- platform modules (haptics, sound, clipboard and the other `prototype_platform_*` modules);
- saved prototypes, storage and timers.

The existing gate refuses a spec needing one, exactly as an older CtrlProxy refuses it; nothing is
silently approximated. Before anything runs, `headlessPrototypeRefusal` refuses `save`,
`listSaved`, `deleteSaved`, `open`, `clearStorage`, `simulate` and `display`.

## Marking results as virtual

Every result produced for the virtual device carries `virtualDevice {deviceId, renderer: "web",
unsupportedCapabilities}`, success or failure, so a headless render is never mistaken for a device
render. The page itself is the same page a device show produces; the device frame is the Android
default.

## Event dispatch

`VirtualPrototypeDevice.dispatch({id, kind, name, payload?, state?, pages?, stacks?, context?,
contextTruncated?})`
is the single entry for user input. It merges state, pages and stacks, allocates the next
sequence and pushes a `prototype_event` to the transport's listeners, so the event coordinator
buffers it and awaitEvent returns it as from hardware. The keys an input changes are stamped with
its revision. A `dismissed` event removes the prototype.

## Interaction tools

In headless mode `tapOn` and `sendKeys` register `shouldEnsureDevice: () => !headless` and a
`nonDeviceHandler` (`src/server/interactionTools/headlessPrototypeInput.ts`). They act on the daemon
host's `VirtualPrototypeInputs`, which the prototype runtime publishes through
`setDaemonVirtualPrototypeInputsReader`. Before the first prototype call there is none, and both
tools fail with "call prototype show first".

`VirtualPrototypeInputs` reads `snapshots()` (newest show first, so showing an id again brings it
to the front) and plans with `virtualPrototypeInteraction.ts`:

- **Target.** A depth-first walk of what a device would draw: nodes whose `visibleWhen` holds,
  open `openWhen` overlays, an expanded search bar's results (`activeKey` true), the current
  pager page and the top stack screen. Repeat templates are skipped. A dialog's `confirm` and
  `dismiss` buttons, a snackbar's `action` and each `tabBar` or `bottomNav` item are targets too.
- **Modals.** While a `dialog`, `bottomSheet`, `drawer` or `menu` is open, only nodes in the
  topmost one, or in an overlay later in tree order, are reachable. A snackbar or tooltip never
  blocks.
- **Conditions.** `decideVirtualCondition` evaluates `visibleWhen` and `enabledWhen` as
  `PrototypeCondition.holds` does, string operators included. A `data`, `platform` or `valid`
  condition on the path to the match refuses the input.
- **Match.** An exact, case-insensitive match on the rendered text wins over a substring match.
  Rendered text is `text` and `title` with `{key}` state tokens interpolated, `label`,
  `headline`, `placeholder`, `contentDescription`, and a `textField`'s or `searchBar`'s current
  value. `elementId`/`testTag` match `id` or `testTag`. The handler is the nearest
  ancestor-or-self with an interaction. A disabled handler (`enabledWhen`), a toggle on a
  non-boolean key, or no handler at all is `handled: false` and raises nothing.
- **Interaction.** `textField`/`searchBar` with a `stateKey` take focus. `switch`, `checkbox` and
  `chip` with a `stateKey` toggle it, as does a `listItem` with a trailing `switch` or `checkbox`.
  A dialog button or snackbar action closes its `openWhen`. A bar item selects its index: with a
  `pager`, a `setPage` before the bar's `onTap`; otherwise a write to the bar's `stateKey`. Any
  node with `onTap` runs it.
- **Order.** This follows `PrototypeRuntime.control` and `run`. The control's own write and its
  `change` come first, then the actions in order. `emit` carries the state at that point.
  Its context goes through `resolveEmitContext`, so the 4096-byte cut and `contextTruncated`
  match the device. One trailing
  `change` names every key the list changed. `setPage` raises `page_changed`, then its `stateKey`
  `change`. Stack actions raise `screen_changed`. `dismiss` stops the list and raises
  `dismissed {reason: "user"}` with no trailing change.
- **Writes.** Each state write is validated against the spec, as `writeInteractionSpec` does,
  while the interaction is planned. A rejected write fails the input before any event or state
  lands. Pager-bound keys are clamped and their pagers rebound to the written page. After the
  events, `settle` leaves the final state, pages and stacks on the device even when no trailing
  `change` carries them. It also stamps keys written and restored with no event between, so a
  stale `/state` patch still conflicts on them.
- **Refusal.** `virtualInteractionRefusal` checks the whole list before anything runs. It refuses
  actions outside the runnable set, `emit.requireValid`, emit context other than
  `state`/`page`/`data`/`value`, non-scalar `setState` values, and stack actions with `params` or on
  a stack with `routes`.
- **Text.** `typeText` and `clearText` write the focused key as one control write (one `change`),
  cut to the field's current `maxLength` in UTF-16 code units, never splitting a surrogate pair.
  They fail when the focused field is no longer shown and
  enabled. `hideKeyboard` and dismissal clear focus. A `sendKeys` selector goes through `focusOn`,
  which focuses a matched `textField` or `searchBar` without running any tap handler and refuses
  any other match. `layer: "app"` fails, since the virtual device has no app below the prototype.

Timers and `simulate` (`prototype_timers_v1`) are unsupported. There is no screenshot, `tapAt` or
node bounds, because nothing lays the page out without a browser, and there is no project export.

## Background

- [Headless prototype follow-ups](../devlog/2026-11-11-prototype-headless-follow-ups.md)
- [Headless taps run on the host, not in a browser](../devlog/2026-11-15-prototype-headless-input.md)
