# Prototype web renderer: still renderer coverage

Part of [the prototype web renderer](prototype-web-renderer.md). The overlays, media, choice
controls, pickers, images and unsupported nodes continue in
[still renderer coverage (continued)](prototype-web-renderer-coverage-2.md).

## Coverage

The still supports these nodes:

- **Basic nodes.** `box`, `row`, `column`, `stack`, `scroll`, `text`, `spacer`, `divider`,
  `icon`, `button`, `topAppBar`, `textField`, `switch`, `checkbox`, `card` and `listItem` (with its
  leading icon and its trailing switch, checkbox or icon).
- **Collections and controls.** `pager`, `grid`, `carousel`, `flow`, `list`, `bottomNav`,
  `tabBar`, `iconButton`, `chip`, `slider`, `radioGroup`, `select`, `segmentedButton` and
  `searchBar`.
- **Pickers, indicators and overlays.** `datePicker`, `timePicker`, `pasteButton`, `badge`,
  `progress`, `fab`, `chart`, `adaptive`, `bottomSheet`, `dialog` and `snackbar`.
- **Media.** `videoPlayer`, `map`, `cameraPreview` and `castButton`.

It also supports a `row` or `listItem`'s `swipeActions`.

Where the devices differ, the skin decides (see
[skins, frames and the device frame registry](prototype-web-renderer-frames.md)). The descriptions
here are the Android skin's.

## Containers and collections

- **Pager.** A pager draws only its initial page: its numeric `stateKey` value clamped to the pages
  and truncated, else the first. The page fills the pager unless it is `wrap` or a fixed `pageSize`
  sets that axis, inset by `peek`. The pager does not draw neighbours a peek would reveal.
- **Pager dots.** Its `dots` indicator is a row of 6 px dots, 8 px apart, the current one in
  `onSurface` and the rest at 0.38 opacity. It sits 8 px above the bottom edge (a vertical pager: a
  column 8 px from its right edge), or centred in a 22 px strip when `below`. A fixed height (a
  vertical pager: width) under 44 px leaves no room for the strip, so the dots overlay as Android
  does.
- **Grid.** A grid is a CSS grid of equal columns with `spacing` between columns and `runSpacing`
  (else `spacing`) between rows. A child spans its `span` clamped to the columns, takes the cell's
  width and sits at the top of its row. An adaptive grid fits
  `floor((width + spacing) / (minWidth + spacing))` columns to the screen width, so its tracks and
  clamped spans agree.
- **Carousel.** A carousel draws its items in a clipped row at `itemWidth`, `itemSpacing` apart,
  each masked with a 28 px corner. It keeps an empty slot for a hidden child. It does not resize
  items as multi-browse or hero keylines do.
- **Flow.** A flow places its children eagerly in lines, `spacing` apart. It starts a new line
  `runSpacing` below when `used + spacing + width` would exceed its width. It hugs its widest line
  and clamps to `maxLines` lines.
- **List.** A `list` draws its header, every repeated row up to `maxItems` and its footer,
  `spacing` apart inside `contentPadding`. It lays them out in a column (filling, scrolling
  vertically) or a row (scrolling horizontally), at its opening scroll position.
- **Adaptive.** An `adaptive` scaffold lays out by the screen's width class: compact below 600 px,
  expanded from 840 px. List-detail and supporting panes sit side by side (a 360 px pane, a 24 px
  spacer) only when expanded. Otherwise the detail (after a selection, with Back) or the open
  supporting pane (with Close) replaces the other. A navigation suite is a bottom bar, a rail or a
  drawer by width class, each item drawing its label's first letter as its icon.
- **Swipe actions.** The still draws swipe actions as hidden `start` and `end` panels, since a
  still shows the item closed.
- **Card.** A card hugs its content unless its width is `fill`, as both devices do.

## Indicators and charts

- **Badge.** A badge is a 6 px `error` dot, or a 16 px `error` pill around its text.
- **Progress.** A progress indicator is a 240x4 px bar or a 40 px ring on a `secondaryContainer`
  track. Its `primary` indicator sits at its numeric state over `max` (default 1), clamped to
  0..1. Unbound, it is indeterminate, and a still rests it at 30 %.
- **FAB.** A FAB is 40, 56 or 96 px (`small`, regular, `large`) on `primaryContainer`, or extended
  with its label. A disabled FAB is a 12 % `onSurface` container.
- **Chart.** A chart is inline SVG with Android's geometry. It draws a 160 px plot filling the
  width (lines, filled areas at 0.25 opacity, or grouped bars rising from zero) over its `yRange`
  or the auto range. It adds a dashed `outline` goal line and x labels below. A ring chart is a
  120 px ring of the latest value over the goal.
- **Chart series.** Series without a `color` take `primary`, `tertiary`, `secondary`, `error` in
  turn. The device summary is its label unless one is authored.

## Navigation bars

- **Bottom nav.** A bottom nav is an 80 px `surfaceContainer` bar. Its items draw their icon in a
  64x32 pill (`secondaryContainer` when selected) over a 12 px label. It pads its bottom edge by
  the safe area, as both devices' navigation bars do, unless an ancestor already applied it.
- **Tab bar.** A tab bar is a 48 px `surface` row (72 px when a tab has an icon) with an
  `outlineVariant` bottom divider. The selected tab takes `primary` and a 3 px `primary`
  indicator, the rest `onSurfaceVariant`. A `scrollable` one starts after 52 px with 90 px minimum
  tabs and clips the rest.
- **Selection.** Both bars select their linked `pager`'s initial page, else their numeric
  `stateKey`, else the first item.
- **Nav item image.** A nav item draws its image in a 24 dp box when the page inlines it. The still
  records that as a draw and lists it at `<path>.items[i].image` like an `image` node. Otherwise
  the item draws its named icon, else a 24 px `surfaceVariant` square.
- **Top app bar.** A top app bar draws its navigation icon and actions as icons labelled with their
  action. Its `variant` sets its height, title size and title alignment.

## Controls

- **Icon button.** An icon button draws its icon in a 40 px circle inside a 48 px target.
  `standard` and `outlined` (an `outlineVariant` outline) tint it `onSurfaceVariant`. `filled`
  sits on `primary` and `tonal` on `secondaryContainer`. The icon name labels it when no label is
  authored.
- **Chip.** A chip with no `stateKey` is an outlined assist chip, and one with a `stateKey` is a
  filter chip, whatever its `variant`, as both devices draw them. It is 32 px tall with an 8 px
  radius in a 48 px target. It is outlined in `outlineVariant`, or `secondaryContainer` with a
  leading check icon while its key is `true`.
- **Slider.** A slider draws its label above a 16 px track: `primary` up to the value and
  `secondaryContainer` after it, with a stop dot at its end. A 4x44 px `primary` thumb sits at the
  value. The value is its numeric state, else 0, snapped to `step` and clamped to `min`..`max`.
- **Button.** A button draws its `icon` before its label.
- **Switch and checkbox.** A switch draws its label before a Material 3 track whose thumb sits at
  the end when on. A checkbox draws its box before its label, as both devices do.
- **Disabled.** A button, switch, checkbox, text field, list item, icon button, chip or slider
  whose `enabledWhen` is decidably false draws disabled.

## Sizing

- **Filling children.** A pager fills both axes. A grid, carousel, slider, tab bar, bottom nav,
  radio group, select or search bar fills its width, unless sized. A row, column, box or card
  around such a child grows on that axis, as a Compose parent does around a `fillMax` child.
- **Spacer.** A spacer with no width, height or weight fills its line. A line around one grows to
  its parent's size on its unsized axes, as a Compose parent does around a `fillMaxSize` child.

## Text

- **Text field.** A text field draws its leading and trailing icons. It shows `errorText` with
  error colours when `errorWhen` is decidably true, and otherwise its `supportingText`. It draws
  filled chrome (the native default) or an outline for `outlined`.
- **Text field label.** Its label floats above a value or placeholder, and sits in an otherwise
  empty field. A multiline field keeps newlines and its `minLines`/`maxLines` (24 px lines). A
  captioned field's wrapper takes its size, weight and alignment in the parent.
- **Text styling.** A divider paints its authored colour. Text decorations and built-in font
  families map to CSS, and a span keeps its own background.

## Icons

- **Glyphs.** An icon in either skin (#16526) draws its Material Icons glyph as inline SVG in a
  24 px box. The glyphs are the contract's curated subset of Compose's `material-icons-extended`,
  read from the Apache-2.0 `@material-design-icons/svg` package. The icon uses its `variant`'s
  style, else `filled` as Android falls back, tinted by `currentColor` or its style `color`.
- **Glyph source.** The still reads and inlines only the glyphs it draws. It takes its glyph source
  as an option, so it stays free of Node builtins for the browser bundle. The server's page builder
  passes the Material Icons reader. A still given none draws every icon as the placeholder,
  unreported.
- **Missing glyphs.** The still treats a glyph that would need `<defs>`/`<use>` ids as absent, since
  ids collide when a page draws it twice. A name with no glyph draws a tinted rounded outline
  around its first letter, titled with the name, with reason `iconMissing`.
- **SVG attributes.** Glyphs are inline SVG. The serializer allows only `viewBox` and
  `preserveAspectRatio` as mixed-case attributes.
