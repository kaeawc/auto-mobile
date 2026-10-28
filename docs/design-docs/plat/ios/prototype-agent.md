# iOS simulator prototype agent

Agent-authored prototypes (milestone 37, #9295) on iOS simulators, with no SDK in the
target app. iOS counterpart of the [Android prototype specification](../android/prototype-ux.md);
the spec, validation limits and node vocabulary are shared. Epic #10563.

Device verification of the iOS window-layer `tapOn` fix (#10498) and the items marked "not
device-verified" below remain open. `scripts/ios/prototype-agent-demo.ts` is a standalone driver.

## Native look

`theme.design` accepts `material` and `platform`, defaulting to `platform`. Explicit platform
requests require `prototype_design_platform_v1`. Omitted design falls back silently on older agents.
The contract's coverage is below; `neutral` nodes carry no design language. Material entries keep
their current drawing and explicit platform requests report `design.fallback` notes. Button uses
SwiftUI bordered/borderedProminent/borderless styles; slider, datePicker and timePicker already
use native controls. No rendering changes accompany this default.

| Node            | iOS      | Android  | Parts |
| --------------- | -------- | -------- | ----- |
| badge           | material | material | —     |
| bottomNav       | material | material | —     |
| bottomSheet     | material | material | —     |
| box             | neutral  | neutral  | —     |
| button          | native   | material | —     |
| card            | material | material | —     |
| carousel        | neutral  | neutral  | —     |
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

Before a node becomes `native`, simulator verification must establish the testability contract:
its `testTag` and every `<testTag>.<part>` remain reachable by `observe` and `tapOn`, observed bounds
match the control, motion-off settles in one frame, and active motion emits the motion-active signal.
The current native controls expose no additional authored part suffixes. Further native controls
and a MaterialLook/PlatformLook renderer split are follow-ups. Segmented Picker, TabView and Menu
remain custom-drawn because they cannot preserve per-item identifiers; segmentedButton, tabBar,
bottomNav, menu and select therefore remain Material.

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
when their action does not change state. Embedded views without `PassthroughWindow` do not yet
observe pointer delivery; pure session support alone does not verify that input path.

## Feature support

| Feature                                                                | iOS simulator                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show`, `dismiss`, `status`, `awaitEvent`; fullscreen, floating, sheet | Supported                                                                                                                                                                                                                                                                                                                                            |
| Replace in place; `reset: true` starts fresh                           | Supported (`prototype_show_in_place_v1`)                                                                                                                                                                                                                                                                                                             |
| Element and bounds anchors                                             | Supported, in points (`prototype_anchor_v1`); [Anchors](#anchors)                                                                                                                                                                                                                                                                                    |
| `pressScale`, motion, `visibleWhen`, state/actions, assets, fonts      | Supported                                                                                                                                                                                                                                                                                                                                            |
| Material component nodes, dialog, snackbar, pickers                    | Supported; [Material components](#material-components)                                                                                                                                                                                                                                                                                               |
| Reusable `components` / `use` (#11053)                                 | Host expands them before sending; the agent sees plain nodes                                                                                                                                                                                                                                                                                         |
| Hidden from `layer: "app"` observe screenshots                         | Supported (#10943, #10988); host restores after capture                                                                                                                                                                                                                                                                                              |
| `display` selector                                                     | Refused: a simulator has one screen                                                                                                                                                                                                                                                                                                                  |
| `window.layer: "app"`                                                  | Accepted and ignored silently: window level is fixed at alert + 1                                                                                                                                                                                                                                                                                    |
| `window.persistence: "device"`                                         | Refused: the agent dies with the app process                                                                                                                                                                                                                                                                                                         |
| `window.chrome` (#12064)                                               | Fullscreen only, `prototype_window_chrome_v1`; see [Dismiss control](#dismiss-control). Older agents keep the bar; explicit `none` is refused with a relaunch hint                                                                                                                                                                                   |
| `inspect`                                                              | `prototype_inspect_v1`; [Inspect](#inspect)                                                                                                                                                                                                                                                                                                          |
| Idle TTL, dismissal on host disconnect                                 | [Expiry](#expiry)                                                                                                                                                                                                                                                                                                                                    |
| Per-mode colours/images, gradients, role scrims (#11220)               | `prototype_theme_modes_v1`; [Light and dark values](#light-and-dark-values)                                                                                                                                                                                                                                                                          |
| Appearance override/inference/live re-theme (#11222)                   | `prototype_appearance_v1`; [Appearance](#appearance)                                                                                                                                                                                                                                                                                                 |
| Bottom sheet above the keyboard                                        | [Bottom sheet and the keyboard](#bottom-sheet-and-the-keyboard)                                                                                                                                                                                                                                                                                      |
| Style `weight`, min/max sizes, `aspectRatio` (#11543)                  | `PrototypeSizing`, Android's order (bounds, `width`/`height`, aspect ratio); see below                                                                                                                                                                                                                                                               |
| Style `effects` (#15130, not device-verified)                          | `prototype_effects_v1`; [Style effects](#style-effects)                                                                                                                                                                                                                                                                                              |
| `haptics.perform`, `sound.play` platform calls (#14329)                | `prototype_platform_haptics_v1`, `prototype_platform_sound_v1`; UIKit feedback generators (the Simulator does not render haptics) and `AudioServices` system sounds, with `feedbackLog` (last 64 calls) in `inspect`; `volume` is ignored, suppression is not detectable                                                                             |
| `/platform/connectivity` state and `connectivity.changed` (#14273)     | `prototype_platform_connectivity_v1`; `NWPathMonitor` in the agent and Viewer registries, started on first read; each changed path refreshes `/platform` at once, the first path is the baseline and the event trails a 500 ms debounce                                                                                                              |
| Data model (#11673)                                                    | `prototype_data_model_v1`; [Data model capability](#data-model-capability)                                                                                                                                                                                                                                                                           |
| Data actions (#12519)                                                  | `prototype_data_actions_v1`; [Data actions capability](#data-actions-capability)                                                                                                                                                                                                                                                                     |
| Storage (#12522)                                                       | `prototype_storage_v1`; [Storage capability](#storage-capability)                                                                                                                                                                                                                                                                                    |
| Request action (#12529)                                                | `prototype_network_v1` / `prototype_network_device_v1`; [Request action capability](#request-action-capability)                                                                                                                                                                                                                                      |
| [Patch (#11675)](../android/prototype-ux.md#patch-11675)               | `prototype_patch_v1`: `/data`, `/state`, `replaceNode` in place (`PrototypeSession.patch`)                                                                                                                                                                                                                                                           |
| Non-scalar state (`null`, array, object)                               | Refused at `show` (state is string, number or boolean)                                                                                                                                                                                                                                                                                               |
| Foreground scoping to the shown-over app                               | Not needed: backgrounding the app hides its window                                                                                                                                                                                                                                                                                                   |
| Accessibility identifier fallback (`node.id`)                          | Only `testTag` (and `<testTag>.<part>`); `prototype_identifier_test_tag_only_v1`                                                                                                                                                                                                                                                                     |
| Bottom sheet swipe-dismiss, detent dragging                            | As Android: first detent, drags between detents, `dismissOnSwipe` default true; `prototype_bottom_sheet_drag_v1`                                                                                                                                                                                                                                     |
| Built-in icons                                                         | `schemas/prototype-ios-icon-symbols.json` (reviewable: `ios/prototype-agent/ICON-SYMBOLS.md`); unmapped draw `questionmark.square`; `prototype_icon_sf_symbols_v1`                                                                                                                                                                                   |
| Icon node `variant`                                                    | See [Material components](#material-components)                                                                                                                                                                                                                                                                                                      |
| Feature                                                                | iOS simulator                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show`, `dismiss`, `status`, `awaitEvent`; fullscreen, floating, sheet | Supported                                                                                                                                                                                                                                                                                                                                            |
| Replace in place; `reset: true` starts fresh                           | Supported (`prototype_show_in_place_v1`)                                                                                                                                                                                                                                                                                                             |
| Element and bounds anchors                                             | Supported, in points (`prototype_anchor_v1`); [Anchors](#anchors)                                                                                                                                                                                                                                                                                    |
| `pressScale`, motion, `visibleWhen`, state/actions, assets, fonts      | Supported                                                                                                                                                                                                                                                                                                                                            |
| Material component nodes, dialog, snackbar, pickers                    | Supported; [Material components](#material-components)                                                                                                                                                                                                                                                                                               |
| Reusable `components` / `use` (#11053)                                 | Host expands them before sending; the agent sees plain nodes                                                                                                                                                                                                                                                                                         |
| Hidden from `layer: "app"` observe screenshots                         | Supported (#10943, #10988); host restores after capture                                                                                                                                                                                                                                                                                              |
| `display` selector                                                     | Refused: a simulator has one screen                                                                                                                                                                                                                                                                                                                  |
| `window.layer: "app"`                                                  | Accepted and ignored silently: window level is fixed at alert + 1                                                                                                                                                                                                                                                                                    |
| `window.persistence: "device"`                                         | Refused: the agent dies with the app process                                                                                                                                                                                                                                                                                                         |
| `window.chrome` (#12064)                                               | Fullscreen only, `prototype_window_chrome_v1`; see [Dismiss control](#dismiss-control). Older agents keep the bar; explicit `none` is refused with a relaunch hint                                                                                                                                                                                   |
| `adaptive`                                                             | `prototype_adaptive_v1`; native width classes, Material-styled drawing under every design (see Adaptive layouts).                                                                                                                                                                                                                                    |
| `window.backdrop` (#15126)                                             | `prototype_backdrop_v1`; SwiftUI `Material` behind the window (an authored `blur` picks the nearest of ultraThin 8, thin 16, regular 24, thick 40), Liquid Glass for `glass` on iOS 26+; under Reduce Transparency or an older OS the tonal fill (`tint` or `surfaceContainer` at 85%) is drawn and `lastResult.backdrop` is `fallback`, else `blur` |
| `inspect`                                                              | `prototype_inspect_v1`; [Inspect](#inspect)                                                                                                                                                                                                                                                                                                          |
| Idle TTL, dismissal on host disconnect                                 | [Expiry](#expiry)                                                                                                                                                                                                                                                                                                                                    |
| Per-mode colours/images, gradients, role scrims (#11220)               | `prototype_theme_modes_v1`; [Light and dark values](#light-and-dark-values)                                                                                                                                                                                                                                                                          |
| Appearance override/inference/live re-theme (#11222)                   | `prototype_appearance_v1`; [Appearance](#appearance)                                                                                                                                                                                                                                                                                                 |
| Bottom sheet above the keyboard                                        | [Bottom sheet and the keyboard](#bottom-sheet-and-the-keyboard)                                                                                                                                                                                                                                                                                      |
| Style `weight`, min/max sizes, `aspectRatio` (#11543)                  | `PrototypeSizing`, Android's order (bounds, `width`/`height`, aspect ratio); see below                                                                                                                                                                                                                                                               |
| Data model (#11673)                                                    | `prototype_data_model_v1`; [Data model capability](#data-model-capability)                                                                                                                                                                                                                                                                           |
| Data actions (#12519)                                                  | `prototype_data_actions_v1`; [Data actions capability](#data-actions-capability)                                                                                                                                                                                                                                                                     |
| Storage (#12522)                                                       | `prototype_storage_v1`; [Storage capability](#storage-capability)                                                                                                                                                                                                                                                                                    |
| Request action (#12529)                                                | `prototype_network_v1` / `prototype_network_device_v1`; [Request action capability](#request-action-capability)                                                                                                                                                                                                                                      |
| [Patch (#11675)](../android/prototype-ux.md#patch-11675)               | `prototype_patch_v1`: `/data`, `/state`, `replaceNode` in place (`PrototypeSession.patch`)                                                                                                                                                                                                                                                           |
| Non-scalar state (`null`, array, object)                               | Refused at `show` (state is string, number or boolean)                                                                                                                                                                                                                                                                                               |
| Foreground scoping to the shown-over app                               | Not needed: backgrounding the app hides its window                                                                                                                                                                                                                                                                                                   |
| Accessibility identifier fallback (`node.id`)                          | Only `testTag` (and `<testTag>.<part>`); `prototype_identifier_test_tag_only_v1`                                                                                                                                                                                                                                                                     |
| Bottom sheet swipe-dismiss, detent dragging                            | As Android: first detent, drags between detents, `dismissOnSwipe` default true; `prototype_bottom_sheet_drag_v1`                                                                                                                                                                                                                                     |
| Built-in icons                                                         | `schemas/prototype-ios-icon-symbols.json` (reviewable: `ios/prototype-agent/ICON-SYMBOLS.md`); unmapped draw `questionmark.square`; `prototype_icon_sf_symbols_v1`                                                                                                                                                                                   |
| Icon node `variant`                                                    | See [Material components](#material-components)                                                                                                                                                                                                                                                                                                      |
| Feature                                                                | iOS simulator                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------                                                                                                                                                                                   |
| `show`, `dismiss`, `status`, `awaitEvent`; fullscreen, floating, sheet | Supported                                                                                                                                                                                                                                                                                                                                            |
| Replace in place; `reset: true` starts fresh                           | Supported (`prototype_show_in_place_v1`)                                                                                                                                                                                                                                                                                                             |
| Element and bounds anchors                                             | Supported, in points (`prototype_anchor_v1`); [Anchors](#anchors)                                                                                                                                                                                                                                                                                    |
| `pressScale`, motion, `visibleWhen`, state/actions, assets, fonts      | Supported                                                                                                                                                                                                                                                                                                                                            |
| Material component nodes, dialog, snackbar, pickers                    | Supported; [Material components](#material-components)                                                                                                                                                                                                                                                                                               |
| Reusable `components` / `use` (#11053)                                 | Host expands them before sending; the agent sees plain nodes                                                                                                                                                                                                                                                                                         |
| Hidden from `layer: "app"` observe screenshots                         | Supported (#10943, #10988); host restores after capture                                                                                                                                                                                                                                                                                              |
| `display` selector                                                     | Refused: a simulator has one screen                                                                                                                                                                                                                                                                                                                  |
| `window.layer: "app"`                                                  | Accepted and ignored silently: window level is fixed at alert + 1                                                                                                                                                                                                                                                                                    |
| `window.persistence: "device"`                                         | Refused: the agent dies with the app process                                                                                                                                                                                                                                                                                                         |
| `window.chrome` (#12064)                                               | Fullscreen only, `prototype_window_chrome_v1`; see [Dismiss control](#dismiss-control). Older agents keep the bar; explicit `none` is refused with a relaunch hint                                                                                                                                                                                   |
| `inspect`                                                              | `prototype_inspect_v1`; [Inspect](#inspect)                                                                                                                                                                                                                                                                                                          |
| Idle TTL, dismissal on host disconnect                                 | [Expiry](#expiry)                                                                                                                                                                                                                                                                                                                                    |
| Per-mode colours/images, gradients, role scrims (#11220)               | `prototype_theme_modes_v1`; [Light and dark values](#light-and-dark-values)                                                                                                                                                                                                                                                                          |
| Appearance override/inference/live re-theme (#11222)                   | `prototype_appearance_v1`; [Appearance](#appearance)                                                                                                                                                                                                                                                                                                 |
| Bottom sheet above the keyboard                                        | [Bottom sheet and the keyboard](#bottom-sheet-and-the-keyboard)                                                                                                                                                                                                                                                                                      |
| Style `weight`, min/max sizes, `aspectRatio` (#11543)                  | `PrototypeSizing`, Android's order (bounds, `width`/`height`, aspect ratio); see below                                                                                                                                                                                                                                                               |
| Style `effects` (#15130, not device-verified)                          | `prototype_effects_v1`; [Style effects](#style-effects)                                                                                                                                                                                                                                                                                              |
| Data model (#11673)                                                    | `prototype_data_model_v1`; [Data model capability](#data-model-capability)                                                                                                                                                                                                                                                                           |
| Data actions (#12519)                                                  | `prototype_data_actions_v1`; [Data actions capability](#data-actions-capability)                                                                                                                                                                                                                                                                     |
| Storage (#12522)                                                       | `prototype_storage_v1`; [Storage capability](#storage-capability)                                                                                                                                                                                                                                                                                    |
| Request action (#12529)                                                | `prototype_network_v1` / `prototype_network_device_v1`; [Request action capability](#request-action-capability)                                                                                                                                                                                                                                      |
| [Patch (#11675)](../android/prototype-ux.md#patch-11675)               | `prototype_patch_v1`: `/data`, `/state`, `replaceNode` in place (`PrototypeSession.patch`)                                                                                                                                                                                                                                                           |
| Non-scalar state (`null`, array, object)                               | Refused at `show` (state is string, number or boolean)                                                                                                                                                                                                                                                                                               |
| Foreground scoping to the shown-over app                               | Not needed: backgrounding the app hides its window                                                                                                                                                                                                                                                                                                   |
| Accessibility identifier fallback (`node.id`)                          | Only `testTag` (and `<testTag>.<part>`); `prototype_identifier_test_tag_only_v1`                                                                                                                                                                                                                                                                     |
| Bottom sheet swipe-dismiss, detent dragging                            | As Android: first detent, drags between detents, `dismissOnSwipe` default true; `prototype_bottom_sheet_drag_v1`                                                                                                                                                                                                                                     |
| Built-in icons                                                         | `schemas/prototype-ios-icon-symbols.json` (reviewable: `ios/prototype-agent/ICON-SYMBOLS.md`); unmapped draw `questionmark.square`; `prototype_icon_sf_symbols_v1`                                                                                                                                                                                   |
| Icon node `variant`                                                    | See [Material components](#material-components)                                                                                                                                                                                                                                                                                                      |
| Feature                                                                | iOS simulator                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------                                                                                                                                                                                   |
| `show`, `dismiss`, `status`, `awaitEvent`; fullscreen, floating, sheet | Supported                                                                                                                                                                                                                                                                                                                                            |
| Replace in place; `reset: true` starts fresh                           | Supported (`prototype_show_in_place_v1`)                                                                                                                                                                                                                                                                                                             |
| Element and bounds anchors                                             | Supported, in points (`prototype_anchor_v1`); [Anchors](#anchors)                                                                                                                                                                                                                                                                                    |
| `pressScale`, motion, `visibleWhen`, state/actions, assets, fonts      | Supported                                                                                                                                                                                                                                                                                                                                            |
| Material component nodes, dialog, snackbar, pickers                    | Supported; [Material components](#material-components)                                                                                                                                                                                                                                                                                               |
| Reusable `components` / `use` (#11053)                                 | Host expands them before sending; the agent sees plain nodes                                                                                                                                                                                                                                                                                         |
| Hidden from `layer: "app"` observe screenshots                         | Supported (#10943, #10988); host restores after capture                                                                                                                                                                                                                                                                                              |
| `display` selector                                                     | Refused: a simulator has one screen                                                                                                                                                                                                                                                                                                                  |
| `window.layer: "app"`                                                  | Accepted and ignored silently: window level is fixed at alert + 1                                                                                                                                                                                                                                                                                    |
| `window.persistence: "device"`                                         | Refused: the agent dies with the app process                                                                                                                                                                                                                                                                                                         |
| `window.chrome` (#12064)                                               | Fullscreen only, `prototype_window_chrome_v1`; see [Dismiss control](#dismiss-control). Older agents keep the bar; explicit `none` is refused with a relaunch hint                                                                                                                                                                                   |
| `inspect`                                                              | `prototype_inspect_v1`; [Inspect](#inspect)                                                                                                                                                                                                                                                                                                          |
| Idle TTL, dismissal on host disconnect                                 | [Expiry](#expiry)                                                                                                                                                                                                                                                                                                                                    |
| Per-mode colours/images, gradients, role scrims (#11220)               | `prototype_theme_modes_v1`; [Light and dark values](#light-and-dark-values)                                                                                                                                                                                                                                                                          |
| Appearance override/inference/live re-theme (#11222)                   | `prototype_appearance_v1`; [Appearance](#appearance)                                                                                                                                                                                                                                                                                                 |
| Bottom sheet above the keyboard                                        | [Bottom sheet and the keyboard](#bottom-sheet-and-the-keyboard)                                                                                                                                                                                                                                                                                      |
| Style `weight`, min/max sizes, `aspectRatio` (#11543)                  | `PrototypeSizing`, Android's order (bounds, `width`/`height`, aspect ratio); see below                                                                                                                                                                                                                                                               |
| Node `keyframes`                                                       | `prototype_keyframes_v1`, iOS 17+; [One-shot keyframes](../android/prototype-ux.md#one-shot-keyframes), native tracks, alpha-only reduced motion                                                                                                                                                                                                     |
| Style `effects` (#15128)                                               | Contract only; not advertised (`prototype_effects_v1`), so the host refuses it                                                                                                                                                                                                                                                                       |
| Device media items, `imageAsset.data` (#14192)                         | Contract only; not advertised (`prototype_platform_media_items_v1`), so the host refuses it. The device store follows                                                                                                                                                                                                                                |
| Data model (#11673)                                                    | `prototype_data_model_v1`; [Data model capability](#data-model-capability)                                                                                                                                                                                                                                                                           |
| Data actions (#12519)                                                  | `prototype_data_actions_v1`; [Data actions capability](#data-actions-capability)                                                                                                                                                                                                                                                                     |
| Storage (#12522)                                                       | `prototype_storage_v1`; [Storage capability](#storage-capability)                                                                                                                                                                                                                                                                                    |
| Request action (#12529)                                                | `prototype_network_v1` / `prototype_network_device_v1`; [Request action capability](#request-action-capability)                                                                                                                                                                                                                                      |
| [Patch (#11675)](../android/prototype-ux.md#patch-11675)               | `prototype_patch_v1`: `/data`, `/state`, `replaceNode` in place (`PrototypeSession.patch`)                                                                                                                                                                                                                                                           |
| Non-scalar state (`null`, array, object)                               | Refused at `show` (state is string, number or boolean)                                                                                                                                                                                                                                                                                               |
| Foreground scoping to the shown-over app                               | Not needed: backgrounding the app hides its window                                                                                                                                                                                                                                                                                                   |
| Accessibility identifier fallback (`node.id`)                          | Only `testTag` (and `<testTag>.<part>`); `prototype_identifier_test_tag_only_v1`                                                                                                                                                                                                                                                                     |
| Bottom sheet swipe-dismiss, detent dragging                            | As Android: first detent, drags between detents, `dismissOnSwipe` default true; `prototype_bottom_sheet_drag_v1`                                                                                                                                                                                                                                     |
| Built-in icons                                                         | `schemas/prototype-ios-icon-symbols.json` (reviewable: `ios/prototype-agent/ICON-SYMBOLS.md`); unmapped draw `questionmark.square`; `prototype_icon_sf_symbols_v1`                                                                                                                                                                                   |
| Icon node `variant`                                                    | See [Material components](#material-components)                                                                                                                                                                                                                                                                                                      |

### Adaptive layouts

`adaptive` uses `horizontalSizeClass`: regular selects split/sidebar/inspector and compact selects stack/bottom bar/sheet. Every design draws Material-styled containers in SwiftUI; native `NavigationSplitView`, sidebar-adaptable `TabView` and `.inspector` await #15255. Pure Core types map width to mode and clear compact list selection to an empty string on Back.

`listDetail` requires `list`, `detail`, and a declared string `selectionKey`. `navigationSuite` requires 1–8 unique `{value,label}` items, a declared string `stateKey` naming an item, and `content`. `supporting` requires `main`, `supporting`, and a declared boolean `openKey`. Slots are ordinary node subtrees. Android uses its expanded pane rule and compact/medium/expanded navigation classes; no shared breakpoint or `minWidth` exists, and show reports the difference in `platformNotes`.

Sizing details (not device-verified): a `weight` takes exactly its share of a `row`/`column` main axis
and beats that axis's size and bounds (ignored outside a row/column); `min` wins when it exceeds `max`;
content on an axis with no authored size (or `wrap`) is centred in the box a min bound grew
(`wrapContentWidth()`/`wrapContentHeight()`), while explicit `width`/`height`/`fill` keeps alignment;
weighted stacks mirror under RTL via SwiftUI Layout; sizes are fractional points.

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
  its [Effects](../android/prototype-ux.md#effects-15128-15129-prototype_effects_v1-not-device-verified)
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
  it). Decision on the open question: the shader-sampled effects (`pixelate`, `chromaticAberration`,
  `wave`, `ripple`) are omitted on a node that is or holds such a view, not on the whole spec; `blur`
  and the over-the-content effects still draw. The show reply and `get_prototype_status` /
  `inspect_prototypes` list each omitted effect in `degradedEffects` as `{path, type, reason:
  "platform"}`. `path` is `<node position>.style.effects[<authored index>]` with the node's position in
  the shown tree (`root`, `root.children[1]`, `root.child`, `root.screens["home"]`); `repeat` rows are
  already expanded there, so a row has a plain `children[k]` path where Android's has
  `repeat[<key>]`. Nodes whose `visibleWhen` fails and inactive stack screens are skipped, as on
  Android. A `blur` or displacement is clipped to the node's bounds.
- **Owed device checks.** Simulator goldens against Android within a tolerance (the simulator forwards
  Metal to the host GPU and is not pixel-exact), and which node types really draw the placeholder.

## Open decisions

All decided (2026-10-09); the remaining item is simulator verification. `inspect` maps to `get_prototype_status`; a bottom sheet lifts above the
keyboard from keyboard-frame notifications (simulator check still owed); `window.layer: "app"` is
ignored silently so one spec runs on both platforms.

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
([Lifecycle and safety](../android/prototype-ux.md#lifecycle-and-safety)).

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

## How it works

1. `ios/prototype-agent/` builds a simulator-only dylib, ad-hoc signed (no Developer ID,
   notarization or provisioning, since it only loads into simulator processes).
2. The app is launched with `simctl launch` and `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` pointing at the
   dylib (`simctl` strips the `SIMCTL_CHILD_` prefix), so dyld loads it before `main()`.
3. The agent adds a SwiftUI `UIWindow` at level `.alert + 1`, above the app's windows, rendering the
   shared spec.
4. The window's `hitTest` returns `nil` outside the prototype content, so touches pass through;
   floating cards leave the app usable.
5. The agent listens on loopback (`127.0.0.1`) TCP and speaks the CtrlProxy prototype messages
   (`show_prototype`, `dismiss_prototype`, `put_prototype_asset`, `prototype_result`,
   `prototype_event`) as newline-delimited JSON. There is no `update_prototype` (#10490): a
   `show_prototype` with the shown id replaces in place.
6. Each launch gets its own port and random token (`AUTOMOBILE_PROTOTYPE_PORT`,
   `AUTOMOBILE_PROTOTYPE_TOKEN`, token at least 16 chars; the agent does not start without both). The
   first frame must be a `hello` carrying the token; the agent replies with version and capabilities.

The window lives in the app's process, so `observe`, `tapOn`, `sendKeys`, screenshots and video all see
the prototype as app UI.

## Limits

- **Simulator only.** On devices, code signing blocks injection; use the in-app SDK route.
- **Only apps launched with the agent.** Injection happens at launch; enabling it for a running app
  means relaunching (losing in-memory state). Apps started otherwise (home screen, plain `launchApp`,
  Xcode) have no agent unless set up as below.
- SpringBoard and system UI are not covered. Prototypes vanish when the app exits or relaunches
  without the agent.
- **Structural limits re-checked.** The agent refuses a spec whose expanded tree passes node (2000),
  depth (24) or `repeat` item (128) limits of `schemas/prototype-spec-contract.json` before expanding
  (#11049).
- **Every state write is validated.** Taps, control writes, text typing and `setStates` go through one
  `PrototypeStateValidator` with Android's binding rules; a rejected interaction changes and emits
  nothing (#11408, #11551, #11562). A rejected edit redraws the field with the accepted text. Android
  versions field text (`textEpochs`); the iOS field binds live state on the main actor, so no stale
  in-flight edit exists.
- **Spec byte cap (differs from Android).** Android re-encodes the whole spec after each write and
  rejects over `MAX_PROTOTYPE_SPEC_BYTES` (1 MiB UTF-8). The agent keeps no raw bytes: it measures the
  spec outside `state` once from the `show_prototype` request's `spec` (re-serialized, whitespace not
  counted) and adds the candidate state's JSON size per write. `Spec byte limit exceeded` therefore
  matches up to a few bytes of encoder difference. Sessions built without a request (unit tests) count
  state alone.

## Entry point: `launchApp { prototype: true }`

The intended entry point (#10567) on an iOS simulator: resolves the dylib, allocates port and token,
launches with `SIMCTL_CHILD_*`, and records the agent against device and bundle id so `prototype` can
connect. A normal `launchApp` injects nothing; an existing `DYLD_INSERT_LIBRARIES` is preserved. On a
physical device the option fails with a simulator-only error. If `prototype` targets an app not
launched this way it fails with a relaunch hint instead of relaunching (that would lose state).

## Where the dylib comes from

Resolution order (#10565): explicit path; `AUTOMOBILE_IOS_PROTOTYPE_AGENT` (local build); local build
output; checksum-verified release download cached under `~/.auto-mobile/prototype-agent/`. With no
pinned checksum for the running build the client reports the agent unavailable rather than use
unverified bytes. `AUTOMOBILE_SKIP_IOS_PROTOTYPE_AGENT_DOWNLOAD` disables the download.

## Apps launched from Xcode

AutoMobile does not launch these, so edit the scheme (Run > Arguments > Environment Variables):

1. `DYLD_INSERT_LIBRARIES` = absolute dylib path (cached file or the `AUTOMOBILE_IOS_PROTOTYPE_AGENT`
   build). In a scheme the variable is unprefixed; `SIMCTL_CHILD_` applies only to `simctl launch`.
2. `AUTOMOBILE_PROTOTYPE_PORT` and `AUTOMOBILE_PROTOTYPE_TOKEN` (at least 16 chars), with values you
   also give the client.
3. Use a **simulator** destination only; never device or archive/release configurations.

## Differences from Android

- Successful shows report affected paths in `platformNotes` for identifier fallback, sheet
  swipe-dismiss/detents, unmapped icons and substituted icon variants.
- Numbers in `{key}` text and `repeat` bindings render as the host's `renderScalar` does
  (`PrototypeScalarText`): integral values as exact plain digits (`-0` is `0`), others as JS
  `String(number)`.
- `prototype` has no `showVariants` and no `update` action. A same-id show updates in place keeping
  each pager's page; `reset: true` starts fresh (`prototype_show_in_place_v1`; host refuses `reset` on
  older agents). For a variant carousel, compose the spec yourself.
- No `display`, no `persistence: "device"`; `layer: "app"` ignored.
- Owner decisions of 2026-10-26 (#15244, full list in `prototype-ux.md`, Owner decisions): `theme.design`
  defaults to `platform` (native SwiftUI controls where covered; segmented `Picker`, `TabView` and `Menu`
  keep the custom drawing because they lose per-item identifiers); an `android: {...}` namespace block is
  ignored with a `platformNotes` entry; system Reduce Motion and `prefersCrossFadeTransitions` map to the
  reduced motion profile (crossfades), superseding the "instant" wording in Motion; iOS reports only the
  horizontal size class (compact, regular).
- `inspect` reports the single prototype, with no `suspended` and no `deviceDroppedEvents`.
- SwiftUI in the app's process rather than Compose in CtrlProxy; no accessibility service.
- Android reaches any app through CtrlProxy; iOS only apps launched with the agent.

## Inspect

`inspect` (#10494) adopts the device's prototypes into host `status`/`awaitEvent` state after a session
release or daemon restart. On iOS the host sends `get_prototype_status` and adopts the reply: `id`,
`state`, `pages`, `lastSequence` (the agent's event ledger, so the host resumes past it) and
`persistent: false`; also `visible` (window on screen), which the host does not surface. No
`suspended`, offline replay or `deviceDroppedEvents`. A host-listed prototype the agent no longer shows
is dropped. The agent advertises `prototype_inspect_v1`; without it the host refuses `inspect` before
sending anything and asks to relaunch with `launchApp { prototype: true }`.

## Native presentations and touches (#15463)

A native presentation (`.sheet`, `.alert`, `.confirmationDialog`, `.popover`) presented from the
overlay window's root lives in the prototype window, but no prototype hit rect covers it, so
`PassthroughWindow.hitTest` also claims touches for it, computed at hit time from the presented
controller (`PrototypeNativePresentationHitRegion`). A modal presentation claims the whole window,
so an outside tap dismisses it; a sheet whose selected detent is at or below
`largestUndimmedDetentIdentifier` (`presentationBackgroundInteraction`) claims only its own frame and
lets other touches reach the app. Menus use a system window and need no claim. Not yet
device-verified.

## Bottom sheet and the keyboard

Matches [Android](../android/prototype-ux.md#bottom-sheet-and-the-keyboard-10262): a `sheet` with
`edge: "bottom"` (or none) moves above the software keyboard while shown and returns when it hides.
Fullscreen, floating and top sheets never move. Not yet verified on a simulator.

- **Source.** `keyboardWillChangeFrame` / `keyboardWillHide` in the app's process. The lift is how far
  the keyboard's end frame reaches into the prototype window (`PrototypeKeyboardLift.amount`, UIKit-free
  core): 0 for a hardware or hidden keyboard, never more than the window.
- **No double lift (#11042).** The lift is the only thing that moves for the keyboard. Both hosting
  controllers set `safeAreaRegions` to none (`PrototypeKeyboardLift.hostSafeAreaRegions`) and the root
  ignores every safe-area region. On an iOS 26.5 simulator `ignoresSafeArea(.keyboard)` alone still moved
  a 300 pt sheet 527 pt for a 334 pt lift. Core tests pin sheet bottom == keyboard top, including a
  window with non-zero origin and shorter height.
- **Native presentations (#15464).** While a native presentation (`.sheet`, `.popover`) is up from the
  overlay window's root, the lift is 0: UIKit's presentation controller already avoids the keyboard, so
  the agent's lift would stack on it. Not yet device-verified.
- **Touch and clip.** Content is padded up by the lift inside its full-window frame, so the touch rect
  moves with it; the anchor layer's clip uses the same lift (`PrototypeSheetFrame.rect(lift:)`).
- **Motion.** Keyboard duration, ease-in-out (UIKit's keyboard curve is private); instant under
  `motion: "none"` or Reduce Motion (`PrototypeKeyboardLift.animationDuration`).

## Light and dark values

Advertised as `prototype_theme_modes_v1` (#11220). Rules are Core's (`PrototypeModeValue`,
`PrototypePalette`, `PrototypeGradient`, `PrototypeThemeModes`), covered by `swift test`; drawing is not
device-verified. One mode is resolved per shown prototype ([Appearance](#appearance)).

- **Colours.** Every slot takes a hex, a role name, or `{light, dark}` (each side hex or role):
  `style.background`, `style.color`, `style.shadowColor`, `style.shadows[].color`, `style.border.color`, `style.border.gradient` stops, `image.filter.tint`, a `styleWhen` style,
  gradient stops, `window.placement.scrim`, bottomSheet `scrim`. A pair picks its side then resolves
  like a single value (a role comes from the resolved mode's scheme).
- **Theme role maps.** Scheme order: baseline Material scheme for the mode, seed scheme, flat
  `theme.colors.<role>` overrides (both modes), then `theme.colors.light|dark` for the resolved mode. A
  mode map never takes part in choosing the mode. Unknown top-level `theme.colors` keys are ignored and
  logged once per show.
- **Gradients.** `style.gradient` paints over `background`, under content, inside the corner shape.
  Linear angle is degrees clockwise from left-to-right (90 = top to bottom), through the centre and long
  enough that corners take the first/last stop; radial starts at the centre and reaches the corners.
  Positions apply only if every stop has one (made non-decreasing); else stops spread evenly. `card` and
  `topAppBar` drop their default container when a gradient is set.
- **Scrims.** `window.placement.scrim` and bottomSheet `scrim` resolve through
  `PrototypePalette.scrim` (owner decision 2026-10-10); a sheet without `scrim` draws the `scrim` role
  at that 40% like Android's default (`sheetScrim`, #15117). Only the `scrim` role gets alpha: 40%
  (`PrototypePalette.scrimRoleAlpha`, Android's `PROTOTYPE_SHEET_SCRIM_ALPHA`), because the role is
  opaque black. Other roles draw unchanged; hex keeps authored alpha; outside scrim slots the role is the
  plain colour. An authored sheet `scrim` takes the touches it covers; a tap closes the sheet by writing
  `!equals` to its `openWhen` key.
- **Differences from Android.** The scrim covers the sheet node's own frame behind the surface (and
  its safe areas), not the whole window when the sheet is nested (the sheet draws in place rather than
  hoisted). A `button` keeps its system fill, covering a gradient behind it.
- **Images.** `image.asset` and `tabBar`/`bottomNav` item `image` take an id or `{light, dark}`; the
  resolved id is drawn. Nav items draw the image at 24 pt if uploaded, else `icon`, else a placeholder
  square. Both ids of a pair appear in `missingAssets` until uploaded.
- **Malformed values** fail `show_prototype` with `Invalid prototype spec: <path>: ...` and leave the
  shown prototype untouched: a pair not exactly `{light, dark}` strings, a bad side/stop/scrim, an empty
  id in an image pair, unknown gradient type, linear without angle, fewer than 2 or more than 4 stops,
  position outside 0..1, or a non-`{role: hex}` `theme.colors.light|dark`. Shared invalid fixtures all
  fail on iOS (`PrototypeThemeModesTests`). Host-only: the image-count limit, and a single unknown value
  in a pre-existing slot (draws that slot's fallback).

## Appearance

Advertised as `prototype_appearance_v1` (#11222). Rules are Core's (`PrototypeAppearance`,
`PrototypeSession`); the UIKit side is not device-verified.

**Resolution order** (same as Android, #11215 D4); the first that applies decides the mode and the
reported `source`:

| Step | Decides                                                      | `source`             |
| ---- | ------------------------------------------------------------ | -------------------- |
| 1    | `theme.mode` `light` or `dark`                               | `explicit`           |
| 2    | Luminance of flat `theme.colors.background` (else `surface`) | `roleLuminance`      |
| 3    | First opaque authored background on the root's leading chain | `authoredBackground` |
| 4    | System setting: show's `appearance` when `light`/`dark`      | `override`           |
|      | else the simulator's appearance                              | `system`             |

The override replaces only the simulator's setting; it never beats the spec (a no-mode spec with a
white root shown with `appearance: "dark"` is light, `authoredBackground`). `theme.mode: "system"`
skips steps 2 and 3. Dark means luminance below 0.179.

- **Authored background** (step 3, Android's `prototypeAuthoredTheme`). The leading chain is root, then
  its first visible child, etc.; a pager continues into its current page, a single-child node into
  `child`; `visibleWhen`-hidden nodes are skipped. Background = node style with matching `styleWhen`
  merged. Only a single hex with alpha >= 0.99 decides; roles and `{light, dark}` pairs are skipped.
  `theme.colors.light|dark` never participate. Unlike Android, the inferred background is not painted
  over the scheme's surface roles.
- **Override.** Request-level `appearance`: `device` (default), `light`, `dark`; scoped to that show.
  Other values fail with `appearance: Expected device, light or dark`. The simulator itself is not
  changed.
- **One mode for everything.** `PrototypeSession.appearance` (from spec, state/pages, override,
  simulator) drives the palette, host chrome, scrims, per-mode colours/images, SwiftUI `colorScheme` and
  the window's UIKit trait. A state change that moves the inferred background moves all together.
- **UIKit trait.** The window's `overrideUserInterfaceStyle` is the resolved mode (so keyboards and
  dynamic `UIColor`s match). Because it is overridden, the simulator appearance is read from the window
  scene's trait collection; the agent does not adopt an app window's own override (#11215 Q1).
- **Live re-theme and event.** The agent observes `UITraitUserInterfaceStyle` on the window scene and
  re-resolves keeping state and pages. Each resolved-mode change pushes exactly one `prototype_event`
  `kind: "appearance_changed"`, `name: null`, `payload: {mode, source}` (following the causing `change`
  or `page_changed`, `PrototypeSession.transition`). No event when the mode is unchanged, for the show
  itself, or with nothing shown.
- **Report.** A successful show result and `get_prototype_status` carry
  `appearance: {mode, source, deviceDark}` (`deviceDark` = simulator appearance regardless of what
  decided). The host's `status` action is host-local and reports only `mode` and `source`, since a
  pinned mode sends no event when the appearance flips (#11416). No `appearance` while nothing is shown.

## Anchors

Node anchors (#9316) work as on [Android](../android/prototype-ux.md#anchors), in points. The host
resolves each element anchor once at show against a fresh hierarchy of the app alone (the agent's own
window is excluded: found by the root `automobile-prototype-window` marker for chromeless fullscreen,
else by the dismiss control) and sends a bounds anchor. iOS hierarchy bounds are already points, so no
density conversion occurs; `anchors[].boundsPx` and `bounds` carry the same values. The host sends
anchors only to agents advertising `prototype_anchor_v1` and otherwise refuses the show (relaunch hint);
the agent refuses an unresolved element anchor.

Anchored nodes are drawn in a window-level layer above the spec tree (above its modal for a node in a
dialog), so a parent neither reserves a slot nor clips, and touch target and accessibility frame are
where drawn. A node is placed at its anchor rect less the layer's screen origin (window origin plus
layer position). Fullscreen `chrome: "none"`: layer starts at window top, no shift. `chrome: "bar"`:
layer sits below the bar, anchors shift up by the bar and one under the bar is clipped. `cover` sizes to
the bounds ignoring authored width/height; edges keep node size, align that edge, centre on the other
axis; `start`/`end` follow layout direction; `offset` applies last in screen axes. Only the root of a
floating prototype may be anchored (the layer places it; the rest of the screen stays touchable).
Anchors are resolved once and do not follow scrolling.

## Material components

Every component node of the shared vocabulary (#10439) is drawn in SwiftUI with Android's behavior: tap/
pick/drag effects, `change` events, and `<testTag>.<part>` identifiers. Tap semantics live in the
UIKit-free core (`PrototypeComponents.swift`), so the `simulate_tap` test hook performs the same
transition as a real tap, including on part identifiers.

| Node                            | iOS drawing                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `switch`, `checkbox`            | One toggle element with SwiftUI-drawn track (no `UISwitch`); checkbox is a button that reads as selected                 |
| `button`                        | `.borderedProminent` filled, `.bordered` tonal/outlined/elevated, `.borderless` text; optional leading SF Symbol         |
| `slider`                        | `Slider` with `step` snapping, one adjustable element labelled by `label`                                                |
| `chip`                          | Rounded button; filter chip toggles its key and reads as selected                                                        |
| `card`                          | Rounded container: filled, elevated (shadow) or outlined                                                                 |
| `radioGroup`, `segmentedButton` | One button per option, identified `<testTag>.<value>`, selected trait (a segmented `Picker` can't carry per-segment ids) |
| `listItem`                      | One row element; toggle when it has a trailing switch/checkbox                                                           |
| `iconButton`, `fab`             | Labelled by `contentDescription`, a FAB's `label`, else the icon                                                         |
| `topAppBar`                     | Header title; `<testTag>.navigation` and `<testTag>.actions.<index>`                                                     |
| `divider`, `badge`, `progress`  | Hairline, dot/count capsule, determinate `ProgressView`/ring, indeterminate sweep                                        |
| `timePicker`, `datePicker`      | Wheel `DatePicker` (one `change` per edit), graphical `DatePicker` in UTC days                                           |
| `dialog`, `snackbar`            | Drawn above the author tree in the prototype window; `<testTag>.confirm`, `.dismiss`, `.action`                          |
| `tooltip`, `drawer`             | Hoisted bubble/spotlight or modal side panel; see [Tooltip and drawer overlays](#tooltip-and-drawer-overlays)            |

- **Dialog.** Its scrim covers the whole window (below the dismiss bar with `chrome: "bar"`) and takes
  every touch while open, even for floating/sheet placements; a snackbar takes touches only on itself.
  Title (header), text, child controls and buttons are separate accessibility elements. While open, the
  page behind (spec tree and anchor layer) is collapsed out of the accessibility tree, since
  `accessibilityHidden` alone did not keep it out of the XCUITest snapshot (#10899). The dialog is not
  marked modal (#10912). Otherwise each layer is its own accessibility container, so a one-element page
  reports that node at its own frame (#10898). Opening/closing a dialog drops keyboard focus unless it
  holds a text field; a child taller than the screen scrolls.
- **Icons.** Material names map to SF Symbols via `schemas/prototype-ios-icon-symbols.json` (minimum iOS
  17.0). Unmapped names draw `questionmark.square` in every icon slot. Filled/outlined `variant` uses
  that form where the table has one; otherwise, and for rounded/sharp/twoTone, the default symbol (often
  outlined; pass `variant: "filled"` for the closest Android match). Runtime lookup: chosen form, default
  symbol, then `questionmark.square`. Unknown names from host/agent skew draw no glyph (icon nodes draw
  their background/placeholder; nav items a placeholder square; other controls omit icon and spacing; a
  nav item with neither icon nor image keeps `.none`). Container variants on buttons remain container
  styles. The agent advertises `prototype_icon_sf_symbols_v1` and neither
  `prototype_icon_set_material_v1` nor `prototype_icon_variant_v1` (Material parity is a future option).
- **Snackbar** `durationMs` closes by writing `!equals` to its `openWhen` key (plain timer behind
  injectable `PrototypeClock`).
- **Stack transitions** advertise `prototype_stack_transitions_v1`. Stack `transition` defaults to
  `platform`; push/replace overrides take precedence. Platform and slide pushes enter from trailing
  over a 30% parallax-shifted outgoing screen; pop and pop-to-root reverse this, mirrored for RTL.
  Platform replace crossfades; explicit fade crossfades and none is instant. Animations use a
  fixed named 300 ms spatial and 150 ms effects timings; the motion-token table is not available. Spec `motion: "none"` is instant; the reduced profile (Reduce Motion
  or `motion: "reduced"`) maps every pattern to crossfade. Session-only change direction, transition and stable entry identities leave
  wire stack snapshots unchanged. Reload resets presentation without animation.
  `prototype_stack_patterns_v1` gates sharedAxisX/Y, fadeThrough, zoom and push/replace source.
  Shared axes compose 30-point directional travel with opacity (X mirrors in RTL; both reverse on
  pop). FadeThrough fades out first, then fades/scales in from 0.92. Zoom requires an action source
  naming exactly one authored sharedKey node inside the target stack's screens, exempt from visibility pairing. `prototype_zoom_transition_v1` advertises native source-to-root container zoom on Android and
  native interactive navigation zoom on iOS 18+. iOS 17 keeps platform push; older Android agents
  keep fadeThrough. The new capability reports rendering only; patterns v1 remains the authoring gate. `platformNotes`
  reports OS/capability fallbacks and non-interactive sharedAxisX/Y and fadeThrough pops.
  A simultaneous drag beginning within 20 points of the leading window edge scrubs platform and slide,
  including parallax and dimming. Release commits past half width or when predicted end translation
  passes half width; otherwise it animates back without mutating the session. Fade/none retain the
  60-point release-to-pop policy; composed patterns do too; iOS 18 native zoom owns its interactive pop while a native destination is present, including composed screens above it. A native pop removes that destination and its composed segment from the model. Replacing the root resets the native origin. Pop targeting follows visible screens and modal precedence.
  Back-stack entries stay mounted, transparent, non-interactive and accessibility-hidden, preserving
  scroll positions on pop within the bounded stack depth; removed entries are released after motion.
  Navigation posts a screen-changed accessibility notification targeting the new native screen
  container after layout; accessibility escape uses the same animated pop path. Wrap a stack in a box
  to animate its own visibility.
- **Text content transitions.** Text nodes accept `contentTransition: "numeric" | "crossfade" | "none"` (default `none`). Non-`none` requires `prototype_content_transition_v1`. Numeric changes roll only changed characters up for an increase and down for a decrease; formatting is stripped to digits, the first decimal point and a leading minus. Missing or equal numeric values crossfade; identical text stays still. Spans crossfade as a whole. Roll uses a spring (Android damping 0.8, stiffness 380; iOS duration 0.35 s, bounce 0.15); fades take 200 ms. Accessibility and observe expose the new text immediately. Android reduced motion uses fades and motion off snaps; iOS content transitions snap under reduced motion or motion off.

- **Motion** matches Android (#10442, #10439): `visibleWhen` nodes fade/expand, `transition`
  (`none`, `fade`, `expand`, `slide`) picks the animation, pager changes animate. `box`/`row`/`column`
  animate size (`animateContentSize`) when a direct child appears, disappears or resolves a new
  width/height, scoped to `PrototypeNode.containerLayoutSignature` so typing does not animate. Motion runs
  in the three profiles of the Android design (`PrototypeMotion.profile`: `full`, `reduced`, `off`).
  Spec `motion: "none"` is instant. System Reduce Motion (`UIAccessibility.isReduceMotionEnabled`), the cross-fade preference
  (`prefersCrossFadeTransitions`, iOS 14+) and spec `motion: "reduced"` select
  `reduced`, never `off` (#15244; read through `PrototypeAccessibilityProviding`, faked in tests): `visibleWhen` transitions other than `none` become crossfades, container size, press
  scale and swipe-row settles snap, and progress indicators and shimmer rest, while alpha and color
  animations continue (`prototype_reduced_motion_v1`).
- **Shared elements** (`prototype_shared_element_v1` and `prototype_shared_element_v2`):
  `sharedKey` aliases `shared: {key, as: "bounds"}`; the object form and repeat templates require v2.
  Two `visibleWhen` nodes use `matchedGeometryEffect(properties: .frame, isSource:)` in one
  `@Namespace` per hosting root, under `full` only. `PrototypeSharedElementPlan` selects frame
  matching for `element` and frame matching plus a crossfade for `bounds`. Both kinds crossfade
  under `reduced` and swap under `off`. Repeat children bind `story-{item.id}` only with
  `repeat.key: "id"`; resolved keys must be unique per side. Unmatched feed items render normally
  and count toward the spec-wide limit of 16 resolved keys.
  Pairs cannot nest or cross dialog/bottomSheet boundaries; a pair split across hosting roots
  (for example an anchored window layer) does not match geometry.
  The feed-card-to-detail-column spec in [Shared element morphs](../android/prototype-ux.md#shared-element-morphs-15115-prototype_shared_element_v1)
  is the worked example for both platforms: the repeated card's `story-{item.id}` resolves to
  the detail's `story-one`. Set both to `element` for identical hero content, or `bounds` for
  changing container content. Reduce Motion gives a crossfade; `motion: "none"` gives an instant swap.

### Dismiss control

The host's dismiss control (`automobile-prototype-dismiss`, "Dismiss prototype") cannot be removed by
the spec. Fullscreen defaults to `window.chrome: "none"` (`prototype_window_chrome_v1`, not yet
device-verified): content and anchors fill the window including under the status bar (use top-edge
`safeAreaPadding`). A host-owned two-finger ~1 s long press reveals a dismiss pill for 5 s (another hold
restarts the deadline; single-pointer gestures can't reveal it; revealing is not TTL activity). The
pill is permanently visible under VoiceOver/Switch Control, sits above modals, clears the top safe inset
and is never faded by `window.opacity`; VoiceOver's escape gesture dismisses directly. All exits
dismiss with reason `user`. Host dismiss, replacing show, authored dismiss, idle TTL and last-client
disconnect keep working; Back is not the exit. Not device-verified: the two-finger press, VoiceOver
escape, permanent assistive pill, opacity-0 escape and the `automobile-prototype-window` marker shape
(present only on the root of a chromeless fullscreen prototype; others are found by the dismiss control).
Sheet/floating chrome is unchanged (control at the window's top trailing corner). `lastResult.chrome`
reports the effective chrome.

With `chrome: "bar"` the control sits in a translucent 44 pt bar across the top (clears status bar and
cutout, follows the spec's theme) and the spec is laid out below it, so `safeAreaPadding` sees no top
inset.

See the [`prototype` tool reference](../../../tools.md#prototype).

Style contract fields `style.shadows`, `style.cornerStyle`, `style.border.gradient`,
`scroll.fadeEdges` and `image.filter` require `prototype_style_polish_v2`. The strict
validator accepts these fields and the agent advertises this capability. A shared corner
path clips content and paints backgrounds, gradients, shimmer, borders and shadows;
continuous full radii clamp to half the short side. Shadow layers paint in authored
order within the outer and inner groups, with inner shadows above the border. The
Canvas shadow-only filter avoids painting the spread source itself; its Gaussian
radius is half the authored CSS-like blur. Positive spread expands outer sources
and contracts inner holes. Scroll fades use iOS 17 geometry preferences to mask only
edges with remaining content, mirroring horizontal start/end in RTL; opposing fades
are capped at half the viewport. Image saturation precedes the palette-resolved tint.

## Strings and semantics capability

`prototype_strings_v1` supports string tables, plural `{t:key|count}` references and show `locale`;
`prototype_semantics_v1` supports node heading, liveRegion, group, label, hint and traits.
See [Strings and semantics](../android/prototype-ux.md#strings-and-semantics-14210) for resolution,
plural rules and platform mappings. iOS observe snapshots do not expose SwiftUI traits.

## Data model capability

Advertises `prototype_data_model_v1` for the shared
[data model contract](../android/prototype-ux.md#data-model-11673); the host refuses data-model shows on
an agent without it, before uploads or show. Core resolves bindings once per show: path repeats become
projected literal items, text placeholders scalar text, data conditions constants.

Decode order: guard data; refuse non-object authored children; two independent node budgets (ordinary
nodes and nonempty literal-repeat instances use the expanded budget; path-bound, empty or malformed
templates use the authored-template budget once) and depth limit; guard
`MAX_PROTOTYPE_REPEAT_PATH_CELLS` in container pre-order; check substituted text against the per-field
limit and the 4,194,304 UTF-16 rebuilt-text total per show (inside a repeat, a data-resolved field is
charged once per item even without repeat placeholders; literal fields and state placeholders are not
charged); refuse nested repeats; resolve with projected items cached per pointer; guard the resolved
tree; expand repeats. State placeholders are clamped to the shared UTF-16 substituted-text limit. State
interpolation then uses the ordinary expanded tree. `repeat.key` is accepted but rows keep positional
identity until keyed patching (#11675).

Data is agent-owned and read-only except via the data actions; inspect/status report it with state. Two
data keys that are canonically equivalent Unicode strings collapse on iOS (Swift dictionary keys compare
by canonical equivalence), unlike host and Android. The agent re-checks data depth/array limits in the
host's traversal order; the strict boundary also enforces the host data byte-cost rule.

## Data actions capability

Advertises `prototype_data_actions_v1` for `setData`, `appendData`, `prependData`, `removeData`
([contract](../android/prototype-ux.md#data-actions-12519)). `PrototypeRepeat` binds a whole `{index}`
path segment and `{item}`/`{index}` values per row at expansion, so row actions arrive concrete.
`PrototypeSession` resolves `{value}`/`{state}`/`{data}`, applies `PrototypeDataWrite` (twin of the
host's `applyPrototypeDataWrite`: codes `invalid_path`, `invalid_value`, `not_found`, `not_array`,
`limit_exceeded`; `MAX_PROTOTYPE_DATA_WRITE_BYTES`) and rebuilds the tree from the authored root with
`PrototypeSpec.replacingData`, so data text, repeat rows and conditions refresh. A write the tree can't
be rebuilt for within show limits is refused.

The shared prepend contract uses `prependData {path,value}` (one resolved row) and writer/event
`{op:"prepend",value:[row],maxItems?,revision}` at the written array path. It needs lazy-list,
data-actions and data-model capabilities. Rows retain input order at the front; the smallest
matching list cap trims from the end before final limits. Malformed pages/caps are dropped.
Renderers retain the first visible row key and offset across writes, including at the top
(headers/footers excluded); a trimmed key uses the renderer default. Stack entries preserve and
restore list anchors across push/pop, falling back to the nearest surviving index or top when the
row is gone. Prepend, anchoring and per-stack-entry list scroll restore are not device-verified
until the acceptance run.

A refused write changes and emits nothing and does not stop the rest of the action list. An accepted
write bumps the id's data revision (monotonic per id, never rewound by re-show; every show is one
revision, so the first reports 1 as on Android, #13040) and emits one `change` event named by the
written `/data/...` path (the array for an append) with payload `{op, value?, revision}`; extend/prepend values may be absent when over the emit byte budget, which abandons the host mirror. The counter is shared with `prototype_patch_v1` (#11675): device state writes and
accepted patches take the next revision too.

## Storage capability

Advertises `prototype_storage_v1` and the `clear_prototype_storage` request (#12526;
[contract](../android/prototype-ux.md#storage-12522)). Values live in the host app's sandbox at
`Application Support/AutoMobilePrototypeAgent/storage/<id>.json` (`FilePrototypeStorageStore`), never in
the app's files or `UserDefaults`; the viewer app uses the same code in its own sandbox. Writes are
atomic and the id is percent-encoded into the file name. A file that doesn't decode (or is far over the
byte limit) is logged, deleted and treated as empty.

`PrototypeStorageCoordinator` is the only code touching a `PrototypeStorageStore`.
`PrototypeModel.show` calls `prepare` first: `PrototypeStorageRestore` (twin of the host's
`restorePrototypeStorage`) applies precedence, deletes entries that no longer fit, and hands restored
state/data to `PrototypeSession.show(_:restoredState:)` before first draw (no `change` event, no data
revision bump). After each transition `sessionChanged` writes moved listed keys on a trailing 400 ms
debounce (injected `PrototypeClock`); dismissal, next show, `get_prototype_status` and app
background/end flush immediately. A write that would exceed `MAX_PROTOTYPE_STORAGE_BYTES` still applies
live, keeps the previous stored value and is listed in `skippedKeys`. `reset: true` does not clear
storage.

`get_prototype_status` (and standalone `inspect_prototypes`) carries
`storage: {version, keys: [{key, bytes}], totalBytes, skippedKeys?}` when the spec declares `storage`.
`clear_prototype_storage {id}` answers `cleared` (count of keys removed) and leaves the shown prototype.
The iOS saved prototype is its own app, so `deleteSaved` uninstalls it and its sandbox.

## Request action capability

Advertises `prototype_network_v1` and `prototype_network_device_v1` for `request`
([contract](../android/prototype-ux.md#request-action-12523)). `PrototypeSession` twins the host's
`applyPrototypeRequestOutcome`: a tap resolves bindings against committed state/data
(`PrototypeRequestResolver`, twin of `resolvePrototypeRequest`; `{key}` and `{data:/pointer}` bound in
one pass so substituted values are never rescanned), moves `statusKey` to `loading` and issues a start
command. `completeRequest` later writes `into`, then `<into>__meta` (dropping `headers` if over the data
write limit), moves the status key, emits the `prototype_request` event and runs `onSuccess`/`onError`
in that order. An unbuildable request (unresolvable binding, invalid URL) or a refused one
(`too_many_in_flight` at 4) completes at once as an error. A newer request to the same `into` cancels
the older: it writes nothing, leaves the status key, runs no follow-up and reports `cancelled`
(`durationMs` 0, the session has no clock). Dismissal, a replacing show of another prototype and `reset`
cancel all; a same-id replace keeps them.

`PrototypeRequestValidator` repeats the host's static rules at show (URL scheme, method, bodies on
GET/HEAD, `into` naming an object member, `statusKey` naming a declared string state key, header names,
entry counts, `timeoutMs` 1..30000, follow-up lists 1..32, reserved `prototype_request` emit name,
`MAX_PROTOTYPE_ACTION_DEPTH`); `PrototypeRepeat` binds `url`, `statusKey`, `into`, header/query strings,
binding objects and nested follow-up lists per row. Query entries are set in sorted key order (UTF-16
code units, like JS `sort()`) on every runtime (the Swift decoder holds `query` unordered, so the rule is
canonical), so the resolved URL and event `url` match the host. The query is edited on raw
`&`-separated pieces: a set key replaces its first piece in place (later duplicates removed), new keys
append, untouched pieces keep spelling (`flag`, `%20`). A string body without an author `Content-Type`
is `text/plain; charset=utf-8`; other JSON bodies `application/json`.

`PrototypeRequestDriver` runs what the session starts behind a clock and two seams (deterministic
tests):

- **`via: "host"` (default).** A `prototype_request` frame (`prototypeRequestMessageSchema`) goes to
  exactly one connection, the most recently authenticated (`PrototypeConnectionRegistry.current`, as
  Android's `WebSocketServer.sendToHost`), so a reconnecting daemon replaces its predecessor and a
  side-effecting call never runs twice (events still broadcast). Each pending call remembers its owning
  connection (`PrototypeHostRouting`); when it closes its calls end as `network` even if an older
  connection remains. The host's `prototype_response` arrives as an ordinary request line routed to the
  driver, never replied to. When the device drops a host call (superseded, dismissed, reset, timed out)
  it sends `{"type":"prototype_request_cancel","requestId"}` to the owner (skipped if gone); the host
  aborts the fetch, frees its slot, sends no reply and ignores a late response. A silent host ends as
  `timeout` after `timeoutMs` + 2 s; no connected host, or the last leaving, ends as `network`. Host side:
  `createPrototypeRequestHost` wired via `attachIosPrototypeRequests`, which also cancels the device's
  requests on connection close.
- **`via: "device"`.** Core owns the `PrototypeHttpClient` protocol and links no HTTP library; the agent
  injects `PrototypeURLSessionClient`: a dedicated ephemeral `URLSession` (never `.shared`, so app
  cookies, cache and credentials are untouched), the contract's 30 s ceiling, `timeoutMs` as a total
  deadline, stops reading a 2xx body and fails `too_large` past 262144 bytes (or when `Content-Length`
  announces more; a non-2xx body is never read, so it is `http_error` however large), maps URLSession
  errors to contract codes, reports duration from task metrics. Tested over a `URLProtocol` stub.

**Alamofire.** The #12529 proposal names Alamofire 5.x for the on-device client, pending two macOS-only
checks (an injected dylib linking Alamofire coexisting with the host app's own copy; binary size). Not
run, so the package does not depend on it; the URLSession client is the fallback behind the same
protocol, and an Alamofire client would be a second conformance chosen where the agent builds the
driver, with no Core change.

**App Transport Security.** See [Data, storage and network](#data-storage-and-network-12531).

## Data, storage and network (#12531)

iOS view of the data/storage/request features; the shared contract and capability map are in the
Android doc, [Data, storage and network](../android/prototype-ux.md#data-storage-and-network-12531).

| Capability                    | Gates                                                                | iOS agent                                                      |
| ----------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `prototype_data_actions_v1`   | `setData`, `appendData`, `prependData`, `removeData`                 | [Data actions capability](#data-actions-capability)            |
| `prototype_storage_v1`        | root `storage` block, `inspect` `storage`, `clear_prototype_storage` | Sandbox `Application Support/AutoMobilePrototypeAgent/storage` |
| `prototype_network_v1`        | `request` with `via: "host"`                                         | [Request action capability](#request-action-capability)        |
| `prototype_network_device_v1` | `request` with `via: "device"`                                       | Dedicated ephemeral `URLSession`                               |

### Destination policy (#13815)

`via: "device"` requests are checked by `PrototypeEgressPolicy` before starting, against every DNS
answer, and at each redirect. Refused: `localhost` and `*.localhost`; loopback (`127.0.0.0/8`, `[::1]`),
unspecified, link-local and multicast addresses and Android emulator host aliases; names with no DNS
answer or any refused answer, and ambiguous numeric spellings; the daemon's HTTP ports (3000-3010, 8765)
on private addresses. Other private (RFC1918) and public addresses are permitted. A refusal completes as
`blocked_destination`. Neither transport has an allowlist.

**`localhost` on a simulator.** The simulator shares the Mac's network stack, but `localhost`,
`127.0.0.1` and `[::1]` are refused for both `via` values (this policy; and the host's own egress policy
for `via: "host"`, see the Android doc's [host egress policy](../android/prototype-ux.md#data-storage-and-network-12531)).
To reach a Mac service, bind it to a non-loopback interface and use the LAN address on a non-daemon port
(e.g. `http://192.168.1.10:8080/feed`). Nothing is reversed on iOS (Android uses `adb reverse`).

**App Transport Security.** `via: "device"` is subject to the app's ATS: IP-literal `http://` hosts are
exempt (as is `localhost`, refused first by the policy); any other cleartext host is blocked
(`NSURLErrorAppTransportSecurityRequiresSecureConnection`) and completes as a typed `network` error
telling the author to use `via: "host"` (which runs without ATS) or `https://`. The viewer template sets
`NSAllowsArbitraryLoads` in `Viewer/Info.plist`, so a viewer runs any URL.

**Storage precedence** as Android: a changed `version` discards stored values, stored values replace
the spec's for listed keys, values that no longer fit are dropped. A failed disk write keeps keys dirty
and retries; a same-id re-show restores from the unsaved values meanwhile.

**Limits** (same as Android):

| Limit                                        | Value                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/data` write (after any action or response) | `MAX_PROTOTYPE_DATA_WRITE_BYTES`, 1048576 bytes of data cost                                 |
| Response body                                | `MAX_PROTOTYPE_RESPONSE_BYTES`, 262144 bytes, 2xx only                                       |
| Request `timeoutMs`                          | 1 to 30000, default 10000                                                                    |
| Requests in flight                           | 4 per device                                                                                 |
| Header and query entries                     | 16 each, values up to 4096 characters                                                        |
| Storage                                      | at most 64 keys, 262144 stored bytes per prototype id                                        |
| Emit payload                                 | 4096 bytes; a larger `change` event drops its `value` and the host stops mirroring that spec |

## Text field options

Require `prototype_text_field_options_v1` for the optional host fields. `variant: "outlined"` is a
rounded outline around a standard SwiftUI TextField; a floating `label` is a non-animating caption above
it. These substitutions produce `textField.variant` / `textField.label` platformNotes until
`prototype_text_field_material_style_v1` is advertised (not today). `maxLength` draws a counter, no
note. Open question: secure values remain in state, `change` events and `inspect`, unredacted.

## Flow and grid contract (not device-verified)

`prototype_flow_grid_v1` gates `flow` (wrapping row) and `grid`; both support children and repeat under
normal node/depth budgets. Flow's optional integer `maxLines >= 1` clips overflow visually without
removing hierarchy children. `style.spacing` is the item gap; finite nonnegative `style.runSpacing` is
the line/row gap (same bounds; flow/grid only). Grid requires integer `columns` 1..12 or
`{minWidth: dp}` (finite, > 0); spacing applies to both axes unless `runSpacing` overrides the row gap.
Grid is non-lazy, keeps every child in the hierarchy and never scrolls (authors wrap it in `scroll`).
Row-major placement starts a new row when a span doesn't fit. Optional integer `span >= 1` is valid only
on a direct grid child and cannot exceed fixed columns; the renderer clamps to the runtime count.

### Pager state binding

`pager.stateKey` requires `prototype_pager_state_key_v1` and a declared nonnegative integer
number key. Initial and same-id replacing-show state wins over a retained page; indices clamp
to the page range. Swipes write the key and emit `page_changed` and `change` once; state
writes, patches, `setPage`, and pager-bound navigation share the selection, animated unless
`motion: "none"`. Repeated settled reports are silent. A tab bar can share the key; two
pagers sharing it and pager bindings inside repeat templates are refused. Indicator rows and
conditional styles outside the pager can read the key (see the Android prototype UX example).
Observe continues to expose the current page's nodes.

### Optional pager layout

Shared contract #12071 adds `axis` (default horizontal), `pageSpacing` (0), strict `peek: {start?, end?}`
(each 0; `{}` is a no-op) and `pageSize` (`"fill"` or strict `{dp}`). Distances are finite points:
spacing/peek 0..10000, fixed size 1e-6..10000 (`MAX_PROTOTYPE_PAGER_DP`). Any explicit option requires
`prototype_pager_options_v1`; older agents are refused with a relaunch hint. Non-default options render
with a native view-aligned ScrollView, lazy stacks, scroll content margins and viewport/fixed page
frames; pagers whose options all resolve to defaults keep the paged TabView / wrap-size drag path. A
vertical pager can have no vertical scroll ancestor (omitted scroll axis is vertical). Current page =
first fully visible page; events, placeholders and navigation bindings keep their meaning. Every visible
page (including partly visible peek and fixed-size pages) is exposed to accessibility, observe and
`tapOn`; fully off-screen pages are not. Android marks the current page selected only for pagers with
positive peek or fixed `pageSize`; iOS marks it selected on the options path and not on the legacy paged
pager; plain pagers expose only the current page on both.

## Carousel and pager indicator (not device-verified)

`prototype_carousel_v1` gates two #12071 additions. A pager may declare `indicator: "dots"` (default
`none`): dots over the pager (bottom row, or end-edge column for vertical) with the current page filled;
plain circles, decoration only, hidden from accessibility. A `carousel` is a horizontally scrolling,
snapping row, one item per child (at least one; `repeat` expands like `row`); `itemWidth` (dp, > 0,
<= 10000) required; `variant` `multiBrowse` (default), `hero` or `uncontained`; `itemSpacing` dp >= 0. No
page index, event or `setPage` target (use a `pager` if the page matters). The host refuses a show on a
CtrlProxy or iOS agent without the capability. iOS draws every variant as fixed-width items in a
horizontal `ScrollView` with `scrollTargetBehavior(.viewAligned)` (no multi-browse/hero size changes;
all items stay accessible) and reports a `carousel` platform note.

## Pull-to-refresh (`scroll.refresh`, not device-verified)

A vertical `scroll` may declare `refresh: {stateKey, onRefresh}` (1-32 actions, same union as `onTap`).
`stateKey` must be a declared boolean state key that shows the indicator while true; horizontal scroll
with `refresh` is rejected at `<path>.refresh`. A pull writes true (emitting `change`) then runs
`onRefresh`; the prototype's own `setState`, or a `patch` of `/state/<key>` with `baseRevision`, writes
false to end it. A pull while true is ignored. Repeat/component placeholders bind in the key and actions.
Capability `prototype_refresh_v1`; older CtrlProxy/iOS agents are refused before sending.

iOS uses `refreshable` on the `ScrollView`: the closure sets the key, runs the actions and stays open
until the key is false (or the view goes away). A key set true without a pull shows a plain
`ProgressView` at the top, since SwiftUI can't start `refreshable` programmatically. Android uses
`PullToRefreshBox`.

## Text field trailing icon and IME action (not device-verified)

`prototype_text_field_actions_v1` gates textField `trailingIcon {icon, label, onTap?}`, `imeAction`
(`done`, `next`, `search`, `send`, `go`) and `onSubmit` (1-32 actions); the host refuses them with
`multiline: true`. iOS maps `imeAction` to `submitLabel` (done when only `onSubmit` is authored) and runs
`onSubmit`. Number, decimal and phone pads have no Return key, so a focused such field shows a keyboard
toolbar button named for the action that runs `onSubmit` and dismisses the pad (#12998). The trailing
icon is an SF Symbol button beside the field (plain glyph without `onTap`), named by `label`, with
identifier `<testTag>.trailingIcon` for `tapOn`. `leadingIcon`
(`prototype_text_field_leading_icon_v1`) is a decorative SF Symbol before the text, hidden from
accessibility.

## Swipe actions (not device-verified)

`row` or `listItem` `swipeActions: {start?, end?, fullSwipe?}` (`prototype_swipe_actions_v1`). `start`
is revealed by swiping right, `end` by swiping left (sides are physical, not RTL-mirrored). Each side
holds 1-3 entries `{label, icon?, role?, color?, onTap}` (`role` `default` or `destructive`; `color` hex
or role overrides background; `onTap` 1-32 actions); the first entry sits at the screen edge. Release
past 40% of the revealed width, or a fling past open velocity, leaves the row open; dragging beyond
rubber-bands. `fullSwipe: true`: past 60% (or a hard fling) runs the side's first entry and closes. One
row open at a time; tapping an open row closes it instead of running `onTap`. Revealed buttons get test
tag `<rowTestTag>.swipe.<index>` (start entries first, then end), existing only while open. Every entry
is also an accessibility action (VoiceOver/TalkBack). Reduced motion or `motion: "none"` snaps. Put
swipeActions on repeated rows; inside a horizontal `pager` or `carousel` they are refused (drag
conflict). iOS uses a custom `DragGesture` reveal inside the existing `ScrollView` (not a `List`) with
the same thresholds (`PrototypeSwipe.swift`).

## Prototype gesture action lists

`onLongPress` and `onDoubleTap` are action lists (1-32, same union as `onTap`) on box, row, column,
text, image, icon and card only; they require `prototype_gestures_v1` (host refuses older agents). They
run like taps with no new event kind and make a node interactive without `onTap`. A node with only
long-press/double-tap does not consume single taps: the nearest ancestor's `onTap` runs. The
single-tap delay applies only to nodes declaring `onDoubleTap`. Long-press uses the platform default
(~0.5 s iOS, ~0.4 s Android). `tapOn` with `action: "longPress"|"doubleTap"` and `layer: "prototype"`
drives them by coordinate gesture. Placeholders bind as for `onTap`. Each list is also a named VoiceOver action (`Long press`, `Double tap`; #15123), planned by
`PrototypeGesturePlan.accessibilityActions` and installed with `accessibilityAction(named:)`.

## Search bar contract (#12069)

Shared `searchBar` node: required string `stateKey` initialized in state; optional `placeholder`,
catalog `leadingIcon`, one or two `trailingActions` (`{icon, label, onTap?}`, nonempty label),
boolean-state `activeKey`, `variant` (`bar` default, or `docked`), `onSubmit` and a single `child` (needs
`activeKey`; true shows it). Bar expands to fill its parent; docked stays in place with results under
the field. Typing shares the text-field state-write and `change` path; keyboard search runs `onSubmit`.
A visible bar counts as a text field for focus and host `sendKeys`.

The iOS implementation must advertise `prototype_search_bar_v1`; until then the host refuses shows and
patches using `searchBar` before any device request. SwiftUI draws the field in the prototype window
(magnifying glass, text field, clear button when nonempty, trailing actions); do not use `.searchable`
(needs a NavigationStack). Icons use the SF Symbols mapping. `platformNotes` reports the differences.
Results are ordinary observable child nodes in the window, not a popup or lazy list.

## Rich text

A text node has exactly one of `text` or `spans` (plain `text: ""` stays valid). Spans are strict
`{text, style?, onTap?}` with nonempty, untrimmed text. Span style: color, fontWeight, fontStyle,
textDecoration, textSize, letterSpacing, fontFamily, background (a colour, never a gradient), same
ranges as node style. No span ids, testTags, visibility conditions, nested spans or URLs. Spans use the
same `{key}`, `{data:/pointer}`, `{item.field}`/`{index}` and `{props.x}` bindings as node text; actions
bind like `onTap`. Resolved texts concatenate without separators; observe/accessibility show the full
plain text (explicit node `contentDescription` still overrides). Max 64 spans per text node; spans don't
count as nodes. Requires `prototype_rich_text_v1`; older devices refused before show. A tappable span is
part of the text node, not a separate accessibility node, and runs actions without opening URLs.

On Android activate with `tapOn {accessibilityLink:"<span text>"}` or
`tapOn {text:"<full plain text>", subtext:{text:"<span text>"}}` without `layer` (these act across
windows; `tapOn` refuses `layer` with them, #9305); `tapAt` on span bounds is the fallback. On iOS links
are drawn as links and tap-through is by `tapAt` only; show reports the `rich-text-links` platform note.
Owed: advertise only after renderer support; device checks of mixed span styles, concatenated observe
text, per-span actions without URL navigation, Android semanticLinks, and iOS tapAt links.

## Menu and select

`menu` and `select` require `prototype_menus_v1`; the host refuses them before showing or uploading
assets when the renderer lacks it.

- `menu`: `openWhen: {key, equals}` (boolean equality) and 1-16 strict `items`, each
  `{label, icon?, trailingText?, enabled?, onTap?}` or exactly `{type:"divider"}`. Labels/trailing text
  nonempty; `onTap` 1-32 actions. A disabled item is dimmed, untappable and does not close the menu;
  dividers are neither focusable nor tappable. The elevated surface anchors to its parent's bottom end,
  flipping above the anchor when it cannot fit below but fits above, otherwise clamped inside the window. An enabled item or outside tap writes `!equals` to the open key; item
  actions run after closing.
- `select`: string `stateKey` and 2-32 `{value,label}` options (unique nonempty values, nonempty
  labels; optional label nonempty). Shows the current option's label (empty if none match) and a trailing
  expand indicator; expansion is local view state. Choosing writes the key, emits the same `change`
  payload as `radioGroup` and collapses; tapping the field again or outside also collapses.
- Both support repeat templates and `use` components; placeholders bind in state keys, item labels/
  trailing text/actions, select and option labels.

Rendering stays inside the prototype window on both platforms so `observe`/`tapOn` reach the normal
hierarchy (Android uses an in-window surface, not DropdownMenu/Popup; iOS an in-window list, not system
Menu/Picker; iOS shows report the substitution in `platformNotes`). The select field and menu surface
carry the node `testTag`. Select option rows are `<testTag>.<value>`; menu item rows `<testTag>.<index>`
(zero-based, dividers counted). Android adds row tags only when `testTag` is set; iOS falls back to
`(testTag ?? id).<value|index>`.

## Tooltip and drawer overlays

`prototype_tooltip_v1` and `prototype_drawer_v1` gate `tooltip` and `drawer` respectively in both
strict spec validation and bundle capability discovery. Both use boolean `openWhen: {key, equals}`;
state writes must preserve that binding's type. The generated contract enforces their strict fields.
Tooltip `anchorTo` must resolve to exactly one other node id after host component and repeat expansion.

Tooltips are hoisted into the top hosting layer, outside the page's layout and anchor layer.
`anchorTo` uses the rendered target's global bounds; `anchor` uses host-resolved bounds plus offsets.
An unrendered target leaves state unchanged and draws nothing. `PrototypePlacement.place` resolves
caret side, bubble origin and caret offset from target, bubble and window geometry. `top` means the
bubble is below the target; logical start/end mirror in RTL. Placement flips to the opposite side
when needed, chooses the larger space when neither fits, clamps to an eight-point window margin,
and keeps the caret aimed at the target center within the bubble's corner inset. Menus use the same
placement module while preserving their bottom-end alignment when they fit below.

A tooltip's optional `spotlight` draws the themed sheet scrim at 40% alpha with an even-odd rounded
cutout, inflated by `padding` (default 8 points; radius default 12). The bubble exposes its text and
`testTag` with a tooltip hint, without a modal accessibility trait. Only a spotlight hides the page
from accessibility and moves focus to the bubble; dismissal restores focus to the anchored node.
Without a spotlight the page remains interactive. Tapping the bubble dismisses unless `onTap` is
present, in which case only those actions run. Spotlight taps (`<testTag>.close`) dismiss. Dismissal
writes `!equals` before running `onDismiss`.

Drawers cover the page with an authored or themed 40% scrim and a surface panel inside the safe area.
Panel width is `min(320, windowWidth - 56)` points; start/end mirror in RTL. The child retains its
normal hierarchy; the panel carries `testTag`, and the scrim carries `<testTag>.close`. Scrim taps,
Back/Escape and outward panel swipes dismiss by writing `!equals`; `dismissOnSwipe: false` disables
swipes. Swipe settling reuses the sheet's half-extent rule. Back closes a drawer before stack navigation
or window dismissal. The page is hidden from accessibility while open; focus enters the panel and
returns to the previously focused element on close.

Drawer entry and exit use a 300 ms linear-out-slow-in slide along the physical edge with a fading
scrim. The modal layer retains closing drawers through animation completion, with a generation guard
for interrupted closes. `motion: "none"` is instant; system Reduce Motion substitutes a crossfade.
Overlay hit frames use the existing `modal.*` host routing, and text and child controls appear in the
normal observe hierarchy. Geometry, dismissal, capability and motion decisions have device-free Core
tests; the renderer uses the existing UIKit focus markers and frame scheduling.

## Saved prototype on-disk layout (#12254)

One saved prototype lives in the viewer app container:

```text
Documents/prototype/
  manifest.json
  spec.json
  assets/<sha256>.png|jpg|webp
  fonts/<sha256>.ttf|otf
```

Same-id `show` write-through replaces only `spec.json`, and only when the layout was loaded.

Version 1 manifest (strict):
`{"formatVersion":1,"specFile":"spec.json","assets":[{"id":"image","file":"assets/<sha256>.png","sha256":"<sha256>","mediaType":"image/png"}],"fonts":[]}`.
Both arrays always present. SHA-256 is lowercase hex over file bytes; identical bytes with the same
media type share one content-addressed file; paths must exactly match media type, folder and hash; IDs
are unique across both arrays. The shared asset contract caps count, per-file and total bytes; spec and
manifest caps are 1 MiB and 256 KiB.

The host writer stages a sibling `.tmp-<token>` directory, writes the manifest last, then renames into
place; replacement first backs up the old directory to `.old-<token>` and restores it if the commit
rename fails. Callers serialize writes. The reader refuses unknown versions before validating
version-specific fields and never changes files. A bad manifest, spec, count or verified-byte total is
corrupt; missing, unreadable, unsafe, empty/oversized or hash-mismatched assets are omitted from the
verified snapshot and reported as sorted problems (the viewer shows its missing-asset placeholder and
exposes problems via `inspect`). Unlike Android's slug directories, iOS stores one prototype with no
manifest id, label or savedAt. Asset failures leave the prototype loadable; reading never repairs or
deletes. The writer permits spec references absent from the request (reported by the reader as missing
manifest entries). The installer is separate (#12256).

Implementations: `src/features/prototype/savedPrototypeLayout.ts` and
`ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeSavedLayout.swift`; both test suites
consume `test/fixtures/prototype-saved-layout/layout.json` (same expected manifest and hashes; binaries
generated at test time).

## Viewer template release asset

Release automation ships `AutoMobilePrototypeViewer.zip` with a single top-level `PrototypeViewer.app/`.
The universal arm64 + x86_64 simulator app is ad-hoc signed by `scripts/ios/prototype-viewer-build.sh`,
packaged with `ditto -c -k --keepParent` by `scripts/ios/build-prototype-viewer-release.sh` (preserving
executable mode and signature). `build-prototype-viewer.yml` verifies both architectures,
`MinimumOSVersion`, the signature, and the absence of `Assets.car`, `InfoPlist.strings` and
`CFBundleIconName` before upload.

Prepare Release records the archive SHA-256 as `prototypeViewerSha256` beside `prototypeAgentSha256`,
verifies the downloaded candidate against it and includes `prototype-viewer` in provenance; Release
reuses that artifact and publishes its checksum in the notes. Older registry entries omit the pin and
resolve to "viewer unavailable". The host template provider resolves: explicit path,
`AUTOMOBILE_IOS_PROTOTYPE_VIEWER`, configured local builds, then a checksum-pinned release cache/download
(unless `AUTOMOBILE_SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD`).

### Share contract

`requires.platform: ["share"]` enables the `share.open` platform-call grammar; its generated
gate is `prototype_platform_share_v1`. Neither runtime advertises that capability until its
system-sheet driver is implemented. There are no share events or `/platform/share` state keys.
The existing `into`, `statusKey`, `onSuccess`, `onError`, timeout and `prototype_platform`
completion contract applies. A cancelled sheet must fail with `cancelled` and run `onError`.

Arguments use value bindings. At least one nonblank `text`, nonempty `url`,
`images`, `files`, or `contact` is required; `subject` alone is not an item.
`subject` is optional; the error for `title` directs callers to use `subject`. String values use `{key}`,
`{data:/pointer}`, `{item.field}`, `{index}` without rescanning substitutions. Missing state
or item text remains literal; missing/non-scalar data text becomes empty. Missing whole-value
bindings fail with `invalid_args`. Data, event, and platform pointer roots must be objects;
arrays can be traversed below an object member, but an array root is a missing binding. URLs must have a literal http(s) scheme; placeholders elsewhere are checked again after binding;
relative, javascript, data, file, and prototype deep-link URLs are refused. Userinfo, backslashes, ASCII whitespace, C0/C1 controls, NBSP, U+2028–U+202E, and
U+2066–U+2069 are refused by the portable URL grammar.

Images contain 1–10 uploaded asset IDs, `{asset: id}` objects, or `{data: "/pointer"}` objects
resolving to either uploaded-ID form. Files contain 1–4 `{asset, name, mimeType}` objects.
Names are 1–128 UTF-8 bytes, cannot start with a dot, and cannot contain path separators or
C0/C1 controls, NBSP, U+2028–U+202E, or U+2066–U+2069. Windows reserved device names,
colons, trailing dots, and ordinary spaces are allowed by this platform-neutral contract. MIME values are nonempty RFC token `type/subtype` values, with no parameters.
No device-local media type is introduced. A complete `shareAssetIds` inventory enables static
unknown-ID refusal; bundle references use the existing asset lookup, and pure resolution always
checks the supplied uploaded inventory. Every referenced entry must include a nonnegative
safe-integer `bytes` value; malformed metadata fails with typed `invalid_args`. Existing asset transport limits and supported media types
still apply; the contract does not add PDF or other upload formats.

Contact fields are exactly `name` (nonblank, required), `phone`, `email`, `org`, `url`, `note`.
The pure `resolvePrototypeShare` twins produce vCard 3.0 (`text/x-vcard`, `public.vcard`):
`FN` and an unstructured family `N` hold name, with `TEL`, `EMAIL`, `ORG`, `URL`, `NOTE` in that
order. TEXT properties escape backslash, comma, semicolon and CR/LF; the URI-valued `URL`
property is preserved verbatim. Lines use CRLF, and lines fold at
75 UTF-8 octets (continuation space included), without splitting a Unicode scalar.
No Contacts permission is needed. Each string is bounded by `MAX_PROTOTYPE_SHARE_TEXT_BYTES`
(65536); literal and resolved arguments use the same rules. Library imports refuse secure
state in every share string, including nested contact/file values and follow-up handlers.
The library secure-value scan guard caps total expanded bytes at 4,194,304 bytes, measured as
authored UTF-8 sink bytes charged per repeat row before allocating repeated strings; zero-row
templates are charged once. It charges literal spans even when substitution would shorten them.
This is not a one-pass pre-scan; it is conservative: may refuse legitimate large library specs; a pre-scan would be exact.

See [Known platform differences](../android/prototype-ux.md#known-platform-differences) for
lone-surrogate decoder/encoder behavior and host component expansion before native validation.

Pure resolution returns `{ok:true,payload,summary}` or
`{ok:false,error:{code:"invalid_args",path,message}}`. Payload includes uploaded image IDs,
files with supplied byte metadata, optional text/url/subject and optional `vCard`. Summary is
`{outcome:"shared"|"unknown",target?,items:{text?,url?,subject?,images,files,contact}}`, with
file entries `{name,mimeType,bytes}`. Text is truncated to 2048 Unicode scalar values, never
splitting a surrogate pair. The pure function defaults to `unknown`; only a future driver may
supply completion evidence. Android `shared` will mean a chosen target, not completed delivery;
iOS uses its activity completion flag. `target` is the chosen package/activity raw value.

The contract has no system-sheet dispatcher or fake-mode behavior. `platformMode` and
`prototype simulate` are not accepted by this vocabulary.

## Platform namespaces (#15257)

Prefer portable fields, portable theme tokens, then `theme.design`; reserve `ios`/`android`
for native semantics. Each closed contract field has a `why`. Both renderers advertise
`prototype_platform_namespace_v1` (iOS 17+). Foreign blocks are accepted and ignored with
paths in `platformNotes`; unknown fields are rejected on either platform. Window/theme
namespace blocks have no applicable node and are reported as ignored. The four node glass fields
require only `prototype_glass_v1` on iOS; mixing any other iOS key requires
`prototype_platform_namespace_v1` as well. Android ignores foreign glass fields
with their individual paths in `platformNotes`.

Android `indication` controls node clickable feedback (`ripple` or `none`); motion-off
still disables feedback. Stack `predictiveBack.style` preserves the normal pop for
`default`, uses horizontal movement and fade for `crossActivity` within the prototype
activity, and snaps without predictive scrubbing for `none`. Reduced motion still wins.

iOS `buttonStyle` applies `.glass`/`.glassProminent` on iOS 26+, using bordered buttons
below 26 with a substituted note. `hover` applies lift/highlight on iOS 17+ and is render-only.
The renderer's tab bars, app bars and sheets are custom drawn to retain per-item identifiers;
`tab.role`, `bottomAccessory`, `navigationTitle` and `sheet.sizing` are reported as ignored.
`bottomAccessory` is node-only and structurally validated; its descendants provide no targets,
references or capabilities on either renderer. iOS ignores all Android fields.

## Icon effects

`prototype_icon_effects_v1` is advertised on iOS 17 and later. Icon `effect`
selects native SF Symbol effects through a pure type/version decision table:
bounce, pulse, scale.up, variableColor and replace need 17; wiggle, rotate and
breathe need 18 and fall back to bounce, none and pulse on 17; drawOn needs 26
and otherwise uses replace. `trigger: {key}` or `{data}` replays on value changes;
`repeat` is "infinite" or 1–20 and cannot coexist with trigger. Replace follows
name changes. Reduced/off profiles rest; reduced replace uses a plain crossfade.
The host reports fallback notes with node paths, using the discovered OS version
when available. The shared validator charges repeated effects against the eight
animated-effect budget, including expanded list instances.

The iOS `hide_for_capture` hold removes repeated symbol modifiers, returning icons to
rest until the last capture token releases or expires. Restoring restarts native
repeats. Local `PrototypeIconMotionActivity` tracks mounted repeated effects and
masks activity during capture; finite native repeats remain conservatively active
until unmounted because SF Symbols provides no completion callback. iOS has no
shared motion-active wire signal or shimmer reporter yet; this local signal is
not exposed to the host, and captures that bypass `hide_for_capture` do not rest effects.

Expressive motion, node `press`, and layout `animate` are Android only until #14684; the host refuses them against the iOS agent, which does not advertise `prototype_motion_v3`.

### Motion tokens

`animate.tempo: "fast" | "default" | "slow"` requires `prototype_motion_tokens_v1`
and cannot be combined with `durationMs` or `easing`. The contract's `motionTokens`
table selects a physical spring by scheme (`motion: "standard"` by default, or
`"expressive"`), property role and tempo. `easing: "spring"` selects the default
tempo of that scheme. Spatial properties are offset, scale, rotation, cornerRadius,
elevation, shadowColor, padding, border width and dp width/height; alpha, background,
color and border color use critically damped effects springs.

| Scheme / role         | Damping ratio (fast / default / slow) | Stiffness (fast / default / slow) |
| --------------------- | ------------------------------------- | --------------------------------- |
| standard spatial      | 0.9 / 0.9 / 0.9                       | 1400 / 700 / 300                  |
| expressive spatial    | 0.6 / 0.8 / 0.8                       | 800 / 380 / 200                   |
| either scheme effects | 1 / 1 / 1                             | 3800 / 1600 / 800                 |

Compose uses `spring(dampingRatio, stiffness)`. SwiftUI uses
`interpolatingSpring(mass: 1, stiffness: k, damping: 2 * dampingRatio * sqrt(k))`,
so both renderers use the same physical spring. Reduced motion snaps spatial
changes and retains effects; motion off snaps everything. Existing motion v2/v3
capability requirements still apply; iOS advertises the token capability but
continues to refuse those broader features until its corresponding capabilities
are available.

## Glass and scroll edges

The agent advertises `prototype_glass_v1` only on iOS 26+, and
`prototype_scroll_edge_effect_v1` on every supported OS. Glass namespace fields
require only `prototype_glass_v1`; mixing them with other iOS namespace fields
also requires `prototype_platform_namespace_v1`. Specs and library bundles are
validated before rendering and must satisfy these gates, including conditional
styles and hidden templates. iOS 17–25 refuse glass; no material substitute is
used.

`style.surface: "glass"` applies Liquid Glass regular/clear, optional colour tint
and interactive feedback, after layout and paint. `cornerRadius` selects the
shape; absent means Capsule. Conditional `styleWhen` glass options must repeat
`surface: "glass"` in the same style. `ios.glassGroup` owns a GlassEffectContainer and
namespace; descendant glass nodes use `shared.key` for glassEffectID,
`ios.glassUnion` for union identity and `ios.glassTransition` for the native
transition. Nested groups scope their own IDs. Keys must be unique per nearest
group, cannot collide with visibility-pair keys, and must use repeat.key templates
under repeat (including on the repeated node). `ios.backgroundExtension: true`
on images uses backgroundExtensionEffect. All four glass keys are node-only and
are rejected in window.ios/theme.ios.

`scroll.edgeEffect` uses scrollEdgeEffectStyle on iOS 26 (none hides the effect).
Older systems reuse the existing scrollability-aware fade mask: soft 24 dp,
hard 8 dp, authored fadeEdges lengths taking precedence. None disables only the
native effect or default fallback; explicit fadeEdges still apply on every iOS version.
Reduce Transparency and Increase Contrast use system behaviour. Tests assert
structure and bounds with pinned settings; group morphing and the visual result
still require an iOS 26 simulator check. Android rendering is a separate slice.
