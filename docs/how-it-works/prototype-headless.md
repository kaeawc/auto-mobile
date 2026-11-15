# Headless prototype mode

Headless mode runs the `prototype` tool against a virtual device the daemon holds in memory, so
show, patch, dismiss, status, inspect, awaitEvent, mock backends, the accessibility lint and the
`automobile:prototype/<id>/web` and `automobile:prototype/native?id=<id>` resources work with no
adb, emulator or simulator.

## Selection

Headless mode is explicit. `AUTOMOBILE_HEADLESS=1` (any `readEnvBool` truthy value) or `--headless`
selects it; `--headless` sets the variable during startup, before a daemon is spawned, so the
daemon inherits it through `daemonProcessEnvironment`. It is never chosen automatically when no
device is found. A daemon that is already running keeps the mode it started with.

`registerPrototypeTools` passes `shouldEnsureDevice: () => !headless` and a `nonDeviceHandler`
to `ToolRegistry.registerDeviceAware`. In headless mode the registry resolves no device (no
discovery, readiness or holder check) and calls the prototype handler with
`VIRTUAL_PROTOTYPE_DEVICE` (`deviceId` `automobile-virtual-prototype`, platform `android`). Every
other tool is unaffected.

## Virtual device contract

`VirtualPrototypeDevice` (`src/features/prototype/headless/`) implements `AndroidPrototypeClient`,
the CtrlProxy surface `AndroidPrototypeTransport` forwards to. The prototype runtime's
`clientFactory` returns the host's virtual device for the virtual device id, so the shared Android
path runs unchanged: spec validation, capability gates, asset staging, the status store, the
shown-spec mirror and spec revisions, the event coordinator and the patch queue. The virtual device
keeps state only:

- `show` stores a copy of the spec, its `state`, `pages` and a revision. A same-id show without
  `reset` keeps pages; `replaceOthers: false` keeps other ids. Sequences never rewind for an id.
  Referenced image, font and shader asset ids with no upload are returned as `missingAssets`, so
  the host's re-upload path runs as on hardware.
- `patch` applies ops with `applyPrototypePatch` and raises the revision. As in CtrlProxy, each
  state key keeps the revision that last wrote it (a show, a patch or an input), and a `/state`
  patch is refused without a `baseRevision`, with one newer than the device's, or with `conflict`
  naming the keys it touches that were written after its `baseRevision`.
- `inspect` reports every shown id with its state, pages, data and last sequence.
- `dismiss` removes one id or all of them.
- Saved prototypes are refused.

It is an injected dependency (`PrototypeToolDependencies.virtualDevice`); tests construct one with
`FakeTimer` and drive it directly.

## Capabilities

`supportsCommand` answers from `VIRTUAL_PROTOTYPE_CAPABILITIES`: the spec features the web renderer
draws and the in-memory protocol (`prototype_patch_v1`, `prototype_persistence_replay_v1`,
`prototype_show_in_place_v1`). `VIRTUAL_PROTOTYPE_UNSUPPORTED_CAPABILITIES` lists what needs a real
device: system windows and `window.layer`/`persistence` (`prototype_window_options_v1`), window
chrome, displays and multi-surface, element anchors, appearance pinning, blur backdrops, custom
shaders, dead taps, device-side network, platform modules (haptics, sound, clipboard and the other
`prototype_platform_*` modules), saved prototypes, storage and timers. A spec needing one is refused
by the existing gate, exactly as an older CtrlProxy refuses it; nothing is silently approximated.
`headlessPrototypeRefusal` refuses `save`, `listSaved`, `deleteSaved`, `open`, `clearStorage`,
`simulate` and `display` before anything runs.

## Marking results as virtual

Every result produced for the virtual device carries `virtualDevice {deviceId, renderer: "web",
unsupportedCapabilities}`, success or failure, so a headless render is never mistaken for a device
render. The page itself is the same page a device show produces; the device frame is the Android
default.

## Event dispatch

`VirtualPrototypeDevice.dispatch({id, kind, name, payload?, state?, pages?, stacks?, context?})`
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

`VirtualPrototypeInputs` reads `snapshots()` (newest prototype first) and plans with
`virtualPrototypeInteraction.ts`:

- **Target.** A depth-first walk of what a device would draw: nodes whose `visibleWhen` holds
  (`conditionHolds`; undecidable parts count as visible), open `openWhen` overlays, the current
  pager page and the top stack screen. Repeat templates are skipped. A dialog's `confirm` and
  `dismiss` buttons are targets too. An exact, case-insensitive match on `text`, `label`,
  `headline`, `title`, `placeholder` or `contentDescription` wins over a substring match.
  `elementId`/`testTag` match `id` or `testTag`. The handler is the nearest ancestor-or-self with
  an interaction. A disabled handler (`enabledWhen`), a toggle on a non-boolean key, or no handler
  at all is `handled: false` and raises nothing.
- **Interaction.** `textField`/`searchBar` with a `stateKey` take focus. `switch`, `checkbox` and
  `chip` with a `stateKey` toggle it. A dialog button closes its `openWhen`. Any node with
  `onTap` runs it.
- **Order.** This follows `PrototypeRuntime.control` and `run`. The control's own write and its
  `change` come first, then the actions in order. `emit` carries the state at that point, and one trailing
  `change` names every key the list changed. `setPage` raises `page_changed`, then its `stateKey`
  `change`. Stack actions raise `screen_changed`. `dismiss` stops the list and raises
  `dismissed {reason: "user"}` with no trailing change.
- **Refusal.** `virtualInteractionRefusal` checks the whole list before anything runs. It refuses
  actions outside the runnable set, `emit.requireValid`, emit context other than
  `state`/`page`/`data`/`value`, non-scalar `setState` values, and stack actions with `params` or on
  a stack with `routes`.
- **Text.** `typeText` and `clearText` write the focused key as one control write (one `change`),
  truncated to the field's `maxLength`. `hideKeyboard` and dismissal clear focus.

Timers and `simulate` (`prototype_timers_v1`) are unsupported. There is no screenshot, `tapAt` or
node bounds, because nothing lays the page out without a browser, and there is no project export.

## Background

- [Headless prototype follow-ups](../devlog/2026-11-11-prototype-headless-follow-ups.md)
- [Headless taps run on the host, not in a browser](../devlog/2026-11-15-prototype-headless-input.md)
