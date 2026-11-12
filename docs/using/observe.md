# observe

Call `observe` to read the current screen before choosing a target. The default
`skeleton` and `context` rows describe controls and visible text; `project: "full"`
returns the hierarchy. Bounds tuples are `[left, top, right, bottom]`.

For an Android XR app with an embedded SpatialPanel, `xrPanelSpace` identifies
the panel's `windowId` and window `bounds`. Elements and skeleton/context rows
carry `boundsSpace: "panel"` when their bounds are relative to that panel window,
or `boundsSpace: "window"` when they belong to another window, such as a caption
or status bar. These windows do not share a coordinate space: do not compare
their bounds across windows or pass panel bounds to `tapAt`. Use `tapOn` or
`tapAny` to click a panel control by its label or identifier, or use keyboard
focus keys. The fields are omitted on non-XR observations and XR apps without
an identified embedded SpatialPanel.
