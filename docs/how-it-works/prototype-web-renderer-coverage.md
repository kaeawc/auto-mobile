# Prototype web renderer: still renderer coverage

Part of [the prototype web renderer](prototype-web-renderer.md).

- **Coverage.** Supported nodes: `box`, `row`, `column`, `stack`, `scroll`, `text`, `spacer`,
  `divider`, `icon`, `button`, `topAppBar`, `textField`, `switch`, `checkbox`, `card`,
  `listItem` (with its leading icon and its trailing switch, checkbox or icon), `pager`, `grid`,
  `carousel`, `flow`, `list`, `bottomNav`, `tabBar`, `iconButton`, `chip`, `slider`, `radioGroup`,
  `select`, `segmentedButton`, `searchBar`, `datePicker`, `timePicker`, `pasteButton`, `badge`,
  `progress`, `fab`, `chart`, `adaptive`, `bottomSheet`, `dialog`, `snackbar`, `videoPlayer`, `map`,
  `cameraPreview` and `castButton`, and a `row` or `listItem`'s `swipeActions`. Where the devices differ,
  the skin decides (below); the descriptions here are the Android skin's. A pager draws only its initial
  page (its numeric `stateKey` value clamped to the pages and truncated, else the first) filling
  it unless it is `wrap` or a fixed `pageSize` sets that axis, inset by `peek`; neighbours a peek
  would reveal are not drawn. Its `dots` indicator is a row of 6 px dots, 8 px apart, the current one
  in `onSurface` and the rest at 0.38 opacity, 8 px above its bottom edge (a vertical pager: a column
  8 px from its right edge), or centred in a 22 px strip when `below`, unless a fixed height (a
  vertical pager: width) under 44 px leaves no room for it, when it overlays as Android does. A grid is a CSS grid of equal
  columns with `spacing` between columns and `runSpacing` (else `spacing`) between rows; a child
  spans its `span` clamped to the columns, takes the cell's width and sits at the top of its row. An
  adaptive grid fits `floor((width + spacing) / (minWidth + spacing))` columns to the screen width,
  so its tracks and clamped spans agree. A carousel draws its items in a clipped row at `itemWidth`,
  `itemSpacing` apart, each masked with a 28 px corner, and keeps an empty slot for a hidden child; it does not resize items as multi-browse or
  hero keylines do. A flow places its children eagerly in lines, `spacing` apart, starting a new
  line `runSpacing` below when `used + spacing + width` would exceed its width, hugs its widest line
  and clamps to `maxLines` lines. A `list` draws its header, every repeated row up to `maxItems` and
  its footer, `spacing` apart inside `contentPadding`, in a column (filling, scrolling vertically) or
  a row (scrolling horizontally), at its opening scroll position. A badge is a 6 px `error` dot, or a 16 px `error` pill around its
  text. A progress indicator is a 240x4 px bar or a 40 px ring on a `secondaryContainer` track, its
  `primary` indicator at its numeric state over `max` (default 1) clamped to 0..1; unbound it is
  indeterminate and a still rests it at 30 %. A FAB is 40, 56 or 96 px (`small`, regular, `large`)
  on `primaryContainer`, or extended with its label; disabled it is a 12 % `onSurface` container. A
  chart is inline SVG with Android's geometry: a 160 px plot filling the width (lines, filled areas
  at 0.25 opacity, or grouped bars rising from zero) over its `yRange` or the auto range, a dashed
  `outline` goal line, x labels below, or a 120 px ring of the latest value over the goal; series
  without a `color` take `primary`, `tertiary`, `secondary`, `error` in turn, and the device summary
  is its label unless one is authored. An `adaptive` scaffold lays out by the screen's width class
  (compact below 600 px, expanded from 840 px): list-detail and supporting panes sit side by side
  (a 360 px pane, a 24 px spacer) only when expanded, else the detail (after a selection, with Back)
  or the open supporting pane (with Close) replaces the other; a navigation suite is a bottom bar,
  a rail or a drawer by width class, each item drawing its label's first letter as its icon. Swipe
  actions are drawn as hidden `start` and `end` panels, since a still shows the item closed. A bottom nav is an 80 px `surfaceContainer` bar whose items draw their icon in a
  64x32 pill (`secondaryContainer` when selected) over a 12 px label, and it pads its bottom edge by
  the safe area, as both devices' navigation bars do, unless an ancestor already applied it. A tab bar
  is a 48 px `surface` row (72 px when a tab has an icon) with an `outlineVariant` bottom divider; the
  selected tab takes `primary` and a 3 px `primary` indicator, the rest `onSurfaceVariant`, and a
  `scrollable` one starts after 52 px with 90 px minimum tabs and clips the rest. Both bars select
  their linked `pager`'s initial page, else their numeric `stateKey`, else the first item. A nav item
  draws its image in a 24 dp box when the page inlines it (recorded as a draw and listed at `<path>.items[i].image` like an `image` node), else its named icon, else a 24 px `surfaceVariant` square. An
  icon button draws its icon in a 40 px circle inside a 48 px target: `standard` and
  `outlined` (an `outlineVariant` outline) tint it `onSurfaceVariant`, `filled` sits on `primary` and
  `tonal` on `secondaryContainer`; the icon name labels it when no label is authored. A chip with no
  `stateKey` is an outlined assist chip and one with a `stateKey` a filter chip, whatever its
  `variant`, as both devices draw them: 32 px tall with an 8 px radius in a 48 px target, outlined
  in `outlineVariant`, or `secondaryContainer` with a leading check icon while its key is `true`. A
  slider draws its label above a 16 px track, `primary` up to the value and `secondaryContainer`
  after it with a stop dot at its end, and a 4x44 px `primary` thumb at the value: its numeric
  state, else 0, snapped to `step` and clamped to `min`..`max`. A pager fills both axes, and a grid,
  carousel, slider, tab bar, bottom nav, radio group, select or search bar fills its width, unless sized; a row, column, box or card
  around such a child grows on that axis, as a Compose parent does around a `fillMax` child. A text field draws
  its leading and trailing icons. A top app bar draws its navigation icon
  and actions as icons labelled with their action, and its `variant` sets its height,
  title size and title alignment. A button, switch, checkbox, text field,
  list item, icon button, chip or slider whose `enabledWhen` is decidably false draws disabled. A button draws its `icon` before
  its label, a divider paints its authored colour, text decorations and built-in font
  families map to CSS, and a span keeps its own background. A text field shows `errorText` with error colours when `errorWhen` is
  decidably true, and otherwise its `supportingText`; it draws filled chrome (the native default) or an outline for `outlined`; its label floats above
  a value or placeholder, and sits in an
  otherwise empty field; a multiline field keeps newlines and its `minLines`/`maxLines` (24 px
  lines); a captioned field's wrapper takes its size,
  weight and alignment in the parent. A spacer with no width, height or weight
  fills its line, and a line around one grows to its parent's size on its unsized axes, as a
  Compose parent does around a `fillMaxSize` child. In an Android frame an icon draws its Material Icons
  glyph (the contract's curated subset of Compose's `material-icons-extended`, read from the Apache-2.0
  `@material-design-icons/svg` package) as inline SVG in a 24 px box, in its `variant`'s style, else
  `filled` as Android falls back, and tinted by `currentColor` or its style `color`. Only the
  glyphs a still draws are read and inlined. The still takes its glyph source as an option, so it
  stays free of Node builtins for the browser bundle: the server's page builder passes the
  Material Icons reader, and a still given none draws every icon as the placeholder, unreported.
  A glyph that would need `<defs>`/`<use>` ids is
  treated as absent, since ids collide when a page draws it twice. A name with no glyph draws a
  tinted rounded outline around its first letter, titled with the name, with reason `iconMissing`.
  An iOS frame draws that outline for every icon, unreported, until its glyph set is decided
  (#16526). A switch draws its label before a
  Material 3 track whose thumb sits at the end when on; a checkbox draws its box before its label,
  as both devices do. A video player is a black 16:9 frame (a `colorBars` sample draws bars, a
  `countdown` sample a 3; other sources are not inlined) under the skin's chrome at `startMs`
  (Android: a centred 56 px play button over a bottom bar; iOS: play inside a rounded bottom bar),
  with a CC button when it has captions and none when `controls` is `none`; a poster is listed
  `assetNotInlined`. A map fetches no tiles: it draws a neutral canvas (`plain`, or a faint street
  grid), 200 px tall unless sized, with its polylines in an inline SVG and its markers as pins, placed
  by Web Mercator under `fit` (`markers` or `route`), else the camera (literal or `/data`), else every
  point. Points are placed in dp from the box centre (`calc(50% + …px)`, the SVG's origin at the
  centre), so CSS resolves them against the box as rendered. A width or height the parent sizes
  (`fill`, a `weight` on the parent's main axis, a stretched width, the fullscreen root) cannot be
  known when rendering, so the framing and perspective use the screen's size on that axis, the most
  the box can take. Each axis is then held within its `min*`/`max*` (the min wins, as in CSS), and an
  `aspectRatio` sizes the open axis from the other: in a column the height follows the width (the
  200 px default is dropped so the ratio applies); in a row, a box or the root an open width follows
  the height. A ratio with no width, height or weight takes the width it is offered, capped at
  `maxHeight × ratio`, as the style sizes it. That keeps a camera's true zoom at any box size; a fit (`fit`, or every point
  when there is no camera) instead chose its zoom to span 80% of that size, so its pins scale by
  `min(100cqw / width, 100cqh / height)` (the box a size container) and its SVG, `100cqw` × `100cqh` about the
  same centre so padding moves pins and lines alike, takes the fitted size as a `meet` viewBox and a non-scaling stroke: a box rendered narrower than the
  screen shrinks the fit uniformly and keeps every point inside. A camera framing turns
  by its `bearing` and `tilt` (a fit frames north up): the canvas moves to a ground square under `perspective(1.5 × height) rotateX(tilt) rotate(-bearing)`, sized from the
  box corners traced back onto the plane so it covers any aspect ratio, and lines and pins are
  projected the same way in code: pins stay upright, and lines are clipped at a near plane (0.1 of the
  eye distance) and break into separate runs there, while pins past it are dropped. Because the
  height used is never less than the rendered one, the eye is far enough out that no horizon shows.
  A camera preview is a portrait viewfinder at its
  `aspectRatio` (default 4:3) showing colour bars and a label naming its mode. A cast button is the
  skin's idle route icon (Cast on Android, AirPlay on iOS) in a 48 px target; it is a `details`
  disclosure, so a tap opens a device picker listing no devices without any script. Glyphs are inline
  SVG; the serializer allows only `viewBox` and `preserveAspectRatio` as mixed-case attributes.
  A card hugs its content unless its width is `fill`, as both devices do. A
  `bottomSheet` is open when its `openWhen` key holds exactly `equals` (a missing key keeps it shut)
  and draws nothing in place: like the devices' modal layer, an open one is drawn over its window
  (the screen, a sheet window's region or a floating window's box) after the tree, in tree order, a
  sheet before those inside it, and takes no ancestor's grid cell or consumed insets. It is a scrim
  filling the window (the `scrim` role at 0.4 opacity by default or when named, else the authored
  colour exactly) under a full-width column at the bottom, as tall as its first detent (half, all,
  or `dp` capped at the window), painted `surface` unless an authored background resolves,
  with no corner radius or shadow; it holds a centred 32x4 px `onSurfaceVariant` drag handle with
  8 px around it, unless `dragHandle` is false, then its child. A `dialog` and a `snackbar` open
  and layer the same way. A dialog is a scrim (the `scrim` role at 0.32) under a centred
  `surfaceContainerHigh` surface with 28 px corners, 24 px padding and 16 px gaps, 280 to 560 px
  wide with 24 px around it: its icon (`secondary`), title (`headlineSmall`, `onSurface`), text
  (`bodyMedium`, `onSurfaceVariant`), its child (scrolling when tall), then the dismiss and confirm
  text buttons (`labelLarge`, `primary`) at the end, tagged `<testTag>.dismiss` and
  `<testTag>.confirm`. A snackbar has no scrim and lets touches through around it; it sits at the
  window's bottom with 12 px around it, as wide as the window up to 600 px, at least 48 px tall,
  in `inverseSurface` with 4 px corners and `bodyMedium` `inverseOnSurface` text, then its
  optional `inversePrimary` action tagged `<testTag>.action`. Choice controls select the option
  whose `value` their `stateKey` holds and tag each option `<testTag>.<value>`. A radio group is a
  column of 48 px rows, a 20 px radio ring (`primary` with a dot when selected) before each label. A
  select draws only its closed field, since its list opens on tap: a 4 px-radius
  `surfaceContainerLow` field with its `label` in `labelSmall` over the chosen label and an
  `expand_more` icon. A segmented button is a row of equal-width 40 px outlined segments, the ends
  rounded, the selected one `secondaryContainer` with a check. A search bar draws a 56 px
  `surfaceContainerHigh` pill with its leading icon, its query (else the placeholder in
  `onSurfaceVariant`) and its trailing actions; while its `activeKey` is `true` it draws its child
  below, and the `bar` variant then fills its height too. A paste button is a filled button
  labelled "Paste". A time picker draws its hour (selected, `primaryContainer`) and minute boxes, an
  AM/PM selector unless it is 24-hour (`is24Hour`, else the still's `en-US` 12-hour clock), and a
  256 px hour dial (a 24-hour dial adds an inner 12–23 ring) with the bound hour under a `primary`
  selector. A date picker is 360 px of `surfaceContainerHigh`: "Select date", the bound date as its
  headline, the month row with its arrows, and that month (else today's from the still's clock) in
  a Sunday-first grid of 48 px cells, the bound day filled `primary` and today ringed. An `image` binds its asset id (a
  light/dark pair picks the mode's side, then placeholders bind as text does); without a slot for it
  it draws a `surfaceVariant` placeholder, at least 48 px on each axis the node does not fix in dp,
  with reason `assetNotInlined`. With one, the placeholder colour reads the slot's `-bg`, and its
  layers sit in a content box: with no padding it covers the node, which keeps the `-ar`
  `aspect-ratio` on an axis it leaves to wrap (so a weighted share carries it to the other axis,
  as before the content box existed); with padding (safe-area insets included) it is an in-flow
  child inside the padding that carries the ratio and the 48 px minimum. A zeroed row child's box
  drops its inline padding, so its draw and minimums take none out either. The layer is the slot's image as a centred background (`contain`, `cover` or
  `100% 100%` for `fit`, `crop` and `fill`), filtered by `saturate()` for `filter.saturation` and
  then, for `filter.tint`, an inline SVG `feColorMatrix` (`sRGB` interpolation, id
  `pa-tint-<rrggbbaa>`) that multiplies every channel, alpha included, by the tint's, as Android's
  saturation colour matrix then its `Modulate` tint layer (a fully transparent tint hides the
  image, and a partly transparent pixel keeps alpha `a × tint.a`); a corner radius clips it. Any other node draws a
  dashed placeholder labelled with its type and id, with reason `unsupportedType`.
