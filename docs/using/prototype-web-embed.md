# Embedding a prototype on a web page

Draw a prototype in a device frame on any web page with `@kaeawc/auto-mobile-prototype-web`. It has
no dependencies and draws into a shadow root on an element you choose.

For a native Android or iOS app, see [Embedding a prototype in an app](prototype-embedding.md). For
the page AutoMobile serves itself, see [Prototype web preview](prototype-web-preview.md).

## Install

```bash
npm install @kaeawc/auto-mobile-prototype-web
```

The package version matches the AutoMobile release.

## Pass an embed envelope

Read `automobile:prototype/<id>/embed` and pass the whole result as `spec`. The envelope carries
the spec together with the capabilities it needs and its icon glyphs; see
[Embed envelope](prototype-web-preview.md#embed-envelope).

The library refuses an envelope it cannot draw whole:

- `missingCapabilities`: `requires` names a capability this release does not draw. Update the
  package.
- `unknownVersion`: `version` is not `1`, so a newer server wrote it. Update the package.

You can also pass a bare spec. The library refuses one that has remote images, one over the base
runtime budget, or one whose own `requires` names a capability it lacks. It cannot detect
everything else a newer server adds, so a bare spec may still draw incompletely. Prefer the
envelope.

## mount

```js
import { mount } from "@kaeawc/auto-mobile-prototype-web";

const handle = mount(document.querySelector("#prototype"), {
  spec: envelope,
  frame: "pixel-9",
  controls: ["rotate", "zoom", "screen"],
  onError: (error) => console.warn(error.code, error.message),
});
```

`mount(element, options)` draws into an open shadow root on `element`. The element is 640 px tall
unless your page sets its height.

| Option        | Values                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `spec`        | Required. An embed envelope or a bare spec object.                                                                     |
| `frame`       | A device frame id (default `pixel-9`), a frame object, or `false` to draw the screen without a frame.                  |
| `orientation` | `portrait` or `landscape`. The frame must support it.                                                                  |
| `zoom`        | `fit` (default) or a scale from 0.5 to 4. `fit` scales the frame to the space below the controls and refits on resize. |
| `mode`        | `light`, `dark`, or `system`, which follows the viewer's color scheme.                                                 |
| `screen`      | The screen of the spec's stack to show. An unknown screen shows the start screen.                                      |
| `controls`    | `false`, or a list of `rotate`, `zoom` and `screen`. A control shows only when it applies.                             |
| `locale`      | A locale tag such as `fr-FR`, for the spec's strings and formatting.                                                   |
| `textSize`    | `{ fontScale }` (0.85 to 2) for an Android frame, or `{ contentSize }` such as `large` for an iOS frame.               |

A frame object is one device frame entry: `id`, `platform`, `label`, `screen`, `cornerRadiusDp`,
`cutout`, `statusBarDp`, `navBar`, `safeArea` and `frame`, plus optional panels, hinge and
postures. The package's type definitions list every field. An invalid frame object is refused with
`invalidOption`, and the message names each problem field.

### The handle

`mount` returns a handle:

- `update(options)` changes only the options you pass. A new `spec` keeps the current zoom,
  orientation and screen.
- `destroy()` removes the drawing.
- `state` is the view drawn: `frame`, `orientation`, `zoom`, `scale`, `mode`, `screen`, `screens`,
  `unsupportedNodes`, and `error` when the input was refused.

### Events

Pass callbacks in the options:

| Callback              | Called with                                                                   |
| --------------------- | ----------------------------------------------------------------------------- |
| `onRender`            | `{ unsupportedNodes }`: the nodes drawn as placeholders, with their `reason`. |
| `onScreenChange`      | `{ screen }`                                                                  |
| `onOrientationChange` | `{ orientation }`                                                             |
| `onZoomChange`        | `{ zoom, scale }`                                                             |
| `onError`             | The error, described under [Errors](#errors).                                 |

A placeholder's `reason` is `unsupportedType`, `assetNotInlined`, `assetOverBudget`,
`shaderFallback` or `iconMissing`.

## The custom element

Importing `@kaeawc/auto-mobile-prototype-web/element` registers `<automobile-prototype>`. In a
bundled app, import it by that name. On a page without a bundler or import map, load the package's
`dist/element.js` file:

```html
<script
  type="module"
  src="/node_modules/@kaeawc/auto-mobile-prototype-web/dist/element.js"
></script>
<automobile-prototype frame="pixel-9" controls="rotate zoom">
  <script type="application/json">
    { "id": "hello", "root": { "type": "text", "text": "Hello" } }
  </script>
</automobile-prototype>
```

Its attributes are `frame`, `orientation`, `zoom`, `mode`, `screen` and `controls`, with the same
values as the `mount` options:

- `frame` and `controls` take `false` or `none` to turn them off.
- `controls` lists names separated by spaces or commas.
- `zoom` is `fit` or a number.
- An unknown `orientation` or `mode` is ignored.

The spec is the element's `spec` property, else its first child `<script type="application/json">`.
It is never read from an attribute or fetched from a URL. Set `spec` to an envelope you read
yourself:

```js
document.querySelector("automobile-prototype").spec = envelope;
```

The element draws when it is in the document with a spec, and removes the drawing when it leaves.
Its `state` property matches the handle's, and is `undefined` before the first draw.

It dispatches `render`, `screenchange`, `orientationchange`, `zoomchange` and `error` events. Each
is a `CustomEvent` whose `detail` matches the `mount` callback's argument:

```js
element.addEventListener("error", (event) => console.warn(event.detail.message));
```

## Draw without a DOM

`renderPrototype(spec, options)` returns the element tree without touching the page. It takes
`frame`, `orientation`, `mode`, `screen`, `locale`, `textSize` and `parseGlyph`. `parseGlyph` turns
an envelope glyph's SVG markup into shapes; without it, icons draw a placeholder. It throws `PrototypeWebRefusal`,
whose `error` holds the fields below.

## Errors

A refused input draws an error view (`role="alert"`) in place of the prototype, with the message
as its text. The library also calls `onError`, or the element dispatches `error`, and sets
`state.error`.

The error has `code`, `message`, `missing` (the capabilities this release lacks, for
`missingCapabilities`) and `libraryVersion`.

| Code                  | Cause                                                                                                                   | What to do                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `missingCapabilities` | The envelope or bare spec needs a capability this release does not draw.                                                | Update the package, or remove what the message names.   |
| `unknownVersion`      | The envelope's `version` is not `1`.                                                                                    | Update the package.                                     |
| `invalidInput`        | `spec` is not an object, the envelope lacks a `requires` list or a `spec` object, or the element's JSON does not parse. | Pass the whole envelope or a spec object; fix the JSON. |
| `invalidOption`       | An unknown frame id, an invalid frame object, an orientation the frame lacks, or an invalid locale.                     | Fix the option the message names.                       |

`PROTOTYPE_WEB_LIBRARY_VERSION` is the package version, and `PROTOTYPE_WEB_CAPABILITIES` lists
every capability it draws.
