# `swipeOn`

| Tool                    | What it does                       | Requires              |
| ----------------------- | ---------------------------------- | --------------------- |
| 👉 <code>swipeOn</code> | Swipe/scroll on screen or elements | Android, iOS, watchOS |

`swipeOn` swipes in a `direction` on the screen or a selected `container`.
When the selected range control changes its numeric state, `effect.value`
reports `before` and `after`, each with `current`, `min`, and `max`. The field
is omitted when the value is unchanged or comparable range state is unavailable.

On iOS, a container thinner than 48 pt along the swipe axis (such as a sheet
grabber) starts the drag at its centre and travels 240 pt in that direction.
AutoMobile clamps the drag to the screen bounds. The result includes a `warning` explaining the
extended drag, and warns if clamping leaves less than 120 pt of travel.

## Scrolling until an element appears

Use `lookFor` to scroll until an element appears. The search stops going forward
when two consecutive swipes leave the content unchanged: the container's items
stay in place. Changes outside the container, such as a clock or an edge
indicator, do not count.

The search then sweeps back the other way with slower half-screen swipes, so it
still finds a target that it skipped or that lies behind the starting position.
After forward swipes that moved the content, the reverse sweep is limited to
twice that many swipes plus `lookFor.maxUnchangedSwipes`, which returns past the
starting position.

The search returns `success: false`, `found: false`, and `reachedEnd: true` when
the reverse sweep also reaches its end, covers that range, or cannot fit another
swipe in the 15-second search budget. The error says how the sweep ended and
that the item may be absent or the direction wrong.

| Field or parameter           | Meaning                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `scrollIterations`           | Search swipes in both directions                                                                                                   |
| `movedSwipes`                | Search swipes in both directions whose settled content changed, excluding overlap recovery                                         |
| `lookFor.maxUnchangedSwipes` | Unchanged swipes before the search turns, per direction; a positive integer, default `2`. Raise it for content that changes slowly |

## Android XR

On an Android XR headset in home space, screen swipes stay inside the topmost
standard (task-aligned) app panel. Coordinate targeting uses screenshot pixels,
as with `tapAt`, and AutoMobile dispatches the swipe inside the panel's display
bounds. With no app panel, the request fails, because swiping outside an app
panel would dismiss home-space panels. Open an app panel and retry.

The `fromEdge` option is refused on XR because edge gestures hit system UI; omit
it and swipe within the panel. The supported XR layout is home space at the
default headset pose. As with `tapAt`, every XR result carries a `warning` about
that default-pose assumption. AutoMobile refuses the swipe before input when more
than one app panel is open or the panel cannot fit the screenshot at the default
pose.

On a Compose spatial panel, `swipeOn` scrolls through accessibility node actions:
up/left scroll forward and down/right scroll backward. It uses the supplied
scrollable container, or the largest visible scrollable in the foreground app.
This also applies to `lookFor` searches. Gesture duration does not control node
scroll speed; `boomerang` performs one node scroll without a return stroke.

If the panel cannot scroll further or its layout changed, observe again before
retrying. Without a scrollable node, AutoMobile refuses the swipe; use
`tapOn`/`tapAny` or keyboard focus keys. Older runners may require a CtrlProxy
update. Display touches cannot reach spatial-panel content.
