# iOS prototype agent: native look and feature support

Part of [the iOS simulator prototype agent](prototype-agent.md).

## Native look

`theme.design` accepts `material` and `platform`, defaulting to `platform`. Explicit platform
requests require `prototype_design_platform_v1`. Omitted design falls back silently on older agents.
The contract's coverage is below; `neutral` nodes carry no design language. Material entries keep
their drawing and explicit platform requests report `design.fallback` notes. Buttons use SwiftUI
bordered/borderedProminent/borderless styles or an unfilled capsule outline; slider, datePicker and
timePicker use native controls.

| Node            | iOS      | Android  | Parts |
| --------------- | -------- | -------- | ----- |
| badge           | material | material | —     |
| bottomNav       | material | material | —     |
| bottomSheet     | material | material | —     |
| box             | neutral  | neutral  | —     |
| button          | native   | material | —     |
| cameraPreview   | material | material | —     |
| card            | material | material | —     |
| carousel        | neutral  | neutral  | —     |
| castButton      | material | material | —     |
| chart           | material | material | —     |
| checkbox        | material | material | —     |
| chip            | material | material | —     |
| column          | neutral  | neutral  | —     |
| datePicker      | native   | material | —     |
| dialog          | material | material | —     |
| adaptive        | material | material | —     |
| drawer          | material | material | —     |
| tooltip         | material | material | —     |
| divider         | neutral  | neutral  | —     |
| fab             | material | material | —     |
| flow            | neutral  | neutral  | —     |
| grid            | neutral  | neutral  | —     |
| icon            | neutral  | neutral  | —     |
| iconButton      | material | material | —     |
| image           | neutral  | neutral  | —     |
| list            | material | material | —     |
| listItem        | material | material | —     |
| map             | neutral  | neutral  | —     |
| menu            | material | material | —     |
| pager           | neutral  | neutral  | —     |
| pasteButton     | native   | material | —     |
| progress        | material | material | —     |
| radioGroup      | material | material | —     |
| row             | neutral  | neutral  | —     |
| scroll          | neutral  | neutral  | —     |
| searchBar       | material | material | —     |
| segmentedButton | material | material | —     |
| select          | material | material | —     |
| slider          | native   | material | —     |
| snackbar        | material | material | —     |
| spacer          | neutral  | neutral  | —     |
| stack           | neutral  | neutral  | —     |
| switch          | material | material | —     |
| tabBar          | material | material | —     |
| text            | neutral  | neutral  | —     |
| textField       | material | material | —     |
| timePicker      | native   | material | —     |
| topAppBar       | material | material | —     |
| videoPlayer     | material | material | —     |
| webView         | neutral  | neutral  | —     |

Before a node becomes `native`, simulator verification must establish the testability contract:
its `testTag` and every `<testTag>.<part>` remain reachable by `observe` and `tapOn`, observed bounds
match the control, motion-off settles in one frame, and active motion emits the motion-active signal.
The native controls expose no additional authored part suffixes. Segmented Picker, TabView and Menu
cannot preserve per-item identifiers, so segmentedButton, tabBar, bottomNav, menu and select stay
custom-drawn Material.

`bottomNav` applies selected `safeAreaPadding` inside its navigation-container background, so
the fill covers the home-indicator inset while its items remain above it. This padding is applied
once; without selected safe-area edges, the bar keeps its ordinary size.
Authored `style.padding` remains outside this fill and can expose a transparent band;
`style.background` paints behind the default navigation fill rather than replacing it.

### Native container testability

Native SwiftUI containers at the agent's window level have the following accessibility and touch behavior on iOS 18.6, 26.5 and 27.0 unless noted. "Listed" means `observe` returns the element's id or label; "tap works" means `tapOn` fires the control's action. The agent's own touch routing is described in [Native presentations and touches](prototype-agent-runtime.md#native-presentations-and-touches-15463).

| Container                            | Verdict                         | Detail                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.sheet` with detents                | Usable                          | Grabber and close button are listed; plain text in the sheet is not. Programmatic dismissal and a `swipeOn` down from the grabber both fire `onDismiss`.                                                 |
| `.sheet` with background interaction | Usable                          | Touches reach the app under the undimmed detent.                                                                                                                                                         |
| `.alert`                             | Usable                          | Title, buttons and their identifiers are listed; taps fire. Dims and blocks the app, as does `.confirmationDialog`.                                                                                      |
| `.confirmationDialog`                | Usable                          | Title and actions are listed; presentation shadow artwork does not block action taps.                                                                                                                    |
| `Menu`                               | Usable                          | Items are listed and tappable; presentation shadow artwork does not block item taps.                                                                                                                     |
| `Picker(.menu)`                      | Usable                          | Same as `Menu`.                                                                                                                                                                                          |
| `.popover` (compact)                 | Content listed in `context`     | Plain content and the dismiss region are in `context`, not `skeleton`; the shadow artwork is not actionable. An outside tap dismisses it once the overlay window claims the touch, which the agent does. |
| `NavigationStack` toolbar            | Usable                          | Toolbar items are listed and tap; the large title text is not listed.                                                                                                                                    |
| `TabView` (`Tab`)                    | Usable by label or SF Symbol id | Not reachable by `testTag`.                                                                                                                                                                              |
| `.searchable`                        | Usable                          | Field and results are listed; the keyboard is listed as `<ime>`.                                                                                                                                         |

Settling in one frame was not measured for these containers, and an outside tap on a native modal presentation is not device-verified.

A pass-through `hitTest` must claim a rect for each SwiftUI control. A SwiftUI button hit-tests to its hosting view, so returning nil for that view swallows every SwiftUI button.

## Embedded input validation

`PrototypeSpecStrictValidator.validate(data:supportedCapabilities:library:)` is the reject-only
raw-byte entry point (#13620). It extends the generated structural interpreter (#14803) and composes
the request/platform validators, state binding rules, portable check grammar, repeat
tokenizer/binder/data projection and resource guards. Failures throw
`PrototypeLoadError.invalidSpec(path:message:)` before rendering, storage or networking; success
returns no render model. The embedded/serverless loader runs it before its decoder/capability checks;
the Viewer/file loader keeps its existing behavior.

- The shared corpus runner has no exemptions: every valid spec is accepted and every invalid fixture
  is rejected at the TS-captured path (message parity not required). `corpus.json` ratchets the file
  inventory and TS-computed capabilities in TS, Kotlin and Swift. Regenerate with
  `bun scripts/capture-prototype-strict-fixtures.ts`. Invalid envelopes use `rawJson` or
  `rawBytesBase64` where a `spec` would erase duplicate keys or invalid encoding.
- Byte boundary: strips one BOM; rejects duplicate keys, invalid UTF-8, lone surrogates and nonfinite
  tokens at `$`; limits JSON depth to 128 before Foundation decoding. IDs and finite numbers keep TS
  semantics (Unicode form, escaped control characters, negative zero, doubles above 2^53).
- `supportedCapabilities` checks authored features (including hidden and empty-template nodes).
  `library: true` rejects explicit system windows/device persistence; other import network/secret
  policies belong to the importing app. Forbidden headers and literal CR/LF reject in either mode.
- Element anchors still need host resolution to bounds (three valid fixtures keep that loader
  diagnostic). Validation does not imply the renderer advertises every capability.

## Prototype layout direction

`window.layoutDirection` accepts `ltr` or `rtl` and requires the advertised
`prototype_layout_direction_v1` capability. Both page and top rendering layers receive the explicit
SwiftUI direction; UIKit hosting roots receive matching semantic content attributes. Rows and logical
start/end alignment follow that direction. Omission inherits the host. Each show replaces the override,
and none of these settings changes the system locale or the host app's language.

## Dead taps (window.deadTaps, prototype_dead_tap_v1)

`window.deadTaps: true` enables ordinary `emit` events named `prototype_dead_tap` in the
injected agent's passthrough window. The pure session allocates the normal sequence and snapshots;
the payload contains only window-local `x`/`y` points rounded to one decimal and the deepest
stack's id and top screen (ties use the lowest stack id). Both ids are null without stacks;
host reports label that location `(root)`, otherwise `<stack>/<screen>`. No text is collected.
This is an agent preflight capability, not a shared-corpus capability requirement.

The window observes pointer delivery without cancelling touches. A pure tracker rejects multiple
pointers, cancellation and movement reaching 10 points, including movement that later returns to
the origin. Scroll recognizers, control taps (including unchanged values), text focus, actions,
and menu/dialog scrim handlers mark a touch consumed. Evaluation waits until the next main-queue
turn so SwiftUI handlers can finish; deferred single/double-tap targets mark consumption immediately.
Plain text, boxes, images and spacers without handlers remain eligible. Touches outside the
prototype hit rects pass to the app and are excluded. Native UIKit controls are excluded even
when their action does not change state. Embedded views without `PassthroughWindow` do not
observe pointer delivery.

## Feature support

| Feature                                                                | iOS simulator                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show`, `dismiss`, `status`, `awaitEvent`; fullscreen, floating, sheet | Supported                                                                                                                                                                                                                                                                                                                                                                                                      |
| Replace in place; `reset: true` starts fresh                           | Supported (`prototype_show_in_place_v1`)                                                                                                                                                                                                                                                                                                                                                                       |
| Element and bounds anchors                                             | Supported, in points (`prototype_anchor_v1`); [Anchors](prototype-agent-components.md#anchors)                                                                                                                                                                                                                                                                                                                                              |
| `pressScale`, motion, `visibleWhen`, state/actions, assets, fonts      | Supported                                                                                                                                                                                                                                                                                                                                                                                                      |
| Material component nodes, dialog, snackbar, pickers                    | Supported; [Material components](prototype-agent-components.md#material-components)                                                                                                                                                                                                                                                                                                                                                         |
| Reusable `components` / `use` (#11053)                                 | Host expands them before sending; the agent sees plain nodes                                                                                                                                                                                                                                                                                                                                                   |
| Hidden from `layer: "app"` observe screenshots                         | Supported (#10943, #10988); host restores after capture; verified on an iOS 27.0 simulator (`screenshotIncludesPrototype: false`)                                                                                                                                                                                                                                                                              |
| `display` selector                                                     | Refused: the agent draws only on the phone screen; CarPlay is not supported ([CarPlay prototypes](carplay-prototypes.md))                                                                                                                                                                                                                                                                                      |
| `window.layer: "app"`                                                  | Accepted and ignored silently: window level is fixed at alert + 1                                                                                                                                                                                                                                                                                                                                              |
| `window.persistence: "device"`                                         | Refused: the agent dies with the app process                                                                                                                                                                                                                                                                                                                                                                   |
| `window.chrome` (#12064)                                               | Fullscreen only, `prototype_window_chrome_v1`; see [Dismiss control](prototype-agent-components.md#dismiss-control). Older agents keep the bar; explicit `none` is refused with a relaunch hint                                                                                                                                                                                                                                             |
| `inspect`                                                              | `prototype_inspect_v1`; [Inspect](prototype-agent-runtime.md#inspect)                                                                                                                                                                                                                                                                                                                                                                    |
| Idle TTL, dismissal on host disconnect                                 | [Expiry](#expiry)                                                                                                                                                                                                                                                                                                                                                                                              |
| Per-mode colours/images, gradients, role scrims (#11220)               | `prototype_theme_modes_v1`; [Light and dark values](prototype-agent-runtime.md#light-and-dark-values)                                                                                                                                                                                                                                                                                                                                    |
| Appearance override/inference/live re-theme (#11222)                   | `prototype_appearance_v1`; [Appearance](prototype-agent-components.md#appearance)                                                                                                                                                                                                                                                                                                                                                           |
| Bottom sheet above the keyboard                                        | [Bottom sheet and the keyboard](prototype-agent-runtime.md#bottom-sheet-and-the-keyboard)                                                                                                                                                                                                                                                                                                                                                |
| Style `weight`, min/max sizes, `aspectRatio` (#11543)                  | `PrototypeSizing`, Android's order (bounds, `width`/`height`, aspect ratio); see below                                                                                                                                                                                                                                                                                                                         |
| Style `effects` (#15130, not device-verified)                          | `prototype_effects_v1`; [Style effects](#style-effects)                                                                                                                                                                                                                                                                                                                                                        |
| `haptics.perform`, `sound.play` platform calls (#14329)                | `prototype_platform_haptics_v1`, `prototype_platform_sound_v1`; UIKit feedback generators (the Simulator does not render haptics) and `AudioServices` system sounds, with `feedbackLog` (last 64 calls) in `inspect`; `volume` is ignored, suppression is not detectable                                                                                                                                       |
| `links.open` platform call (#14238)                                    | `prototype_platform_links_v1`; `UIApplication.open` for external opens and `SFSafariViewController` for in-app web URLs, presented from the prototype overlay window so it shows above the prototype (the key window when the prototype is embedded) and closed when the prototype is dismissed or replaced; a web URL without a host is `invalidArgs`; `tel:`/`mailto:` report `unavailable` on the Simulator |
| `/platform/connectivity` state and `connectivity.changed` (#14273)     | `prototype_platform_connectivity_v1`; `NWPathMonitor` in the agent and Viewer registries, started on first read; each changed path refreshes `/platform` at once, the first path is the baseline and the event trails a 500 ms debounce                                                                                                                                                                        |
| Data model (#11673)                                                    | `prototype_data_model_v1`; [Data model capability](prototype-agent-data.md#data-model-capability)                                                                                                                                                                                                                                                                                                                                     |
| Data actions (#12519)                                                  | `prototype_data_actions_v1`; [Data actions capability](prototype-agent-data.md#data-actions-capability)                                                                                                                                                                                                                                                                                                                               |
| Storage (#12522)                                                       | `prototype_storage_v1`; [Storage capability](prototype-agent-data.md#storage-capability)                                                                                                                                                                                                                                                                                                                                              |
| Request action (#12529)                                                | `prototype_network_v1` / `prototype_network_device_v1`; [Request action capability](prototype-agent-data.md#request-action-capability)                                                                                                                                                                                                                                                                                                |
| [Patch (#11675)](../android/prototype-ux-patch.md#patch-11675)               | `prototype_patch_v1`: `/data`, `/state`, `replaceNode` in place (`PrototypeSession.patch`)                                                                                                                                                                                                                                                                                                                     |
| Non-scalar state (`null`, array, object)                               | Refused at `show` (state is string, number or boolean)                                                                                                                                                                                                                                                                                                                                                         |
| Foreground scoping to the shown-over app                               | Not needed: backgrounding the app hides its window                                                                                                                                                                                                                                                                                                                                                             |
| Accessibility identifier fallback (`node.id`)                          | Only `testTag` (and `<testTag>.<part>`); `prototype_identifier_test_tag_only_v1`                                                                                                                                                                                                                                                                                                                               |
| Bottom sheet swipe-dismiss, detent dragging                            | As Android: first detent, drags between detents, `dismissOnSwipe` default true; `prototype_bottom_sheet_drag_v1`                                                                                                                                                                                                                                                                                               |
| Built-in icons                                                         | `schemas/prototype-ios-icon-symbols.json` (reviewable: `ios/prototype-agent/ICON-SYMBOLS.md`); unmapped draw `questionmark.square`; `prototype_icon_sf_symbols_v1`                                                                                                                                                                                                                                             |
| Icon node `variant`                                                    | See [Material components](prototype-agent-components.md#material-components)                                                                                                                                                                                                                                                                                                                                                                |

### Adaptive layouts

`adaptive` uses `horizontalSizeClass`: regular selects split/sidebar/inspector and compact selects stack/bottom bar/sheet. Every design draws Material-styled containers in SwiftUI; native `NavigationSplitView`, sidebar-adaptable `TabView` and `.inspector` are not used (#15255). Pure Core types map width to mode and clear compact list selection to an empty string on Back.

`listDetail` requires `list`, `detail`, and a declared string `selectionKey`. `navigationSuite` requires 1–8 unique `{value,label}` items, a declared string `stateKey` naming an item, and `content`. `supporting` requires `main`, `supporting`, and a declared boolean `openKey`. Slots are ordinary node subtrees. Android uses its expanded pane rule and compact/medium/expanded navigation classes; no shared breakpoint or `minWidth` exists, and show reports the difference in `platformNotes`.

Sizing details (not device-verified): a `weight` takes exactly its share of a `row`/`column` main axis
and beats that axis's size and bounds (ignored outside a row/column); `min` wins when it exceeds `max`;
content on an axis with no authored size (or `wrap`) is centred in the box a min bound grew
(`wrapContentWidth()`/`wrapContentHeight()`), while explicit `width`/`height`/`fill` keeps alignment;
weighted stacks mirror under RTL via SwiftUI Layout; sizes are fractional points. Rows reserve
all children's minimum widths, including fills, nested rows' children and gaps, and allocate
non-filling content least-flexible first (ideal minus minimum), with direct buttons prioritized.
Fills, unsized horizontal dividers, spacers and controls expanding beyond their ideal width under an infinite proposal
share the remainder with the flexible slots inserted for `space*` arrangements, retain their probed
minimum widths and redistribute unused max-bounded width; fixed/wrap spacers remain content. Native
arrangement spacers expand horizontally only. Rows report
only the width used. Size wrappers preserve greedy probes unless a finite maximum or explicit size caps
the axis. Nested rows and weighted stacks report infinity for an infinite main-axis probe when a child
shares the remainder; nil proposals still measure ideal content. In weighted rows, unweighted greedy
children are sized before weights, reserving all probed minimums; weights divide only what remains
in proportion to their authored values. An unweighted greedy child may therefore leave weights zero.
Row-filling components include sliders, text fields, radio groups, list items, segmented buttons,
top app bars, snackbars and linear or indeterminate progress indicators. Unlike iOS's least-flexible-first
allocation and equal sharing in unweighted rows, Android's ordinary Row measures in
authored order: an early fill-width control can consume the remainder before later labels or controls.
Overfull controls retain their minimums and overflow at the trailing end
instead of overlapping. Weighted columns likewise preserve unweighted authored minimum heights,
overflowing rather than collapsing a fixed-height child at a zero share; weights still take zero
when no room remains.
Zero-size probes preserve authored dp sizes and min bounds, deriving aspect-ratio dimensions from
an explicit dp width or height. Nil-proposal rows retain their measured ideal widths during placement,
including fill children, rather than redistributing them.

## Style effects

`style.effects` (#15128 contract, #15130 renderer) is not device-verified. Every one of the ten
effects renders on any iOS 17 simulator (Android's API-floor table does not apply), through
`PrototypeEffectsView.swift`:

| `type`                | SwiftUI                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `noise`               | `Rectangle().fill(ShaderLibrary.noise(...))`, over the content          |
| `gradientMesh`        | `Rectangle().fill(ShaderLibrary.gradientMesh(...))`, behind the content |
| `shimmer`             | a `LinearGradient` band, over the content                               |
| `glow`                | a blurred inward `strokeBorder`, over the content                       |
| `vignette`            | a `RadialGradient`, over the content                                    |
| `blur`                | `.blur(radius:)` on the node's own background and content               |
| `pixelate`            | `layerEffect`                                                           |
| `chromaticAberration` | `layerEffect`                                                           |
| `wave`                | `distortionEffect`                                                      |
| `ripple`              | `distortionEffect`                                                      |

- **Metal presets.** `ios/prototype-agent/Shaders/PrototypeEffects.metal` holds the shaders. SwiftPM
  does not compile `.metal`, and `ShaderLibrary` loads only precompiled libraries from a bundle or from
  bytes, so `scripts/ios/prototype-effects-metallib.sh` compiles a metallib on every build and emits
  `PrototypeEffectsMetallib.swift` (base64, never committed). `prototype-agent-build.sh`,
  `prototype-viewer-build.sh` and `protoviewer-build.sh` compile it with the other sources and the
  agent loads it with `ShaderLibrary(data:)`. The script installs the Metal Toolchain
  (`xcodebuild -downloadComponent metalToolchain`) when Xcode 26 lacks it.
- **Layers.** As on Android: distortions wrap the node's background and content after its corner
  clip, in authored order; `shimmer`, `glow`, `vignette` and `noise` paint over the content inside the
  corner shape and are not distorted; `gradientMesh` sits between the background and the content.
  Effects never change layout, hit testing or accessibility.
- **Shared decisions** (same defaults, colour resolution and `phase`/`animate` rules as Android; see
  its [Effects](../android/prototype-ux-effects.md#effects-15128-15129-prototype_effects_v1)
  section): `phase` and `animate` move only `shimmer`, `wave` and `ripple`.
- **Time.** `TimelineView(.animation(paused:))` drives the phase and is paused under `motion: "none"`,
  `motion: "reduced"` and Reduce Motion, so an animated effect keeps its authored `phase`. The phase
  function (`PrototypeEffects.phase`) is unit-tested without a GPU. Differences from Android: iOS also
  freezes under `motion: "reduced"`, and restarts an animation at its authored `phase` each time the
  clock starts running (Android resumes where it stopped). There is no frame-budget guard on iOS, so
  `degradedEffects` never carries reason `budget`.
- **Platform views.** SwiftUI draws a placeholder instead of a platform-backed view inside a
  `layerEffect` or `distortionEffect`. The platform-backed node types are text fields, search bars,
  sliders, selects, date and time pickers, scrolls, pagers, carousels, stacks and dialogs, and any
  descendant with an `id` (the renderer reports its menu bounds through a UIKit marker view behind
  it). The shader-sampled effects (`pixelate`, `chromaticAberration`,
  `wave`, `ripple`) are omitted on a node that is or holds such a view, not on the whole spec; `blur`
  and the over-the-content effects still draw. The show reply and `get_prototype_status` /
  `inspect_prototypes` list each omitted effect in `degradedEffects` as `{path, type, reason:
  "platform"}`. `path` is `<node position>.style.effects[<authored index>]` with the node's position in
  the shown tree (`root`, `root.children[1]`, `root.child`, `root.screens["home"]`); `repeat` rows are
  already expanded there, so a row has a plain `children[k]` path where Android's has
  `repeat[<key>]`. Nodes whose `visibleWhen` fails and inactive stack screens are skipped, as on
  Android. A `blur` or displacement is clipped to the node's bounds.

## Appearance actions and timers

`onAppear` requires `prototype_timers_v1`. The root and nodes with `visibleWhen` accept
1..32 tap-union actions; other placements fail at `<path>.onAppear`. The session runs visible
handlers on first/reset show and hidden-to-visible edges, including ancestor visibility and
active pager/stack children. Visible-to-visible changes and state-preserving same-id shows do
not fire. Repeat instances bind handlers as taps and use separate paths. Each list validates
atomically and emits tap-style change events without restarting idle TTL. Cascades use the
existing action-depth bound and refuse a second execution of a handler within one interaction.

Appearance-started timers use the shared timer ledger: pause while the prototype is hidden,
cancel on dismissal, TTL expiry or replacing show, and survive hiding their originating node.
`advance_prototype_clock` drives them without waiting; status/inspect include their
`{id,nextFireInMs,runs}` entries.

## Expiry

iOS prototypes expire like Android session prototypes
([Lifecycle and safety](../android/prototype-ux-lifecycle.md#lifecycle-and-safety)).

- **Idle TTL.** 300,000 ms (`PrototypeIdleTimer`, settable locally via
  `PrototypeModel.idleTtlMilliseconds`; no wire field). An accepted `show_prototype` (including a
  same-id replace) and user interaction (taps, edits, an actually-changed pager page) restart it.
  Initial pager reports, `onAppear`, authored timer fires, a snackbar's own `durationMs` close, `hide_for_capture` and
  `get_prototype_status` do not. A hidden prototype still expires.
- **Disconnect.** The prototype belongs to the host session, not a socket. `PrototypeClientTracker`
  counts authenticated connections; when the last closes, the prototype is dismissed and uploaded
  assets dropped (whether or not one was showing). A `show_prototype` handled after that edge is
  dismissed the same way.
- **Events.** One `prototype_event` `kind: "dismissed"`, null `name`, `payload: {"reason": "ttl"}` or
  `{"reason": "disconnect"}`, sequenced from the per-id ledger. Reasons: `user`, `agent`, `ttl`,
  `disconnect`.
- **Not applicable.** `teardown` is never emitted (no service to unbind); no `persistence: "device"`,
  so nothing is TTL-exempt.
- **Host.** No change needed: it holds one persistent connection per launch and treats any `dismissed`
  event as removing shown status.
