# swipeOn

`swipeOn` swipes in a `direction` on the screen or a selected `container`.
Use `lookFor` to scroll until an element appears.

On an Android XR headset in home space, screen swipes stay inside the topmost
app panel. Coordinate targeting uses screenshot pixels, as with `tapAt`; the
swipe is dispatched inside the panel's display bounds. With no app panel, the
request fails because swiping outside an app panel would dismiss home-space
panels. Open an app panel and retry. `fromEdge` is refused on XR because edge
gestures hit system UI; omit it and swipe within the panel. The supported XR
layout is home space at the default headset pose. As with `tapAt`, every XR
result carries a `warning` about that default-pose assumption, and the swipe is
refused before input when more than one app panel is open or the panel cannot
fit the screenshot at the default pose.
