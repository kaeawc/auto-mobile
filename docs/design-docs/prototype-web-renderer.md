# Prototype web renderer

The web renderer draws a prototype inside a device frame as one self-contained HTML page. This
document covers its device frame registry.

## Device frame registry

`src/features/prototype/web/deviceFrames.json` is data only: adding a device is one entry, with
no code change. `deviceFrames.ts` validates it with a strict schema when the module loads, so an
invalid entry fails the first import and its unit test instead of rendering wrong geometry.

It is called a _frame_ registry, never a device profile, because `deviceProfile` already means
the session broker's OEM manufacturer profiles.

Each entry records:

- `screen`: portrait width and height in dp (points on iOS) and the density.
- `cornerRadiusDp`, the `cutout` (`none`, `punchHole`, `notch` or `island`, with its geometry),
  `statusBarDp` and the `navBar` (`none`, `gesture` or `buttons`).
- `safeArea` for portrait and landscape. Landscape is stored, not derived, because a cutout and
  the navigation bar move to different edges on each platform.
- `frame`: the bezel width and colour drawn around the screen.
- `source`: where the screen geometry and the insets came from. Values not yet measured on an
  emulator or simulator say so, and replacing them with measured values is a data change.

Beyond the schema, a registry is invalid when two entries share an id, a cutout lies outside the
portrait screen, or a safe area leaves no screen in either orientation.

When a request names no frame, the default is `pixel-9` for Android and `iphone-16` for iOS. An
unknown frame id is an error that lists the valid ids.
