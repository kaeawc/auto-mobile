# observe

| Tool                    | What it does                                                                                                 | Requires                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 👁️ <code>observe</code> | Get screen view hierarchy and screenshot, with optional PNG crop from a fresh settled capture of one display | Android, iOS, watchOS, tvOS, visionOS |

Call `observe` to read the current screen before choosing a target. The default
`skeleton` and `context` rows describe controls and visible text; `project: "full"`
returns the hierarchy. Bounds tuples are `[left, top, right, bottom]`.

Adjustable range controls, including sliders, carry the `adjust` affordance. Any row with numeric
state, including a read-only progress indicator, carries `range: {current, min, max}`. To adjust
one, use `swipeOn` with an `adjust` row's `elementId` as the `container`.

## Toggle labels

A toggle or range row may have no label of its own or from its enclosing row. It then
takes the text shown immediately before it, such as the `Dark mode` text beside a `Switch`. That
text still appears in `context`.

Some text follows a toggle that has no label and no text before it. That text
may sit in the same coordinate space (window or ornament), directly or inside a
plain container. It is then that toggle's trailing label and never labels the
next toggle.
When a toggle has its own label or takes the text before it, the text after it
labels the next toggle. Text selectors match the same label.

## Android XR panels

For an Android XR app with an embedded SpatialPanel, `xrPanelSpace` identifies
the panel's `windowId` and window `bounds`. Elements and skeleton/context rows
carry `boundsSpace: "panel"` when their bounds are relative to that panel window.
They carry `boundsSpace: "window"` when they belong to another window, such as a
caption or status bar.

These windows do not share a coordinate space: do not compare their bounds
across windows or pass panel bounds to `tapAt`. Use `tapOn` or `tapAny` to click
a panel control by its label or identifier, or use keyboard focus keys.
Non-XR observations, and XR apps without an identified embedded SpatialPanel,
omit these fields.
