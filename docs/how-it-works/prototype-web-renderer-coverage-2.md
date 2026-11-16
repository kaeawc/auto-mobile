# Prototype web renderer: still renderer coverage of overlays, media and pickers

Part of [the prototype web renderer](prototype-web-renderer.md). This page continues
[still renderer coverage](prototype-web-renderer-coverage.md), which lists the supported nodes. The
descriptions here are the Android skin's.

## Media

- **Video player.** A video player is a black 16:9 frame under the skin's chrome at `startMs`. A
  `colorBars` sample draws bars and a `countdown` sample a 3. The still does not inline other
  sources.
- **Video chrome.** Android draws a centred 56 px play button over a bottom bar. iOS draws play
  inside a rounded bottom bar. The bar has a CC button when the player has captions. When
  `controls` is `none`, the still draws no chrome.
- **Poster.** A `poster` is drawn as an `image` asset is: the page encodes it at the player's width
  and fits it over black, above the first frame and under the chrome. Until the page inlines it,
  the poster is listed as `assetNotInlined` (no bytes) or `assetOverBudget`.
- **Camera preview.** A camera preview is a portrait viewfinder at its `aspectRatio` (default 4:3)
  showing colour bars and a label naming its mode.
- **Cast button.** A cast button is the skin's idle route icon (Cast on Android, AirPlay on iOS) in
  a 48 px target. It is a `details` disclosure, so a tap opens a device picker listing no devices
  without any script.

## Map

- **Canvas.** A map fetches no tiles. It draws a neutral canvas (`plain`, or a faint street grid),
  200 px tall unless sized, with its polylines in an inline SVG and its markers as pins.
- **Placement.** Web Mercator places the points under `fit` (`markers` or `route`), else the camera
  (literal or `/data`), else every point. The still places points in dp from the box centre
  (`calc(50% + …px)`, the SVG's origin at the centre), so CSS resolves them against the box as
  rendered.
- **Parent-sized axes.** The renderer cannot know a width or height the parent sizes: `fill`, a
  `weight` on the parent's main axis, a stretched width, or the fullscreen root. The framing and
  perspective therefore use the screen's size on that axis, the most the box can take.
- **Size limits.** Each axis is then held within its `min*`/`max*` (the min wins, as in CSS). An
  `aspectRatio` sizes the open axis from the other. In a column the height follows the width, and
  the 200 px default is dropped so the ratio applies. In a row, a box or the root, an open width
  follows the height.
- **Ratio without size.** A ratio with no width, height or weight takes the width it is offered,
  capped at `maxHeight × ratio`, as the style sizes it. That keeps a camera's true zoom at any box
  size.
- **Fit scaling.** A fit (`fit`, or every point when there is no camera) chose its zoom to span 80%
  of that size. Its pins therefore scale by `min(100cqw / width, 100cqh / height)`, with the box a
  size container.
- **Fit SVG.** Its SVG is `100cqw` × `100cqh` about the same centre, so padding moves pins and lines
  alike. It takes the fitted size as a `meet` viewBox and a non-scaling stroke. A box rendered
  narrower than the screen shrinks the fit uniformly and keeps every point inside.
- **Camera tilt.** A camera framing turns by its `bearing` and `tilt`, and a fit frames north up.
  The canvas moves to a ground square under
  `perspective(1.5 × height) rotateX(tilt) rotate(-bearing)`. The still sizes that square from the
  box corners traced back onto the plane, so it covers any aspect ratio.
- **Projected lines and pins.** Code projects lines and pins the same way, and pins stay upright.
  Lines are clipped at a near plane (0.1 of the eye distance) and break into separate runs there.
  Pins past the near plane are dropped.
- **Horizon.** The height used is never less than the rendered one. The eye is therefore far enough
  out that no horizon shows.

## Overlays

- **Bottom sheet opening.** A `bottomSheet` is open when its `openWhen` key holds exactly `equals`,
  and a missing key keeps it shut. It draws nothing in place. Like the devices' modal layer, an
  open one draws over its window after the tree, in tree order, a sheet before those inside it.
- **Overlay window.** The window is the screen, a sheet window's region or a floating window's box.
  The overlay takes no ancestor's grid cell or consumed insets.
- **Bottom sheet drawing.** The sheet is a scrim filling the window under a full-width column at the
  bottom. The scrim uses the `scrim` role at 0.4 opacity by default or when named, else the
  authored colour exactly. The column is as tall as its first detent (half, all, or `dp` capped at
  the window).
- **Bottom sheet surface.** The column paints `surface` unless an authored background resolves, with
  no corner radius or shadow. It holds a centred 32x4 px `onSurfaceVariant` drag handle with 8 px
  around it, unless `dragHandle` is false, then its child.
- **Dialog and snackbar layering.** A `dialog` and a `snackbar` open and layer the same way.
- **Dialog.** A dialog is a scrim (the `scrim` role at 0.32) under a centred `surfaceContainerHigh`
  surface. The surface has 28 px corners, 24 px padding and 16 px gaps, and is 280 to 560 px wide
  with 24 px around it.
- **Dialog content.** It holds its icon (`secondary`), title (`headlineSmall`, `onSurface`), text
  (`bodyMedium`, `onSurfaceVariant`) and its child (scrolling when tall). The dismiss and confirm
  text buttons (`labelLarge`, `primary`) come at the end, tagged `<testTag>.dismiss` and
  `<testTag>.confirm`.
- **Snackbar.** A snackbar has no scrim and lets touches through around it. It sits at the
  window's bottom with 12 px around it, as wide as the window up to 600 px, at least 48 px tall. It
  uses `inverseSurface` with 4 px corners and `bodyMedium` `inverseOnSurface` text, then its
  optional `inversePrimary` action tagged `<testTag>.action`.

## Choice controls

- **Selection and tags.** Choice controls select the option whose `value` their `stateKey` holds
  and tag each option `<testTag>.<value>`.
- **Radio group.** A radio group is a column of 48 px rows, a 20 px radio ring (`primary` with a dot
  when selected) before each label.
- **Select.** A select draws only its closed field, since its list opens on tap. The field is a
  4 px-radius `surfaceContainerLow` field with its `label` in `labelSmall` over the chosen label
  and an `expand_more` icon.
- **Segmented button.** A segmented button is a row of equal-width 40 px outlined segments, the ends
  rounded, the selected one `secondaryContainer` with a check.
- **Search bar.** A search bar draws a 56 px `surfaceContainerHigh` pill with its leading icon, its
  query (else the placeholder in `onSurfaceVariant`) and its trailing actions. While its
  `activeKey` is `true` it draws its child below, and the `bar` variant then fills its height too.
- **Paste button.** A paste button is a filled button labelled "Paste".

## Pickers

- **Time picker.** A time picker draws its hour (selected, `primaryContainer`) and minute boxes. It
  adds an AM/PM selector unless it is 24-hour (`is24Hour`, else the still's `en-US` 12-hour clock).
  A 256 px hour dial shows the bound hour under a `primary` selector, and a 24-hour dial adds an
  inner 12–23 ring.
- **Date picker.** A date picker is 360 px of `surfaceContainerHigh`. It shows "Select date", the
  bound date as its headline, and the month row with its arrows. Below them is that month (else
  today's from the still's clock) in a Sunday-first grid of 48 px cells. The bound day is filled
  `primary` and today is ringed.

## Images

- **Asset binding.** An `image` binds its asset id. A light/dark pair picks the mode's side, then
  placeholders bind as text does.
- **No slot.** Without a slot for the asset, it draws a `surfaceVariant` placeholder with reason
  `assetNotInlined`. The placeholder is at least 48 px on each axis the node does not fix in dp.
- **Content box.** With a slot, the placeholder colour reads the slot's `-bg`, and its layers sit
  in a content box. With no padding the box covers the node and keeps the `-ar` `aspect-ratio` on
  an axis it leaves to wrap. A weighted share thus carries the ratio to the other axis.
- **Padded content box.** With padding (safe-area insets included), the content box is an in-flow
  child inside the padding that carries the ratio and the 48 px minimum. A zeroed row child's box
  drops its inline padding, so its draw and minimums take none out either.
- **Image layer.** The layer is the slot's image as a centred background: `contain`, `cover` or
  `100% 100%` for `fit`, `crop` and `fill`. A corner radius clips it.
- **Filters.** The layer is filtered by `saturate()` for `filter.saturation`. For `filter.tint` it
  then applies an inline SVG `feColorMatrix` (`sRGB` interpolation, id `pa-tint-<rrggbbaa>`). The
  matrix multiplies every channel, alpha included, by the tint's.
- **Android equivalence.** This matches Android's saturation colour matrix followed by its
  `Modulate` tint layer. A fully transparent tint hides the image, and a partly transparent pixel
  keeps alpha `a × tint.a`.

## Unsupported nodes

Any other node draws a dashed placeholder labelled with its type and id, with reason
`unsupportedType`.
