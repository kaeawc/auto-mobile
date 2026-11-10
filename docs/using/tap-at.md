# tapAt

`tapAt` taps, long presses, or double taps at `x`, `y`. Absolute coordinates use
platform-native units; `coordinateSpace: "normalized"` uses 0–1 and `"percent"`
uses 0–100. Alternatively, pass `image` with a screenshot-relative point and its
image metadata.

On an Android XR headset in home space, coordinates are screenshot pixels.
Choose a point inside the topmost app panel in the screenshot. Normalized,
percent, and image inputs resolve to the same screenshot space. The result's
`xrPanel` identifies the app and task and reports `displayX`, `displayY`, the
mapped display pixels used for input; `x`, `y` also report that dispatched point.

A point outside the panel fails with “no app panel under that screenshot point”.
XR system UI, including the home-space launcher and environment buttons, cannot
be tapped with `tapAt`. Open an app panel, observe again, and choose a point
inside its screenshot projection. This mapping supports the default headset
pose in home space; moved panels and immersive apps are outside its scope.
