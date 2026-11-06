# Prototype web 3D device view

This note sets out how the prototype web page can switch its flat device frame into a 3D view
that orbits, rotates and folds through the `setPosture` postures. It builds on the page described
in [Prototype web renderer](prototype-web-renderer.md) and the multi-panel frames in
[Prototype web frames for every form factor](prototype-web-frames-v2.md).

## Recommendation

Use CSS 3D transforms on the page's existing DOM, not WebGL. The 3D view is an opt-in mode of the
same page script family: a toggle, a posture select, a hinge slider and keyboard orbit. It adds no
dependency, needs no network, and stays inside the page's script budget.

## Constraints the page sets

- **No network.** The page's CSP is `default-src 'none'` with every script pinned by hash, so
  nothing can be lazy-loaded at runtime. Whatever the 3D view needs is inlined, or the page is
  built without it.
- **Budgets.** The inlined script is at most 150 KB and the page at most 2 MiB. Views are
  pre-rendered on the host; the page script only shows, hides and moves them.
- **Static views.** A view is a pre-rendered DOM subtree. Taps do nothing, so the state to keep
  across a 2D/3D switch is the runtime's in-memory selection (variant, revision, screen,
  orientation, zoom), not prototype state.

## Technology

| Approach                                                         | Added to the page (minified / gzip) | Fits the 150 KB script budget |
| ---------------------------------------------------------------- | ----------------------------------- | ----------------------------- |
| CSS 3D transforms, hand-written                                  | 4.7 KB / 2.1 KB, plus 0.5 KB CSS    | yes                           |
| three.js `CSS3DRenderer` with `Scene` and a camera               | 233 KB / 52 KB                      | no                            |
| three.js WebGL subset (renderer, extruded mesh, lights, texture) | 520 KB / 131 KB                     | no                            |
| WebGL subset plus `CSS3DRenderer` and `OrbitControls`            | 545 KB / 137 KB                     | no                            |
| all of three.js                                                  | 706 KB / 179 KB                     | no                            |

three.js sizes are r180 tree-shaken by Bun with `--minify`; none can be lazy-loaded under the CSP.

- **CSS 3D** keeps the shown view as live DOM: text stays crisp and selectable, the
  accessibility tree is unchanged, and only compositor transforms change, so a fold or orbit
  never re-lays out the prototype.
- **WebGL** needs the screen as a texture. Rasterizing DOM (SVG `foreignObject` or a DOM-to-canvas
  library) loses crisp text, selection and the accessibility tree, and has to be redone whenever
  the view changes.
- **`CSS3DRenderer` with WebGL** draws DOM in a separate layer stacked above or below the canvas.
  The two never depth-sort against each other, and WebGL lights do not shade DOM, so a WebGL device
  body cannot occlude a folded screen leaf correctly. The usual transparent "punch-through" plane
  works for one flat screen, not for two leaves that occlude each other while folding.

## How the CSS 3D view is built

- The viewport gets `perspective`; the stage and the shown view get `transform-style: preserve-3d`.
  The device orbit is a `rotateX`/`rotateY` on a box inside the stage that holds the views, not on
  a view: rotate animates the views' own transforms, so both views keep the orbit through the turn,
  and the stage's pan and zoom stay in screen space outside it.
- **Leaves.** The shown frame element stays in place as the fixed leaf, clipped at the hinge line
  with `clip-path`; it is never moved or re-rendered. The moving leaf is an `overflow: hidden` box
  for the rest of the frame, holding a clone of the frame offset by the hinge position, turned
  about the hinge line. A frame without a hinge is one leaf with one back plate. CSS cannot paint one
  subtree in two places, so one leaf is always a copy; the clone is `inert` and `aria-hidden`, so
  assistive technology reads the screen once.
- **Faces.** Each leaf has a front and a back plate with `backface-visibility: hidden`, so coplanar
  faces never z-fight and a closed device shows its outside rather than a mirrored screen.
- **No `clip-path` on 3D-transformed elements.** In Chromium, a leaf that combined `clip-path`
  with its own 3D transform inside the `preserve-3d` context did not render once turned; an
  `overflow: hidden` box did, so only the untransformed fixed leaf uses `clip-path`.
- **2D to 3D.** Entering 3D wraps the shown view at the flat pose, then transitions to a three-quarter
  pose; leaving transitions back to flat and removes the added elements when the transition ends.
  The shown view's DOM is byte-identical before and after.
- **Hinge axis.** A vertical hinge (book) turns the right leaf with `rotateY`; a horizontal hinge
  (flip) turns the bottom leaf with `rotateX`. The axis and hinge position (the hinge's centre as a
  share of its panel) come from the frame's `hinge`, given in portrait; landscape turns the frame a
  quarter counterclockwise, so a book's hinge becomes horizontal and a flip's vertical.
- **Scope of the 3D CSS.** Every 3D rule applies only while a view is wrapped (`data-device3d` on
  `body`), so the 2D page renders exactly as without the 3D view.

## Posture parity

- The posture select uses the `setPosture` names (`closed`, `half_opened`, `opened`, `tent`,
  `flipped`, `rear_display`) and the hinge slider uses degrees with 180 flat and 0 shut, as
  `setPosture`'s `hingeAngle` does. The angle drawn for each posture is the frame's
  `postures[].hingeDegrees`.
- `hingeAngle` stops at 180, so `tent` and `flipped` (folded backwards past flat) are reachable
  only by name. The web model draws them above 180 (for example 290 for `tent`), so the slider runs
  0–360.
- Mirroring a live device's posture into the page is not worth building now: the page is a static,
  hash-pinned resource, and a posture change on a device is not a new spec revision. A posture
  mirror belongs with any future live viewer, where the device's display state is already observed.

## Reflow during a fold

Posture is a pre-rendered view dimension, like orientation. While the hinge moves, the page shows
the starting posture's view; when the angle crosses a posture threshold it switches to that
posture's view, as a device reflows only when its device state changes. The thresholds are per
device and come from the frame's `postures` data, not the script: the layout shown is the frame's
posture whose `hingeDegrees` is nearest the hinge angle, so each threshold lies halfway between two
of the frame's postures. The status line names that posture. `closed` on a book
foldable draws the cover panel's view on the outside face of the moving leaf.

## Device fidelity

Flat leaves drawn from the registry's geometry (screen size, corner radius, bezel, hinge) are
enough. No third-party device models: manufacturer CAD and renders carry copyright and trade
dress, and the registry already avoids brand imagery. Device thickness can be added as edge strips
per leaf; rounded edges in CSS 3D are approximations and are not needed to read a posture.

## Fallback and motion

- 2D is the default; 3D is opt-in per page view. CSS 3D transforms are supported by current
  evergreen browsers and no WebGL is needed, so there is no WebGL fallback to maintain; where
  `@supports (transform-style: preserve-3d)` fails, the 3D toggle is not offered.
- Under `prefers-reduced-motion: reduce` the transforms apply without transitions; 3D poses still
  work.

## Accessibility

- The 3D toggle is a button with `aria-pressed`; the posture select has a label; the hinge is a
  native range input, so arrow keys and assistive technology drive it.
- With the viewport focused, arrow keys orbit (Shift for larger steps); Shift-drag orbits with a
  pointer, and a plain drag still pans.
- A `role="status"` line states the hinge angle and the posture whose layout is shown.

## Open questions

- WebKit and Gecko rendering of nested `preserve-3d` with `overflow: hidden` leaves; the
  prototype was checked only in Chromium.
- Whether arrow-key orbit should move to explicit buttons, since the viewport has no other keyboard
  handling to share keys with.
