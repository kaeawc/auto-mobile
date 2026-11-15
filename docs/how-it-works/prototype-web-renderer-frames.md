# Prototype web renderer: skins, frames and frame registry

Part of [the prototype web renderer](prototype-web-renderer.md).

- **Posture.** A foldable frame draws the panel its `posture` lights (default `opened`, else its
  first posture; a frame without postures takes none, and an unknown posture is an error listing
  the frame's): `closed` draws the cover panel. The spec lays out on that panel in the drawn
  orientation, minus an occluding hinge's width, shown in the two segments either side of the
  hinge (the second copy `aria-hidden` and inert); a seamless fold lays out across the whole
  panel and draws a crease shaded by its `hingeDegrees`, none when flat. Landscape turns the
  hinge with the panel, so a flip's hinge runs top to bottom there.
- **Skins.** `webSkin.ts` holds one skin per platform; the frame's platform picks it and the
  `skin` option overrides it. A skin replaces the renderers of the components its platform draws
  natively (`designCoverage` `native` in `schemas/prototype-spec-contract.json`), and those of the
  Material components the iOS renderer draws with SwiftUI defaults; every other component draws
  the shared Material 3 renderer on both. A node's `ios` namespace is read only in
  the iOS skin and its `android` namespace only in the Android one. The Android skin replaces
  nothing. The iOS skin draws `button` as the iOS renderer's SwiftUI styles at the regular control
  size in the 17 px body style (scaled by the frame's Dynamic Type size), tinted with the theme's `primary`: `filled` is a 6 px-radius tint fill
  under white text with 7x12 px padding, `tonal` the tint at 0.15 opacity under tint text,
  `elevated` that with a 1 px shadow, `outlined` a 1 px tint capsule with 8x16 px padding, `text`
  bare tint text; `ios.buttonStyle` draws `glassProminent` as a filled and `glass` as a tonal
  capsule, without blur. Its `slider` is the system slider: its label 4 px above a 28 px row whose
  4 px track is systemBlue up to the value and systemFill after it, under a white 28 px thumb whose
  centre travels 14 px inside each end; the value is its state, else `min`, clamped and not
  snapped. Its Material components follow the iOS renderer's SwiftUI views (text sizes are
  body 17, subheadline 15, `.title3` 20, `.title` 28 and `.largeTitle` 34 px, scaled by the frame's
  Dynamic Type size): `switch` is a body label filling a 44 px row before a 51x31 capsule track (`primary` on,
  `surfaceContainerHighest` off) with a 27 px thumb; `checkbox` is a 17 px check square, filled
  when checked, 8 px before its label; `listItem` has a body headline over a subheadline
  `onSurfaceVariant` supporting line, 56 px tall or 72 px with one, and that switch track or check
  square as its trailing control; `chip` is 32 px with 12 px padding in the medium subheadline style
  and the content colour, in a 44 px target; `topAppBar` is a 64 px row padded 4 px with 48 px icon
  buttons and a `.title3` semibold title (12 px in, 4 px after a navigation icon), or a `.title`
  (medium) or `.largeTitle` (large) line below the row, framed at 48 or 88 px with an
  `enterAlways` or `exitUntilCollapsed` `onScroll`; `card` is `surfaceContainerHigh` when
  filled, else `surface`, with an `outlineVariant` outline when outlined. Like the iOS renderer,
  the skin ignores `ios.navigationTitle` and `ios.sheet.sizing`. `textField` with a label,
  variant, supporting text or `maxLength` puts its `.footnote` `onSurfaceVariant` label 4 px above
  an input padded 12 px (`filled`: a `surfaceContainerHighest` fill with 4 px top corners over a
  1 px `outline` line; `outlined`: a 1 px 4 px-radius `outline` stroke; red on an error) and a
  `.caption` row of supporting text and the `count/max` counter below; otherwise it is a
  rounded-border input. The label never floats, an empty field shows only its placeholder, icons sit
  4 px beside the field and the error message is a red `.caption` line below it. `bottomNav`
  spaces items 8 px on `surfaceContainer`, padded 12 px above and 4 px below, each a 64x32
  `secondaryContainer` capsule over a `.caption` label (semibold when selected, else medium) in at
  least 64 px. `tabBar` has no background or divider: each tab is its icon over a `.caption` label,
  2 px apart, at least 44 px tall (64 px when it minimizes), the selected one in a capsule. An
  iOS `bottomSheet` centres its child 8 px below a 36x5 handle 6 px from the top, on `surface`
  with a 16 px radius. `timePicker`, `datePicker` and `pasteButton`
  are still placeholders on both skins.
- **Frame.** The screen has the frame's size for the orientation, its corner radius and bezel, a
  generic status bar, the cutout (an `island` draws as a pill, a punch hole as a circle) and the
  navigation chrome: Android's handle (`data-nav="handle"`) or three generic button marks, which move to
  the right edge in landscape when the frame reserves that inset, and iOS's home indicator
  (`data-nav="homeIndicator"`). The status bar is never a picture of a real OS: a clock and generic
  cellular, Wi-Fi and battery marks (`data-status` with a `data-level`) drawn from a fixed state (9:41,
  four bars, Wi-Fi on, full battery). In the interactive page the runtime rewrites every clock from
  the browser's local time in the same `h:mm` 12-hour form, re-armed at each minute boundary. An iPhone with an island centres the clock and the marks in the
  ears beside it; Android puts them at the start and end. Its content is light or dark: `window.statusBar`
  `light` or `dark` picks it, and `auto` or none takes whichever of white or black contrasts more with the
  app's top colour. The top colour comes from geometry, not from reading CSS properties one by one: a
  small layout pass places the window's content on the screen (flex lines with growth and shrink, gaps, arrangement
  and alignment, a reversed line placed from its end, one-cell boxes, collection grids' column tracks, block flow, minimum and maximum sizes, aspect ratio, padding including
  the safe-area insets, absolute insets, relative offsets and translations, overflow clips, corner radii, and CSS paint
  order with z-index), then samples evenly spaced points along the screen's top edge. A point in a rounded
  corner's cut-away region is outside the box: neither its background nor its overflow clip's descendants
  paint there, so a circle meets the top edge at one point. Logical corners follow the element's
  direction, so right to left rounds the opposite side. A box of unmeasured height keeps square
  corners, because its real height could scale the radii down. At each point the
  last opaque background painted there is the colour, else the screen background; the colour at the most
  points wins. Element opacity multiplies down the tree, so a background counts only when it is opaque
  after that opacity, and a fully transparent subtree paints nothing. The window placement is part of the
  layout, so only what a window paints at the top edge counts: a bottom sheet or a small centred floating
  window leaves the screen background there, while a wide floating panel at `topStart` that reaches the
  edge sets the colour. Text and other unsized content are not measured: an unknown height or offset is
  taken as non-zero, a content-sized width covers nothing (a wrapper whose in-flow children all have
  measurable sizes takes their stacked or largest size, padding included), a flex item whose automatic minimum depends on that content does not shrink, and a box, row or column child with no self-alignment starts at its container's
  start as the renderer emits it. A subtree that starts below the top edge inside an overflow clip, or
  behind a transform other than a translation, is not laid out. Landscape swaps the screen size, uses
  the landscape safe areas, and moves the cutout from the top edge to the left edge. A frame whose
  landscape top inset is 0 (an iPhone) draws no status bar in landscape. `safeAreaPadding` adds the inset on each named edge to the node's padding; like
  `windowInsetsPadding`, an edge an ancestor already applied adds nothing more, and an inset adds to a component's own
  padding on that edge (`ime` adds nothing,
  since the still has no keyboard). Safe areas are exposed as
  `--safe-top`, `--safe-bottom`, `--safe-left` and `--safe-right`. Both devices draw a
  window's content edge to edge and a top app bar takes no inset of its own, so it clears the
  status bar only through `safeAreaPadding`; likewise content clears the landscape cutout side
  (an iPhone's 59 pt left inset) only through `safeAreaPadding` on the `start` edge.
- **Determinism.** Serialization writes attributes and style properties in sorted order, so the
  same input renders the same bytes. Event-handler attributes are rejected.

## Device frame registry

`src/features/prototype/web/deviceFrames.json` is data only: adding a device is one entry, with
no code change. `deviceFrameSchema.ts` holds its strict schema, and the registry's unit test
validates every entry, so an invalid entry fails CI instead of rendering wrong geometry. The
registry is not validated at load: `deviceFrames.ts` stays free of zod so the still renderer
bundles for the browser (see [Prototype web library](prototype-web-library.md)), and fills the
schema's defaults and `inner` panel itself; a unit test holds that result equal to the schema's
parse.

It is called a _frame_ registry, never a device profile, because `deviceProfile` already means
the session broker's OEM manufacturer profiles.

Each entry records:

- `screen`: portrait width and height in dp (points on iOS) and the density.
- `cornerRadiusDp`, the `cutout` (`none`, `punchHole`, `notch` or `island`, with its geometry),
  `statusBarDp` and the `navBar` (`none`, `gesture` or `buttons`).
- `safeArea` for portrait and landscape. Landscape is stored, not derived, because a cutout and
  the navigation bar move to different edges on each platform.
- `frame`: the bezel width and colour drawn around the screen.
- `source`: where the screen geometry and the insets came from. Values not yet measured on an
  emulator or simulator say so, and replacing them with measured values is a data change. Sources
  live in `deviceFrameSources.json`, keyed by frame id, because only the schema test reads them;
  the renderer imports `deviceFrames.json`, so provenance stays out of the browser bundle. The
  test validates each entry with its source merged back in, and rejects a frame without a source
  or a source naming no frame.

Beyond the schema, a registry is invalid when two entries share an id, a cutout lies outside the
portrait screen, or a safe area leaves no screen in either orientation.

When a request names no frame, the default is `pixel-9` for Android and `iphone-16` for iOS. An
unknown frame id is an error that lists the valid ids.
