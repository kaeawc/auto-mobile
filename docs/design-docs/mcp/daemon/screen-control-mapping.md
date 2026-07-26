# Client Screen Control: coordinate mapping contract

<kbd>🚧 In progress</kbd>

Part of milestone 28 (Client Screen Control), parent [#1099](https://github.com/kaeawc/auto-mobile/issues/1099).
This document specifies how a mirrored device screen converts a **viewport point**
(a pixel the user clicked/dragged on the rendered canvas) into a **device
coordinate** suitable for the typed daemon input helpers (`inputTap`,
`inputSwipe`). It is written so a third-party daemon client can reproduce the
mapping without reading any Compose code.

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
  the daemon input helpers as a tap (drag-to-swipe follows in
  [#3350](https://github.com/kaeawc/auto-mobile/issues/3350)). Element selection
  and hover highlighting are suppressed.

Control mode is strictly opt-in. The view itself never sends daemon input; it
only reports the mapped coordinate to a caller-supplied callback. Wiring the
coordinate to `inputTap`/`inputSwipe` is the client's responsibility
([#3347](https://github.com/kaeawc/auto-mobile/issues/3347)).

## Coordinate spaces

| Space | Origin | Units |
| --- | --- | --- |
| **Viewport** | top-left of the rendered canvas | canvas pixels, before pan/zoom are removed |
| **Frame** | top-left of the fitted device frame | frame pixels at zoom 1.0 |
| **Device** | top-left of the device screen | same space as hierarchy `bounds` — Android device pixels, or iOS logical points |

Device coordinates share the hierarchy `bounds` coordinate system, so a mapped
point can be handed directly to element hit-testing (inspector) or to the daemon
input helpers (control).

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

| Field | Meaning |
| --- | --- |
| `frameWidthPx`, `frameHeightPx` | fitted frame size at zoom 1.0 (from fit-to-viewport) |
| `scale` | current zoom multiplier |
| `offsetX`, `offsetY` | current pan offset, in viewport pixels |
| `deviceWidth`, `deviceHeight` | device coordinate-space size (root hierarchy bounds, rotation-aligned) |

## Viewport → device mapping

```
frameX = (viewportX - offsetX) / scale
frameY = (viewportY - offsetY) / scale

frameToDevice = deviceWidth / frameWidthPx          // guard: 1.0 if frameWidthPx <= 0

deviceX = round(frameX * frameToDevice)
deviceY = round(frameY * frameToDevice)
```

Notes and rules a client must reproduce:

- **Width-based scale for both axes.** The single ratio `deviceWidth /
  frameWidthPx` scales *both* x and y. This is exact because the frame is fitted
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
  deviceHeight - 1)` if pinning to the edge is desired.

### Device → viewport (inverse)

For placing overlays or touch-feedback markers, the inverse is:

```
deviceToFrame = frameWidthPx / deviceWidth          // guard: 1.0 if deviceWidth <= 0
viewportX = deviceX * deviceToFrame * scale + offsetX
viewportY = deviceY * deviceToFrame * scale + offsetY
```

Modulo integer rounding, `deviceToViewport` and `viewportToDevice` round-trip.

## Fit-to-viewport sizing

Given the rotation-aligned image size (`imageWidth`, `imageHeight`), the viewport
size, and a per-side `padding` (default `32`):

```
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

```
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
| --- | --- | --- |
| portrait | portrait | none (`0`) |
| landscape | landscape | none (`0`) |
| portrait | landscape | 90° clockwise (code `3`) |
| landscape | portrait | 270° clockwise (code `1`) |

Any non-positive dimension yields `0`. A 180° flip (code `2`) is never inferred
from orientation alone. After this step, `deviceWidth`/`deviceHeight` are the
rotation-aligned dimensions, and the mapping formulas above apply with no further
rotation term.

## Testing

The mapper is pure Kotlin with no Compose or daemon dependency, so it is unit
tested directly (`DeviceScreenCoordinateMapperTest`) without rendering a device
or opening a socket: scale, pan, aspect fit, rotation detection, rounding,
out-of-bounds, round-trip, and the inspector selection/deselection path.
