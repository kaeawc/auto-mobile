# Prototype web window draws inside the safe area

- Kind: decision
- Date: 2026-11-26
- Source: #19372, #19373
- Shaped: [Prototype web renderer: frames](../how-it-works/prototype-web-renderer-frames.md)

## Context

The framed web preview drew a fullscreen window edge to edge, as the CtrlProxy overlay does
(#16588). Content without `safeAreaPadding` sat under the status bar and cutout: on the reference
checkout, the first line of each screen drew under the clock. ProtoViewer, the viewer the owner
compares the preview with, pads its renderer by `WindowInsets.safeDrawing`, and the iOS ProtoViewer
keeps content in the container safe area. The iOS parity goldens come from the iOS Viewer app,
which ignores the safe area.

In the same preview, a row's `minWidth` overflowed its parent unless the row held a capped aspect
ratio (#19373). Compose's `sizeIn` coerces the minimum into the incoming width for every row.

## Options

- Keep edge to edge and leave insets to `safeAreaPadding`.
- Pad the framed fullscreen window by the safe area, as ProtoViewer does, and keep an edge-to-edge
  option for the iOS parity check.
- For `minWidth`, emit `min(100%, minWidth)` on every row. In a wrap-sized parent the intrinsic
  width reads the percentage as zero, so the parent would collapse to its content.

## Decision

A framed fullscreen window pads every edge by the frame's inset and consumes it. The band behind
the status bar takes the colour just below it, so the status bar content keeps its contrast. The
`edgeToEdge` still option keeps the old drawing for the iOS parity check. Chromeless screens,
sheets and floating windows are unchanged.

A `fill` row clamps its `minWidth` with `min(100%, minWidth)`. A content-width row outside a row
holds its minimum in the strut cell a later sibling's minimum uses, capped at the parent's width.

## Consequences

Every framed golden moves down by the top inset. Tests of `safeAreaPadding` mechanics render in a
full-height sheet, where the window leaves the insets to its content.
