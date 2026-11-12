# CSS 3D transforms for the web device view

- Kind: decision
- Date: 2026-11-03
- Source: moved from `how-it-works/prototype-web-3d.md`; #16349, #16458, #16460
- Shaped: [Prototype web 3D device view](../how-it-works/prototype-web-3d.md)

## Context

The prototype web page needed a 3D view that orbits, rotates and folds the device frame through
the `setPosture` postures. The page's CSP is `default-src 'none'` with every script pinned by hash,
so nothing can be lazy-loaded; the inlined script budget is 150 KB and the page budget 2 MiB.

## Options

| Approach                                                         | Added to the page (minified / gzip) | Fits the 150 KB script budget |
| ---------------------------------------------------------------- | ----------------------------------- | ----------------------------- |
| CSS 3D transforms, hand-written                                  | 4.7 KB / 2.1 KB, plus 0.5 KB CSS    | yes                           |
| three.js `CSS3DRenderer` with `Scene` and a camera               | 233 KB / 52 KB                      | no                            |
| three.js WebGL subset (renderer, extruded mesh, lights, texture) | 520 KB / 131 KB                     | no                            |
| WebGL subset plus `CSS3DRenderer` and `OrbitControls`            | 545 KB / 137 KB                     | no                            |
| all of three.js                                                  | 706 KB / 179 KB                     | no                            |

three.js sizes are r180 tree-shaken by Bun with `--minify`; none can be lazy-loaded under the CSP.

- **CSS 3D** keeps the shown view as live DOM: text stays crisp and selectable, the
  accessibility tree is unchanged, and only compositor transforms change.
- **WebGL** needs the screen as a texture. Rasterizing DOM (SVG `foreignObject` or a DOM-to-canvas
  library) loses crisp text, selection and the accessibility tree, and has to be redone whenever
  the view changes.
- **`CSS3DRenderer` with WebGL** draws DOM in a separate layer stacked above or below the canvas.
  The two never depth-sort against each other, and WebGL lights do not shade DOM, so a WebGL device
  body cannot occlude a folded screen leaf correctly. The usual transparent "punch-through" plane
  works for one flat screen, not for two leaves that occlude each other while folding.

## Decision

Use CSS 3D transforms on the page's existing DOM, not WebGL: an opt-in mode of the same page script
family, with no dependency and no network, inside the script budget.

## Consequences

- No WebGL fallback to maintain; the toggle is hidden where `@supports (transform-style:
  preserve-3d)` fails.
- Device fidelity is flat leaves from the registry's geometry. Third-party device models were
  ruled out: manufacturer CAD and renders carry copyright and trade dress, and the registry already
  avoids brand imagery. Device thickness could be added as edge strips per leaf; rounded edges in
  CSS 3D are approximations and are not needed to read a posture.
- Mirroring a live device's posture into the page was not built: the page is a static, hash-pinned
  resource, and a posture change on a device is not a new spec revision. A posture mirror belongs
  with any future live viewer, where the device's display state is already observed.
- Open questions at the time: WebKit and Gecko rendering of nested `preserve-3d` with
  `overflow: hidden` leaves (the prototype was checked only in Chromium), and whether arrow-key
  orbit should move to explicit buttons, since the viewport has no other keyboard handling to share
  keys with.
