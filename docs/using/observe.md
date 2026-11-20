# observe

| Tool                    | What it does                                                                                                 | Platforms                                                                                                                                                                                                                                                                                                                                               | Needs                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 👁️ <code>observe</code> | Get screen view hierarchy and screenshot, with optional PNG crop from a fresh settled capture of one display | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span> <span role="img" aria-label="watchOS" title="watchOS">⌚</span> <span role="img" aria-label="tvOS" title="tvOS">📺</span> <span role="img" aria-label="visionOS" title="visionOS">🥽</span></span> | <span class="tool-needs">—</span> |

Call `observe` to read the current screen before choosing a target. The default
`skeleton` and `context` rows describe controls and visible text; `project: "full"`
returns the hierarchy. Bounds tuples are `[left, top, right, bottom]`.

Adjustable range controls, including sliders, carry the `adjust` affordance. Any row with numeric
state, including a read-only progress indicator, carries `range: {current, min, max}`. To adjust
one, use `swipeOn` with an `adjust` row's `elementId` as the `container`.

## Reading an observation's screenshot later

Each observation returns an `observationScreenshotResourceUri`. Read that URI to get the
screenshot of exactly that observation. It stays readable while it is one of the device's last
10 observations and is under 5 minutes old, even after later actions or app switches. Read it
before then if you record evidence after the agent's next step.

When the screenshot is gone, the read returns JSON with code `OBSERVATION_NOT_RETAINED`.
`evictedBecause` says why:

| `evictedBecause`    | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `newer-observation` | 10 newer observations pushed it out; `supersededBy` names the newest. |
| `ttl`               | It is older than 5 minutes.                                           |
| `cache-cleared`     | The device's cache was cleared, for example when its session ended.   |

With no `evictedBecause`, the id is unknown. In every case, call `observe` again.

## CarPlay on an iOS simulator

Call `observe({deviceId: "<simulator UDID>", display: "carplay"})` to capture the projecting CarPlay
screen. The result includes a PNG `screenshotPath`, a `screenSize` in physical pixels, and a
`hierarchyUnavailable` note. Omit hierarchy and screenshot processing options such as `project`,
`raw`, `waitFor`, `crop`, and `screenshotOptions`. Leave `screenshot` unset or request `"settled"`.

If capture is refused, enable and power on CarPlay, open its window in Simulator, and confirm
that one CarPlay screen is connected. If the probe is unavailable, set
[`AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH`](environment-variables.md) to its executable's absolute path.

## Apps with several scenes on iOS

When an iOS app has more than one connected scene, `observe` and the element-based
action tools such as `tapOn` fail with a `multi_scene` error that lists the scenes.
Close all but one scene, then retry. The tools do not fall back to a different
observation source.

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
