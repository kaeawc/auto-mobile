# Client Screen Control: coordinate mapping contract

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

Part of milestone 28 (Client Screen Control), parent [#1099](https://github.com/kaeawc/auto-mobile/issues/1099).
New to screen control? Start at the [daemon overview](../daemon.md), then use
this contract for the coordinate, gesture, keyboard, frame, and refresh rules.
This document specifies how a mirrored device screen converts a **viewport point**
(a pixel the user clicked/dragged on the rendered canvas) into a **device
coordinate** suitable for the typed daemon input helpers (`inputTap`,
`inputSwipe`), and the client-side policies that decide which pointer and
keyboard gestures become daemon input at all. It is written so a third-party
daemon client can reproduce all of it without reading any Compose code.

The reference implementation is the Compose-free
`DeviceScreenCoordinateMapper` in the `desktop-domain` module
(`dev.jasonpearson.automobile.desktop.domain`). The desktop inspector's
`DeviceScreenView` delegates to it; a client in any language can port the same
formulas.

## Interaction modes

A device-screen view honors one of two modes (`DeviceScreenControlMode`):

- **Inspector** (default) — a click selects the deepest UI element under the
  cursor and hover highlights elements. This is the historical layout-inspector
  behavior. It is the default so existing consumers (including the Android IDE
  plugin, which shares `desktop-core`) are unaffected with no source change.
- **Control** — a click maps to a device coordinate that the client forwards to
  the daemon input helpers as a tap, a drag maps to a start/end pair the client
  forwards as a swipe (see [Drag-to-swipe policy](#drag-to-swipe-policy)), and a
  keystroke received **while the view holds focus** maps to a button press, a
  discrete key or typed text (see
  [Keyboard forwarding policy](#keyboard-forwarding-policy)). Element selection
  and hover highlighting are suppressed.

Control mode is strictly opt-in. The view itself never sends daemon input; it
only reports the mapped coordinate or keystroke to a caller-supplied callback.
Wiring that to `inputTap`/`inputSwipe`/`inputPressButton`/`inputTypeText`/
`inputKey` is the client's responsibility
([#3347](https://github.com/kaeawc/auto-mobile/issues/3347),
[#3350](https://github.com/kaeawc/auto-mobile/issues/3350),
[#3351](https://github.com/kaeawc/auto-mobile/issues/3351)).

## Coordinate spaces

| Space        | Origin                              | Units                                                            |
| ------------ | ----------------------------------- | ---------------------------------------------------------------- |
| **Viewport** | top-left of the rendered canvas     | canvas pixels, before pan/zoom are removed                       |
| **Frame**    | top-left of the fitted device frame | frame pixels at zoom 1.0                                         |
| **Device**   | top-left of the device screen       | same space as hierarchy `bounds` — **canonical physical pixels** |

Device coordinates share the hierarchy `bounds` coordinate system, so a mapped
point can be handed directly to element hit-testing (inspector) or to the daemon
input helpers (control).

### One unit, both platforms

There is **one** device unit and it is the same on Android and iOS: physical
pixels in the current device orientation. A message that carries
`coordinateSpace: "px"` states this explicitly for its `bounds` and its
`screenWidth`/`screenHeight`, and the daemon accepts pixels on `input/tap` and
`input/swipe` for that device. **A client author needs no platform-specific unit
knowledge**: read the numbers, map them with the formulas below, send them back.
Nothing on this page branches on the platform.

The daemon does the platform work internally. iOS runners report logical points,
so the daemon multiplies by the runner-reported `nativeScale` when publishing and
divides by it (exactly, without rounding) when dispatching input. Android runners
are already physical pixels (`nativeScale` 1), so its conversion is the identity.

> **Legacy fallback.** A message with **no** `coordinateSpace` comes from a daemon
> or runner that predates canonical pixels ([#4548](https://github.com/kaeawc/auto-mobile/issues/4548)).
> There, and only there, iOS `bounds` are logical points while the screenshot is
> pixels, so the two are not directly comparable and input coordinates are passed
> through untouched. Everything in this document still applies — the mapping
> formulas are ratio-based and unit-agnostic — but a client must not compare the
> frame's absolute dimensions against the bounds' declared coordinate space.
> Never infer pixels from a missing field — and never treat an _unrecognized_
> declaration as this fallback. A space the client does not implement means a
> daemon newer than the client, so control must fail closed on that frame; only
> an absent field is the legacy point space.

## Rendering pipeline

1. **Rotation alignment.** The raw screenshot may arrive in native pixel
   orientation (portrait) even when the device is landscape, while hierarchy
   bounds are always in display orientation. The screenshot is rotated to match
   the hierarchy before anything else, so the rest of the pipeline needs no
   further rotation. See [Rotation](#rotation).
2. **Aspect fit.** The rotation-aligned image is sized to fit the viewport
   (minus a per-side padding) while preserving its aspect ratio. See
   [Fit-to-viewport sizing](#fit-to-viewport-sizing).
3. **Zoom + pan.** A uniform zoom `scale` and a pan `offset` (in viewport
   pixels) are applied on top of the fitted frame.

Because step 1 pre-rotates the screenshot, the viewport↔device mapping is a
plain scale + translate.

## Geometry inputs

A client builds a geometry snapshot once per rendered frame:

| Field                           | Meaning                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `frameWidthPx`, `frameHeightPx` | fitted frame size at zoom 1.0 (from fit-to-viewport)                   |
| `scale`                         | current zoom multiplier                                                |
| `offsetX`, `offsetY`            | current pan offset, in viewport pixels                                 |
| `deviceWidth`, `deviceHeight`   | device coordinate-space size (root hierarchy bounds, rotation-aligned) |

## Viewport → device mapping

```text
frameX = (viewportX - offsetX) / scale
frameY = (viewportY - offsetY) / scale

frameToDevice = deviceWidth / frameWidthPx          // guard: 1.0 if frameWidthPx <= 0

deviceX = round(frameX * frameToDevice)
deviceY = round(frameY * frameToDevice)
```

Notes and rules a client must reproduce:

- **Width-based scale for both axes.** The single ratio `deviceWidth /
frameWidthPx` scales _both_ x and y. This is exact because the frame is fitted
  to the device aspect ratio, so the height ratio equals the width ratio.
- **Rounding.** `round` is round-to-nearest with halves rounding **up** (Kotlin
  `roundToInt` / `Math.round`: `0.5 -> 1`, `-0.5 -> 0`).
- **Out of bounds.** The mapping **never clamps**. It returns the raw rounded
  coordinate and a boolean `inBounds`, true iff
  `0 <= deviceX < deviceWidth && 0 <= deviceY < deviceHeight` (right/bottom edges
  are exclusive). Inspector hit-testing depends on this: a click outside the
  screen produces an out-of-range coordinate that matches no element, clearing
  the selection. A **control** client must not tap an out-of-bounds point — drop
  it, or clamp it to the last addressable pixel `(deviceWidth - 1,
deviceHeight - 1)` if pinning to the edge is desired. Clamping is only valid
  when **both** device dimensions are positive: with a zero dimension
  `(deviceWidth - 1, deviceHeight - 1)` is negative and addresses no pixel, so a
  client must **drop** the point instead. The reference `DevicePoint.clampedTo`
  mirrors this — it reports `inBounds = false` for a zero-dimension screen.

## Drag-to-swipe policy

A pointer drag in **Control** mode becomes exactly one `input/swipe`. Everything
below is **client-side policy**: the daemon faithfully executes whatever
endpoints and duration it is handed, so it can neither reject an accidental
one-pixel swipe nor repair an off-screen one. Clients should converge on these
rules rather than each inventing their own. The reference implementation is the
Compose-free `DeviceDragGesturePolicy` in the `desktop-domain` module
([#3350](https://github.com/kaeawc/auto-mobile/issues/3350)).

### One frame for the whole drag

Both endpoints are mapped through the **same** frame snapshot, pinned when the
drag begins — the one the drag _started_ on. A snapshot arriving mid-drag must
not rescale the gesture or map its two ends through different frames.

### Threshold

| Rule                                                               | Value                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Minimum travelled distance, frame declares `coordinateSpace: "px"` | **`24 * nativeScale` device coordinates** (physical pixels)                        |
| Minimum travelled distance, legacy frame (no declaration)          | **24 device coordinates** (logical points)                                         |
| Measurement                                                        | straight-line (Euclidean), in **device** coordinates, **after** the end is clamped |
| Below the threshold                                                | send **nothing** — not a swipe, and **not** a tap either                           |
| Duration sent                                                      | **300 ms**, a fixed client value                                                   |

The threshold is measured in **device** coordinates, not viewport pixels, so it
means the same thing regardless of the client's zoom level: a viewport-space
threshold would send a swipe for one hand movement at one zoom and not at
another, and would let a few pixels of pointer jitter become a large device
gesture when zoomed out.

**One physical intent in two coordinate spaces.** In the legacy point space,
`24` sits just above both platforms' touch slop. A canonical-pixel frame publishes
the matching finite, positive `nativeScale` on both its hierarchy and screenshot
messages, so the client uses `24 * nativeScale`. The daemon divides those pixels
by the same scale before sending an iOS gesture to the point-based runner, which
preserves a 24-point threshold at every supported scale. Android publishes
`nativeScale: 1`, so it keeps the 24-pixel threshold.

A pixel frame without matching finite, positive scale metadata is not safe for
control. The client must fail closed rather than guess a threshold or retain a
frame after its scale changes.

A below-threshold drag is **not** promoted to a tap. Actuating an input the user
did not ask for is worse than ignoring an ambiguous one, and a click that barely
moved is already covered by the client's own tap detection. Note the consequence:
between the UI toolkit's touch slop (where the client starts treating the gesture
as a drag and stops treating it as a click) and this threshold there is a **dead
band** in which a gesture sends no input at all. That is deliberate.

The duration is a fixed policy value, not a measurement of the pointer gesture.
Reproducing pointer velocity would make the same on-screen gesture behave
differently depending on how fast the user's hand moved over a mirror whose frame
rate is unrelated to the device's. `300` is inside the daemon's accepted
`[1, 60000]` range for `durationMs`.

### Cancellation and out-of-bounds

| Situation                                                     | Behavior                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Drag **cancelled** (pointer capture lost, window deactivated) | send nothing                                                        |
| Drag **started** outside the device screen                    | send nothing — clamping would invent a start the user never touched |
| Drag **ended** outside the device screen                      | **clamp** the end to the last addressable pixel and send            |
| Device screen has a non-positive dimension                    | send nothing (no addressable pixel to clamp to)                     |
| Drag outside Control mode                                     | send nothing; a drag means viewport pan                             |

Dragging _past_ an edge is the ordinary way to scroll to the end of a list, so an
out-of-bounds end is clamped rather than dropped — this is the clamping option
the [out-of-bounds rule](#viewport-device-mapping) already sanctions, and it
yields well-formed input. Clamping happens **before** the distance check, so the
threshold is applied to what would actually be sent.

Nothing here is a failure: an ignored drag surfaces no error, and it must not
start a post-input refresh wait — the device did not change.

### Viewport pan in Control mode

A plain drag means a device swipe in Control mode, so viewport pan moves onto the
modifier that already gates zoom (Cmd on macOS, Ctrl elsewhere): **modifier +
drag pans, plain drag swipes**. The modifier is read once at pointer-down, so
releasing it mid-drag cannot turn a pan into a swipe. In **Inspector** mode a
plain drag still pans and never produces daemon input, which is why the IDE
plugin — inspector-only — is unaffected.

### Device → viewport (inverse)

For placing overlays or touch-feedback markers, the inverse is:

```text
deviceToFrame = frameWidthPx / deviceWidth          // guard: 1.0 if deviceWidth <= 0
viewportX = deviceX * deviceToFrame * scale + offsetX
viewportY = deviceY * deviceToFrame * scale + offsetY
```

Modulo integer rounding, `deviceToViewport` and `viewportToDevice` round-trip.

## Keyboard forwarding policy

Keyboard, text and device-button forwarding is **client-side policy** in exactly
the same sense as the drag rules above: `input/pressButton`, `input/typeText` and
`input/key` faithfully execute whatever they are handed, so deciding _which
keystrokes reach the device at all_ is entirely the client's job. The reference
implementation is the Compose-free `DeviceKeyboardInputPolicy` in the
`desktop-domain` module
([#3351](https://github.com/kaeawc/auto-mobile/issues/3351)).

This section is written for a client author embedding control mode in **their
own** host — the desktop app, or something else entirely. It deliberately does
not enumerate any one host's keymap, because the host is not knowable from the
policy.

### When keyboard input forwards at all

Two conditions, both required:

| Condition                                       | Why                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The device-screen view **holds keyboard focus** | Forwarding without it would type into the device while the user is filling in a field elsewhere in the host                     |
| The view is in **Control** mode                 | Inspector mode produces no daemon input of any kind, which is what keeps an inspector-only embedder (the IDE plugin) unaffected |

Focus is the _only_ place a global-capture design would be tempting; do not take
it. Use the toolkit's own focus routing — the reference client attaches its
handler to the focusable device-screen node, so a keystroke reaches the policy
only when that node is on the focus path, and nothing has to be re-checked. The
view takes focus when it **enters** control mode, **and again when the canvas is
clicked**; the second is not optional, because once anything else takes focus
(a pane-navigation shortcut, a side panel) clicking the mirrored screen is the
only affordance a user has to get it back.

**Beware ancestor preview handlers.** If your host resolves its own navigation
shortcuts in a _preview_/capture-phase handler — one that runs before the focused
descendant — it will consume Tab, the arrows, Enter and Escape before the device
canvas ever sees them, and Escape is the client's only device-button binding. The
host must stand that handler down while the device canvas holds focus — but only
for **keystrokes the policy will actually claim**, decided per event with this
same policy, not with a blanket "canvas is focused" flag. The blanket version
creates a dead zone: toolkits do not rerun a preview handler while an unconsumed
event bubbles back up, so any keystroke the canvas then _declines_ (a printable
character on a platform whose daemon cannot append, a shifted device key) would
reach neither the device nor the host binding it used to trigger. The reference
client asks `DeviceControlSession.wouldForwardKey` — the same decision the
dispatch path makes — per event; chords answer "no" there, so chorded host
shortcuts keep working, consistent with the chord rule below.

Control mode is additionally **inert without a frame snapshot**, the same
fail-closed rule taps and drags follow: with no snapshot there is no frame the
keystroke belongs to.

### Host shortcuts

**A keystroke with Ctrl, Alt or Meta (Cmd/Win) held belongs to the host and is
not forwarded.** Ctrl/Alt/Meta are what hosts build menu accelerators and window
shortcuts out of on every desktop platform, so refusing all of them is the only
rule that is correct for every host. Shift is **not** a chord modifier: it is how
a capital letter or a shifted symbol is produced, and treating it as one would
make control mode unable to type half the keyboard.

One documented exception is built in: **Alt-family character composition** — AltGr
and macOS Option — and it is **platform-dependent**, so the host (not the pure
policy) must resolve it. The rule is:

```text
altComposesText = printable && !meta && when {
  isMac -> alt
  isLinux && nativeAltGraph != null -> alt && nativeAltGraph
  else -> ctrl && alt
}
```

- **Linux:** composition is **AltGr**, identified by AWT's native
  `isAltGraphDown()` signal. A genuine Ctrl+Alt shortcut has AltGraph unset, so
  it stays with the host rather than typing its printable character into the
  device.
- **Windows:** composition is **AltGr**, but many JDKs surface it only as
  **Ctrl+Alt** (`@`, `€`, `{`, `\`) and leave the native AltGraph flag unset. The
  Ctrl+Alt fallback is therefore retained. A _plain_ Alt (no Ctrl) is a **menu
  accelerator** — `Alt+F` opens File — and AWT reports a printable `keyChar` for
  it too, so it must not count as composition.
- **macOS:** composition is the **Option** key, which is plain **Alt** (Option+L =
  `@`, Option+5 = `[`), and macOS menus use **Cmd/Meta, never Alt** — so plain Alt
  is safe to treat as composition on macOS only.

**Meta held never qualifies** on any platform: `Cmd`/`Meta` shortcuts never compose
characters, so Meta-held is the reliable "this is a shortcut, not typing" signal.
A real accelerator that produces no character (or carries Meta) always stays with
the host, which keeps the exception from being a hole.

Because the pure policy cannot know the host OS, the toolkit adapter resolves this
boolean where the platform and AWT masks are visible (the reference client does it
in `DeviceKeyboardEventTranslator`) and passes it to the policy as
`DeviceKeyStroke.altComposesText`. The policy then forwards such a keystroke only
when it also produced a **typable ASCII** character. A porting client on another
host must make the same platform-aware decision rather than inferring composition
from `alt && printable`.

**Known limitation (Windows).** The `ctrl && alt` fallback is a heuristic, not a
true AltGraph detector. AWT exposes an AltGraph signal (the native
`java.awt.event.KeyEvent.isAltGraphDown()` behind Compose's `KeyEvent.nativeKeyEvent`,
mirrored by `PointerKeyboardModifiers.isAltGraphPressed`), but many Windows JDKs
report a real AltGr keystroke as plain Ctrl+Alt with the `ALT_GRAPH` mask **unset**.
Requiring the mask would regress common AltGr typing (`@`, `€`, `{`) on those JDKs.
The accepted consequence is that **a genuine Ctrl+Alt host shortcut that produces a
printable character may still be forwarded to the device rather than reaching the
host** on Windows. Linux uses the reliable native signal.

A client that knows its own host leaves a particular chord unclaimed may opt it in
explicitly (`forwardedChords`). The default list is **empty**. Entries match
either a device key **or a produced character**, case-insensitively — the latter
matters because the chords a client actually wants to opt in are letter chords
like Ctrl-S, and an ordinary letter deliberately carries no device key at all, so
a key-only allowlist could never name one.

Each entry also names the **exact chord-modifier set** it forwards (`ctrl`/`alt`/
`meta`). This is required, not optional: an entry that matched a character alone
would forward Ctrl-S **and** Meta-S **and** Alt-S, so opting in one chord would
silently swallow the host's other shortcuts on the same key. `OfCharacter('s',
ctrl = true)` therefore forwards Ctrl-S only; Meta-S and Alt-S stay with the host.
Shift is not part of the match (character comparison is already case-insensitive,
so Ctrl-S and Ctrl-Shift-S name the same opt-in).

The mechanism matters as much as the rule: a declined keystroke must be left
**unconsumed** so it continues to the host's own shortcut handling. In the
reference client the view returns the client's own "did you forward it?" answer
as its key-event result, so there is no separate pass-it-on path that could fall
out of step with the policy.

### What each keystroke sends

Applied in this order:

| Keystroke                                                                            | Sends                                                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Any chord modifier held, key not explicitly opted in                                 | **nothing**; leave unconsumed                                                                                     |
| `Escape`                                                                             | one `input/pressButton` with `back`                                                                               |
| `Enter`, `Tab`, `Backspace`, `Delete`, `ArrowUp/Down/Left/Right` — **without Shift** | one `input/key` with `enter`, `tab`, `backspace`, `delete`, `arrow_up`, `arrow_down`, `arrow_left`, `arrow_right` |
| Any of those keys **with Shift held** (Shift-Tab, Shift-arrow, …)                    | **nothing**; leave unconsumed                                                                                     |
| A printable **ASCII** character (`U+0020`–`U+007E`)                                  | one `input/typeText` with that single character, in **append** mode                                               |
| A printable character outside that range (`é`, `€`, CJK, emoji)                      | **nothing**; leave unconsumed                                                                                     |
| Anything else (function keys, a modifier pressed alone, a dead key)                  | **nothing**; leave unconsumed                                                                                     |

A key with a device meaning **wins over the character it produced**. Hosts report
a control character for Enter, Tab and Backspace; typing those as text would put
a literal newline in a text field instead of pressing the key.

**Shifted device keys are declined, never downgraded.** `input/key` transmits no
modifiers — its contract rejects them — so the only thing that _could_ be sent
for Shift-Tab is bare `tab`, and that is a semantically different keystroke:
Shift-Tab moves focus **backward**, `tab` moves it forward; Shift-arrow extends a
selection, a bare arrow abandons it. The same governing rule as characters
applies — never deliver a different keystroke than the user pressed — so the
stroke is left unconsumed and the host (which can honor the shifted form) keeps
it. Shifted _characters_ (`A`, `?`) are unaffected: they arrive as characters
that already encode the shift.

**Text must be appended, never set.** `input/typeText`'s default Android path is
`ACTION_SET_TEXT`, which _replaces_ the focused field's contents. A client sending
one character per keystroke through it would type `abc` as "a", then "b", then
"c" — final value `c` — and would wipe any text already in the field on the first
key. Pass `mode: "append"`, which routes through the platform's non-destructive
append primitive and adds to the field instead. This is a hard requirement, not a
tuning knob.

`mode: "append"` is supported on both platforms. Android realizes it with real
key events; iOS routes it to CtrlProxy's focused-field insert primitive, which
calls XCUITest `typeText` at the current caret without clearing or resolving a
resource id. The desktop client therefore forwards printable text on both
platforms and marks every per-keystroke request as append.

**Only printable ASCII is forwarded, because that is exactly what append can
type.** Append works by injecting real Android key events, and the daemon's
character→keycode table (`src/features/action/asciiKeyEvents.ts`) covers
`U+0020`–`U+007E` and nothing else. Forwarding a character outside that range
would lose the keystroke _twice_: consumed at the host, then rejected by the
device. So a non-ASCII character is declined and left unconsumed — never
swallowed. The governing rule for a porting client is: **never consume a
keystroke you cannot deliver.** Typing accented or non-Latin text on a device
belongs to the device's own IME, not to keystroke mirroring.

One gap is deliberately left to the daemon rather than to the client. Uppercase
letters and shifted symbols need `input keycombination`, which exists only on
Android 12 (API 31) and newer, and a client cannot see the device's API level.
Refusing every shifted character would make capitals untypable on _every_ device
in order to protect the older ones, so those characters are forwarded; on an
older device the daemon answers with an actionable error
(`append cannot type "A" with Android key events`) that the client surfaces
through its normal error path. A reported failure, not a silent loss.

`Escape` is the only key bound to a device _button_, and deliberately so.
Escape→back is the mapping Android itself applies to a hardware ESC key, and
`pressButton` works on both platforms. Every other device button — `home`,
`recent`, `power`, `volume_up`, `volume_down`, `menu` — has no unambiguous
keyboard key; binding `home` to the Home key would make a keystroke that means
"move to line start" everywhere else silently throw the user out of the app under
test. Buttons with no natural key belong on an explicit on-screen affordance.

### Unsupported keys

Two different situations, handled differently:

- **The client has no mapping** (a function key, a dead key, a supplementary code
  point that cannot be one UTF-16 unit). Send nothing, show nothing, leave the
  event unconsumed. Silence is correct: the user did not ask for a device action,
  and the host may still want the key.
- **The client maps it but the device cannot accept it.** `input/key` is
  Android-only; on iOS the daemon answers with an actionable error. Surface it
  through the same error path as any other failed input rather than swallowing
  it.
- **The character is outside printable ASCII.** Dropped before any request is
  made, for the same reason and with the same handling: the append path has no
  key event for it, so consuming the keystroke would lose it at both ends.

### Scope

One keystroke produces at most one daemon request. This is **not** IME
composition: dead keys, multi-keystroke composition and supplementary-plane
characters are out of scope, and a code point that cannot be expressed as a
single UTF-16 unit is dropped rather than sent as half a surrogate pair.

Only the key **press** forwards. The matching release is left unconsumed, so a
host that tracks key releases still sees them and no keystroke is sent twice.

### Ordering and refresh

Keyboard, text and button inputs travel the **same** ordered, bounded dispatch
queue as taps and swipes, so a tap-then-type sequence reaches the device in the
order the user made it, and a successful keystroke starts the same post-input
refresh wait a successful tap does. A
keystroke the policy ignored is **not** an input: it starts no wait and shows no
error.

One consequence of sharing the bounded queue: **consumption is not the same
question as "did it reach the device"**. A keystroke the policy accepted is
consumed even when the queue rejected it — the overload error has already been
surfaced, and letting the key fall through to the host afterwards would type into
the host's own UI as a consolation prize for a dropped device input. The boolean a
client's key handler returns should therefore be read as _"should this event be
consumed"_, not as _"was this forwarded"_.

## Fit-to-viewport sizing

Given the rotation-aligned image size (`imageWidth`, `imageHeight`), the viewport
size, and a per-side `padding` (default `32`):

```text
aspect = imageHeight / imageWidth                   // fallback 2.16 if imageWidth <= 0
maxW = max(viewportWidth  - padding*2, 1)
maxH = max(viewportHeight - padding*2, 1)

if (maxW * aspect <= maxH) {                         // width-constrained
  frameWidthPx  = maxW
  frameHeightPx = maxW * aspect
} else {                                             // height-constrained
  frameHeightPx = maxH
  frameWidthPx  = maxH / aspect
}
```

The initial "fit to screen" zoom scale is:

```text
fitScale = clamp( min( viewportWidth  / (frameWidthPx  + padding*2),
                       viewportHeight / (frameHeightPx + padding*2),
                       1.0 ),
                  0.3, 1.0 )
```

The frame is never scaled above `1.0`, and the scale floor is `0.3`.

## Rotation

Rotation is resolved up front by comparing the screenshot's portrait/landscape
orientation to the hierarchy root's, and rotating the screenshot to match:

| Screenshot | Hierarchy bounds | Rotation applied to screenshot |
| ---------- | ---------------- | ------------------------------ |
| portrait   | portrait         | none (`0`)                     |
| landscape  | landscape        | none (`0`)                     |
| portrait   | landscape        | 90° clockwise (code `3`)       |
| landscape  | portrait         | 270° clockwise (code `1`)      |

Any non-positive dimension yields `0`. A 180° flip (code `2`) is never inferred
from orientation alone. After this step, `deviceWidth`/`deviceHeight` are the
rotation-aligned dimensions, and the mapping formulas above apply with no further
rotation term.

## Testing

The mapper is pure Kotlin with no Compose or daemon dependency, so it is unit
tested directly (`DeviceScreenCoordinateMapperTest`) without rendering a device
or opening a socket: scale, pan, aspect fit, rotation detection, rounding,
out-of-bounds, round-trip, and the inspector selection/deselection path.

The unit change is pinned from both ends. `DeviceControlPolicyTest` asserts that
the _same_ geometry pair is rejected under `coordinateSpace: "px"` and accepted
without it, that the rotation transpose still passes in exact mode, and that a
declaration on only one of the two messages falls back to the legacy comparison.
`CanonicalPixelClientMigrationTest` pins the inspector side: overlay placement,
hit-testing and rotation detection all come out identical whether bounds arrive as
iOS points or as the same screen's canonical pixels, because every mapping ratio
has hierarchy geometry on both sides.

The drag policy is likewise pure and unit tested directly
(`DeviceDragGesturePolicyTest`), pinning the threshold from **both** sides — one
coordinate below it must not swipe and exactly at it must — plus end-clamping,
the off-screen start, and the degenerate-screen case. View-level routing
(`DeviceScreenViewControlTest`) renders the real view with fakes and covers a
control-mode drag reporting exactly one swipe and **no** tap, a sub-threshold
movement still reporting a tap and no swipe, and an inspector-mode drag reporting
nothing.

The keyboard policy is pure too (`DeviceKeyboardInputPolicyTest`), pinning the
chord rule from **both** sides — every chord modifier must stay with the host,
and Shift must **not**, or capitals become untypable — plus the Alt-composition
allowance keyed on the host-resolved `altComposesText` flag (a resolved composition
with a typable character types; one the host did not resolve — a Windows/Linux
`Alt+F` menu accelerator — stays with the host even though it reports a printable
char),
key-over-character precedence, the control-character filter, the character-keyed
chord allowlist, and the printable-ASCII range from both
sides (every character in `U+0020`–`U+007E` forwards; `é`/`€`/CJK are declined and
left unconsumed). `DeviceKeyboardEventTranslatorTest` pins the platform-aware
resolution of that flag (native AltGraph composes on Linux; Ctrl+Alt remains the
Windows fallback; plain Alt composes on macOS; Meta never does) end-to-end through
the policy, parameterized by injected platform and AltGraph inputs so every branch
is deterministic. `InputText.test.ts` pins the daemon append mode itself: it
issues key events and makes **no** `ACTION_SET_TEXT` call and **no** clear, so N
single-character calls accumulate; that uppercase fails with an actionable error
below API 31 and succeeds at 31+; and that every adb round trip is charged against
the caller's timeout budget. `socketServerInputTypeText.test.ts` pins the same
through the socket against a fake adb, including that a stalled adb call answers
inside the request budget and leaves the per-device queue free for the next input.
The same socket suite and CtrlProxy command-handler tests pin the iOS append route:
three single-character calls reach the focused-field insert primitive in order and
never use the resource-targeted replace operation.
`DeviceKeyboardEventTranslatorTest` pins the toolkit-key translation.
`DeviceControlSessionKeyboardTest` asserts the exact daemon payloads a keystroke
produces against a fake client, that keyboard shares the one ordered queue with
taps, and that a successful keystroke starts the same post-input refresh wait.
View-level routing (`DeviceScreenViewKeyboardTest`) observes **both** what the
view forwarded and what an ancestor host handler still received, so
"host shortcuts are not swallowed" is checked rather than assumed, alongside the
focus and mode gates, click-to-refocus, and — composed under an ancestor with the
shell's real preview handler — that Escape/Enter/arrows/Tab actually survive it.

## Which frame the mapping runs against

This document defines the mapping. It deliberately says nothing about _which_
frame a control client is allowed to map against, or what the client shows after
it forwards an input — a coordinate mapped correctly through a stale frame still
taps the wrong pixel. Use one coherent screenshot-and-hierarchy snapshot from
the selected device, pin that snapshot for the complete gesture, and wait for a
newer coherent frame after dispatch before presenting the input as complete.
