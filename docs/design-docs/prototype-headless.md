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
- `patch` applies ops with `applyPrototypePatch` and raises the revision. A `/state` patch whose
  `baseRevision` is older than the last device-side state change is answered with `conflict`.
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

`VirtualPrototypeDevice.dispatch({id, kind, name, payload?, state?, pages?})` is the single entry
for user input: it merges state and pages, allocates the next sequence and pushes a
`prototype_event` to the transport's listeners, so the event coordinator buffers it and awaitEvent
returns it as from hardware. A device-side state change makes a stale `/state` patch conflict. The
web page runs its actions in the browser and posts nothing back today; a renderer that reports taps
and input (the live preview server, #17975) and routing `tapOn`/`inputText` to the virtual device
call `dispatch`.

## Not covered yet

- Routing interaction tools and the browser page's taps into `dispatch`.
- Timers and `simulate` (`prototype_timers_v1`).
- The project export (separate `index.html`, JS, CSS and `package.json`).
