# swipeOn

`swipeOn` swipes in a `direction` on the screen or a selected `container`.
On iOS, a container thinner than 48 pt along the swipe axis (such as a sheet
grabber) starts the drag at its centre and travels 240 pt in that direction,
clamped to the screen bounds. The result includes a `warning` explaining the
extended drag and warns if clamping leaves less than 120 pt of travel.
Use `lookFor` to scroll until an element appears.

On an Android XR headset in home space, screen swipes stay inside the topmost
standard (task-aligned) app panel. Coordinate targeting uses screenshot pixels, as with `tapAt`; the
swipe is dispatched inside the panel's display bounds. With no app panel, the
request fails because swiping outside an app panel would dismiss home-space
panels. Open an app panel and retry. `fromEdge` is refused on XR because edge
gestures hit system UI; omit it and swipe within the panel. The supported XR
layout is home space at the default headset pose. As with `tapAt`, every XR
result carries a `warning` about that default-pose assumption, and the swipe is
refused before input when more than one app panel is open or the panel cannot
fit the screenshot at the default pose.

Apps whose content is a Compose spatial panel cannot receive swipe gestures.
Screen, container, and coordinate swipes, and the gesture fallback of
`lookFor` scrolling, are refused wherever the panel sits; a scroll the
accessibility service performs on the node itself still works. Use `tapOn` or
`tapAny` on the target, or move keyboard focus with `focusNavigate` (or
`sendKeys` arrow keys).
