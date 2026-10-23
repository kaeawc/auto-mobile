# Client Screen Control: coordinate mapping contract

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

Part of milestone 28 (Client Screen Control), parent [#1099](https://github.com/kaeawc/auto-mobile/issues/1099).
New to screen control? Start at the [daemon overview](../daemon.md), then use
this contract for the coordinate, gesture, keyboard, frame, and refresh rules.

This document specifies how a mirrored device screen converts a **viewport point**
(a pixel clicked/dragged on the rendered canvas) into a **device coordinate** for
the typed daemon input helpers (`inputTap`, `inputSwipe`), and the client-side
policies that decide which pointer and keyboard gestures become daemon input at
all. It is written so a third-party daemon client can reproduce all of it without
reading Compose code. The reference implementation is the Compose-free
`DeviceScreenCoordinateMapper` in the `desktop-domain` module
(`dev.jasonpearson.automobile.desktop.domain`); the desktop inspector's
`DeviceScreenView` delegates to it.

## Interaction modes

A device-screen view honors one of two modes (`DeviceScreenControlMode`):

- **Inspector** (default) — a click selects the deepest UI element under the
  cursor and hover highlights elements. Default so existing consumers (including
  the Android IDE plugin, which shares `desktop-core`) are unaffected.
- **Control** — a click maps to a device coordinate forwarded as a tap, a drag
  maps to a start/end pair forwarded as a swipe (see
  [Drag-to-swipe policy](#drag-to-swipe-policy)), and a keystroke received **while
  the view holds focus** maps to a button press, a discrete key or typed text (see
  [Keyboard forwarding policy](#keyboard-forwarding-policy)). Element selection and
  hover highlighting are suppressed.

Control mode is strictly opt-in. The view never sends daemon input itself; it
reports the mapped coordinate or keystroke to a caller-supplied callback, and
wiring that to `inputTap`/`inputSwipe`/`inputPressButton`/`inputTypeText`/`inputKey`
is the client's job
([#3347](https://github.com/kaeawc/auto-mobile/issues/3347),
[#3350](https://github.com/kaeawc/auto-mobile/issues/3350),
[#3351](https://github.com/kaeawc/auto-mobile/issues/3351)).

## Coordinate spaces

| Space        | Origin                              | Units                                                            |
| ------------ | ----------------------------------- | ---------------------------------------------------------------- |
| **Viewport** | top-left of the rendered canvas     | canvas pixels, before pan/zoom are removed                       |
| **Frame**    | top-left of the fitted device frame | frame pixels at zoom 1.0                                         |
| **Device**   | top-left of the device screen       | same space as hierarchy `bounds` — **canonical physical pixels** |

Device coordinates share the hierarchy `bounds` system, so a mapped point can go
straight to element hit-testing (inspector) or the daemon input helpers (control).

### One unit, both platforms

There is **one** device unit on Android and iOS: physical pixels in the current
orientation. A message carrying `coordinateSpace: "px"` states this for its
`bounds` and `screenWidth`/`screenHeight`, and the daemon accepts pixels on
`input/tap` and `input/swipe` for that device. A client needs no platform-specific
unit knowledge. Internally, iOS runners report logical points, so the daemon
multiplies by the runner-reported `nativeScale` when publishing and divides by it
(exactly, no rounding) when dispatching input. Android is already pixels
(`nativeScale` 1).

> **Legacy fallback.** A message with **no** `coordinateSpace` comes from a daemon
> or runner that predates canonical pixels ([#4548](https://github.com/kaeawc/auto-mobile/issues/4548)).
> There, and only there, iOS `bounds` are logical points while the screenshot is
> pixels, so the two are not directly comparable and input coordinates pass through
> untouched. The mapping formulas are ratio-based and unit-agnostic, but a client
> must not compare the frame's absolute dimensions against the bounds' declared
> space. Never infer pixels from a missing field, and never treat an _unrecognized_
> declaration as this fallback: that is a daemon newer than the client, so control
> must fail closed on that frame. Only an absent field is the legacy point space.

## Rendering pipeline

1. **Rotation alignment.** The raw screenshot may arrive in native (portrait)
   orientation while hierarchy bounds are in display orientation; it is rotated to
   match first (see [Rotation](#rotation)).
2. **Aspect fit.** The image is sized to fit the viewport minus per-side padding,
   preserving aspect ratio (see [Fit-to-viewport sizing](#fit-to-viewport-sizing)).
3. **Zoom + pan.** A uniform zoom `scale` and pan `offset` (viewport pixels) are
   applied on top.

Because step 1 pre-rotates, viewport↔device is a plain scale + translate.

## Geometry inputs

A client builds a geometry snapshot once per rendered frame:

| Field                           | Meaning                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `frameWidthPx`, `frameHeightPx` | fitted frame size at zoom 1.0 (from fit-to-viewport)                    |
| `scale`                         | current zoom multiplier                                                 |
| `offsetX`, `offsetY`            | current pan offset, in viewport pixels                                  |
| `deviceWidth`, `deviceHeight`   | coordinate-space size: positive root bounds or paired screen dimensions |

## Viewport-to-device mapping

```text
frameX = (viewportX - offsetX) / scale
frameY = (viewportY - offsetY) / scale

frameToDevice = deviceWidth / frameWidthPx          // guard: 1.0 if frameWidthPx <= 0

deviceX = round(frameX * frameToDevice)
deviceY = round(frameY * frameToDevice)
```

- **Width-based scale for both axes.** Exact because the frame is fitted to the
  device aspect ratio.
- **Rounding.** Round-to-nearest, halves **up** (Kotlin `roundToInt` /
  `Math.round`: `0.5 -> 1`, `-0.5 -> 0`).
- **Out of bounds.** The mapping **never clamps**. It returns the raw rounded
  coordinate plus `inBounds`, true iff
  `0 <= deviceX < deviceWidth && 0 <= deviceY < deviceHeight` (right/bottom
  exclusive). Inspector hit-testing depends on this: an outside click matches no
  element and clears the selection. A **control** client must not tap an
  out-of-bounds point: drop it, or clamp to `(deviceWidth - 1, deviceHeight - 1)`.
  Clamping is valid only when **both** dimensions are positive; with a zero
  dimension the client must **drop** the point (`DevicePoint.clampedTo` reports
  `inBounds = false`).

Inverse, for overlays and touch-feedback markers:

```text
deviceToFrame = frameWidthPx / deviceWidth          // guard: 1.0 if deviceWidth <= 0
viewportX = deviceX * deviceToFrame * scale + offsetX
viewportY = deviceY * deviceToFrame * scale + offsetY
```

Modulo integer rounding the two directions round-trip.

## Drag-to-swipe policy

With gesture streaming disabled (default), or when the daemon does not advertise
`input/gestureStream`, a Control-mode drag becomes exactly one `input/swipe`. With
the experimental `-Dautomobile.gesture.streaming=true` flag and a capable daemon,
the reference client sends an `input/gestureStream` start/move/end sequence from
the first move. If streaming cannot start, the workspace video surface falls back
to the atomic policy below (same threshold and duration rules); the
inspector-control surface instead reports the rejected stream and does not
synthesize a swipe.

Everything below is **client-side policy**: the daemon executes whatever endpoints
and duration it is handed, so it can neither reject an accidental one-pixel swipe
nor repair an off-screen one. Reference: Compose-free `DeviceDragGesturePolicy`
([#3350](https://github.com/kaeawc/auto-mobile/issues/3350)).

**One frame for the whole drag.** Both endpoints map through the same snapshot,
pinned at drag start. A snapshot arriving mid-drag must not rescale the gesture.

### Threshold and duration

| Rule                                                               | Value                                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Minimum travelled distance, frame declares `coordinateSpace: "px"` | **`24 * nativeScale` device coordinates** (physical pixels)                                     |
| Minimum travelled distance, legacy frame (no declaration)          | **24 device coordinates** (logical points)                                                      |
| Measurement                                                        | straight-line (Euclidean), in **device** coordinates, **after** the end is clamped              |
| Below the threshold                                                | send **nothing** — not a swipe, and **not** a tap either                                        |
| Duration sent                                                      | measured pointer-down duration, clamped to **40–1000 ms**; **300 ms** fallback when unavailable |

- The threshold is in **device** coordinates, not viewport pixels, so it means the
  same at any zoom (a viewport threshold would turn pointer jitter into a large
  gesture when zoomed out).
- In the point space, `24` sits just above both platforms' touch slop. A pixel
  frame publishes the matching finite, positive `nativeScale` on both its
  hierarchy and screenshot messages; the daemon divides by the same scale before
  an iOS gesture reaches the point-based runner, preserving 24 points at every
  scale. Android publishes `nativeScale: 1`.
- A pixel frame without matching finite, positive scale metadata is not safe for
  control: fail closed rather than guess, and do not retain a frame after its
  scale changes.
- **Paired declarations are all-or-nothing.** A screenshot/hierarchy pair is a
  canonical-pixel frame only when **both** declare `coordinateSpace: "px"` and
  carry the same finite, positive `nativeScale`. If one omits the declaration or
  they differ, the client binds neither into the snapshot and uses the legacy
  aspect-only check and unscaled 24-unit threshold; it never combines the `px`
  message's scale with an undeclared counterpart. When both declare pixels but
  scale metadata is absent, invalid or unequal, control fails closed.
- A below-threshold drag is **not** promoted to a tap: actuating an input the user
  did not ask for is worse than ignoring an ambiguous one. The consequence is a
  deliberate **dead band** between the toolkit's touch slop and this threshold in
  which a gesture sends nothing.
- Duration preserves the user's pointer-down time so a flick stays high velocity.
  The 40 ms floor still gives the device enough motion events to recognize a
  fling; the 1000 ms cap avoids a long replay. All values sit inside the daemon's
  `[1, 60000]` `durationMs` range.

### Cancellation and out-of-bounds

| Situation                                                     | Behavior                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Drag **cancelled** (pointer capture lost, window deactivated) | send nothing                                                        |
| Drag **started** outside the device screen                    | send nothing — clamping would invent a start the user never touched |
| Drag **ended** outside the device screen                      | **clamp** the end to the last addressable pixel and send            |
| Device screen has a non-positive dimension                    | send nothing (no addressable pixel to clamp to)                     |
| Drag outside Control mode                                     | send nothing; a drag means viewport pan                             |

Dragging past an edge is the ordinary way to scroll to the end of a list, so an
out-of-bounds end is clamped, and clamping happens **before** the distance check.
An ignored drag surfaces no error and starts no post-input refresh wait.

### Viewport pan in Control mode

A plain drag is a device swipe in Control mode, so pan moves onto the modifier that
already gates zoom (Cmd on macOS, Ctrl elsewhere): **modifier + drag pans, plain
drag swipes**. The modifier is read once at pointer-down, so releasing it mid-drag
cannot turn a pan into a swipe. In Inspector mode a plain drag still pans and never
produces daemon input.

## Keyboard forwarding policy

Keyboard, text and device-button forwarding is **client-side policy** like the drag
rules: `input/pressButton`, `input/typeText` and `input/key` execute whatever they
are handed. Reference: Compose-free `DeviceKeyboardInputPolicy`
([#3351](https://github.com/kaeawc/auto-mobile/issues/3351)). This section targets
a client author embedding control mode in their own host and does not enumerate any
one host's keymap.

### When keyboard input forwards at all

| Condition                                       | Why                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The device-screen view **holds keyboard focus** | Forwarding without it would type into the device while the user is filling in a field elsewhere in the host             |
| The view is in **Control** mode                 | Inspector mode produces no daemon input of any kind, which keeps an inspector-only embedder (the IDE plugin) unaffected |

- Use the toolkit's own focus routing, not global capture: the reference client
  attaches its handler to the focusable device-screen node. The view takes focus
  when it **enters** control mode **and again when the canvas is clicked** (the
  only affordance a user has once something else took focus).
- **Beware ancestor preview handlers.** A host that resolves navigation shortcuts
  in a preview/capture-phase handler will consume Tab, arrows, Enter and Escape
  before the canvas sees them. The host must stand that handler down while the
  canvas holds focus, but only for **keystrokes the policy will claim**, decided
  per event, not by a blanket "canvas is focused" flag: toolkits do not rerun a
  preview handler while an unconsumed event bubbles up, so a blanket flag creates a
  dead zone where a declined keystroke reaches neither device nor host. The
  reference client asks `DeviceControlSession.wouldForwardKey` (the same decision
  as dispatch); chords answer "no", so chorded host shortcuts keep working.
- Control mode is **inert without a frame snapshot** (same fail-closed rule as
  taps and drags).

### Host shortcuts

**A keystroke with Ctrl, Alt or Meta (Cmd/Win) held belongs to the host and is not
forwarded.** Shift is **not** a chord modifier (it produces capitals and shifted
symbols).

One exception: **Alt-family character composition** (AltGr, macOS Option), which is
platform-dependent, so the host resolves it:

```text
altComposesText = printable && !meta && when {
  isMac -> alt && !ctrl
  isLinux && nativeAltGraph != null -> alt && nativeAltGraph
  else -> ctrl && alt
}
```

- **Linux:** AltGr via AWT's native `isAltGraphDown()`. A real Ctrl+Alt shortcut
  has it unset and stays with the host.
- **Windows:** AltGr, but many JDKs surface it only as **Ctrl+Alt** with the native
  flag unset, so the Ctrl+Alt fallback is retained. Plain Alt (no Ctrl) is a menu
  accelerator and must not count as composition.
- **macOS:** Option is plain Alt (Option+L = `@`) and menus use Cmd, so Alt without
  Ctrl is composition; Ctrl+Option stays with the host.
- **Meta never qualifies** anywhere.

The toolkit adapter resolves this where platform and AWT masks are visible
(`DeviceKeyboardEventTranslator`) and passes `DeviceKeyStroke.altComposesText`; the
policy then forwards only when a **typable ASCII** character was produced. A port
must make the same platform-aware decision rather than infer from `alt && printable`.

**Known limitation (Windows).** `ctrl && alt` is a heuristic: requiring the
`ALT_GRAPH` mask would regress AltGr typing (`@`, `€`, `{`) on JDKs that leave it
unset. A genuine Ctrl+Alt host shortcut producing a printable character may
therefore be forwarded to the device on Windows.

A client may opt a chord in with `forwardedChords` (default **empty**). Entries
match a device key **or a produced character**, case-insensitively (letter chords
like Ctrl-S have no device key), and each names the **exact chord-modifier set**
(`ctrl`/`alt`/`meta`) it forwards, so `OfCharacter('s', ctrl = true)` forwards
Ctrl-S only; Meta-S and Alt-S stay with the host. Shift is not part of the match.

A declined keystroke must be left **unconsumed** so it reaches the host's own
shortcut handling. The reference view returns the client's own "did you forward
it?" answer as its key-event result, so no separate pass-through path can drift
from the policy.

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

- A key with a device meaning **wins over the character it produced** (hosts report
  control characters for Enter/Tab/Backspace; typing those would insert a literal
  newline).
- **Shifted device keys are declined, never downgraded.** `input/key` carries no
  modifiers, so Shift-Tab could only become bare `tab` (focus forward vs backward),
  Shift-arrow bare arrow (abandons selection). Never deliver a different keystroke
  than pressed. Shifted _characters_ (`A`, `?`) already encode the shift.
- **Text must be appended, never set.** The default Android `input/typeText` path
  is `ACTION_SET_TEXT`, which _replaces_ the field, so per-keystroke sends would
  leave `c` for `abc` and wipe existing text. Pass `mode: "append"` (hard
  requirement). Android realizes it with real key events; iOS routes it to
  CtrlProxy's focused-field insert primitive (XCUITest `typeText` at the current
  caret, no clearing, no resource id). The client forwards printable text on both
  platforms.
- **Only printable ASCII is forwarded**, because the daemon's character→keycode
  table (`src/utils/android-cmdline-tools/asciiKeyEvents.ts`) covers exactly
  `U+0020`–`U+007E`. A larger range would be lost twice (consumed at the host,
  rejected by the device). Rule for ports: **never consume a keystroke you cannot
  deliver.** Non-Latin text belongs to the device IME.
- **Uppercase and shifted symbols** need `input keycombination` (Android 12 / API 31+),
  and a client cannot see the API level; refusing them would make capitals untypable
  everywhere. They are forwarded, and an older device answers with an actionable
  error (`append cannot type "A" with Android key events`) surfaced through the
  normal error path.
- `Escape` is the only key bound to a device _button_ (matches Android's hardware
  ESC mapping; `pressButton` works on both platforms). `home`, `recent`, `power`,
  `volume_up`, `volume_down`, `menu` have no unambiguous key (Home = "line start"
  elsewhere) and belong on explicit on-screen affordances.

### Unsupported keys

- **No client mapping** (function key, dead key, code point not one UTF-16 unit):
  send nothing, show nothing, leave unconsumed.
- **Mapped but the device cannot accept it** (`input/key` is Android-only; iOS
  answers with an actionable error): surface through the normal input error path.
- **Non-ASCII character:** dropped before any request, for the reason above.

### Scope, ordering and refresh

- One keystroke produces at most one daemon request. Not IME composition: dead
  keys, multi-keystroke composition and supplementary-plane characters are out of
  scope (never send half a surrogate pair).
- Only key **press** forwards; the release is left unconsumed.
- Keyboard, text and button inputs share the **same** ordered, bounded dispatch
  queue as taps and swipes, and a successful keystroke starts the same post-input
  refresh wait. An ignored keystroke starts no wait and shows no error.
- **Consumption is not delivery.** A keystroke the policy accepted is consumed even
  if the bounded queue rejected it (the overload error was already surfaced;
  falling through would type into the host UI). Read the handler's boolean as
  "should this event be consumed", not "was this forwarded".

## Fit-to-viewport sizing

Given the rotation-aligned image size, viewport size, and per-side `padding`
(default `32`):

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

fitScale = clamp( min( viewportWidth  / (frameWidthPx  + padding*2),
                       viewportHeight / (frameHeightPx + padding*2),
                       1.0 ),
                  0.3, 1.0 )
```

The frame is never scaled above `1.0`; the scale floor is `0.3`.

## Rotation

Resolved up front by comparing the screenshot's orientation to the hierarchy
root's:

| Screenshot | Hierarchy bounds | Rotation applied to screenshot |
| ---------- | ---------------- | ------------------------------ |
| portrait   | portrait         | none (`0`)                     |
| landscape  | landscape        | none (`0`)                     |
| portrait   | landscape        | 90° clockwise (code `3`)       |
| landscape  | portrait         | 270° clockwise (code `1`)      |

Any non-positive dimension yields `0`. A 180° flip (code `2`) is never inferred
from orientation alone. Afterwards `deviceWidth`/`deviceHeight` are the
rotation-aligned dimensions and no rotation term remains.

## Testing

Policies are pure Kotlin (no Compose or daemon), unit tested directly.

| Test                                                     | Pins                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DeviceScreenCoordinateMapperTest`                       | scale, pan, aspect fit, rotation detection, rounding, out-of-bounds, round-trip, inspector selection                                                                                                                               |
| `DeviceControlPolicyTest`                                | same geometry rejected under `coordinateSpace: "px"` and accepted without; rotation transpose in exact mode; one-sided declaration falls back to legacy                                                                            |
| `CanonicalPixelClientMigrationTest`                      | overlay placement, hit-testing, rotation identical for iOS points vs canonical pixels                                                                                                                                              |
| `DeviceDragGesturePolicyTest`                            | threshold from both sides, end-clamping, off-screen start, degenerate screen                                                                                                                                                       |
| `DeviceScreenViewControlTest`                            | control drag = one swipe and no tap; sub-slop movement = tap; inspector drag = nothing                                                                                                                                             |
| `DeviceKeyboardInputPolicyTest`                          | chord rule both sides (Shift must not be a chord), Alt composition flag, key-over-character, control-character filter, chord allowlist, ASCII range                                                                                |
| `DeviceKeyboardEventTranslatorTest`                      | platform-aware composition resolution (injected platform/AltGraph) and toolkit-key translation                                                                                                                                     |
| `DeviceControlSessionKeyboardTest`                       | exact daemon payloads against a fake client, shared ordered queue, refresh wait                                                                                                                                                    |
| `DeviceScreenViewKeyboardTest`                           | what the view forwarded vs what an ancestor host handler still received; focus/mode gates; click-to-refocus; Escape/Enter/arrows/Tab survive the shell preview                                                                     |
| `InputText.test.ts`, `socketServerInputTypeText.test.ts` | daemon append mode: key events only, no `ACTION_SET_TEXT`/clear, API 31 gate, adb round trips charged to the timeout budget, stalled adb frees the queue; iOS append reaches the insert primitive, never resource-targeted replace |

## Which frame the mapping runs against

This document defines the mapping, not _which_ frame a control client may map
against. A correctly mapped coordinate through a stale frame taps the wrong pixel:
use one coherent screenshot-and-hierarchy snapshot from the selected device, pin
it for the whole gesture, and wait for a newer coherent frame after dispatch before
presenting the input as complete.
