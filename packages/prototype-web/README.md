# @kaeawc/auto-mobile-prototype-web

Draws an AutoMobile prototype in a device frame on any web page, with no dependencies.

```js
import { mount } from "@kaeawc/auto-mobile-prototype-web";

const handle = mount(document.querySelector("#prototype"), {
  spec: envelope, // from automobile:prototype/{id}/embed, or a bare spec
  frame: "pixel-9",
  controls: ["rotate", "zoom", "screen"],
  onError: (error) => console.warn(error.message),
});
```

Pass an embed envelope rather than a bare spec: the library refuses an envelope that needs a
capability it does not draw, while a bare spec from a newer server may draw incompletely.

Or use the custom element; its attributes set the scalar options and its spec is the `spec`
property or a child JSON script:

```html
<script type="module" src="…/@kaeawc/auto-mobile-prototype-web/dist/element.js"></script>
<automobile-prototype frame="pixel-9" controls="rotate zoom">
  <script type="application/json">
    { "id": "hello", "root": { "type": "text", "text": "Hello" } }
  </script>
</automobile-prototype>
```

It dispatches `render`, `screenchange`, `orientationchange`, `zoomchange` and `error` events.

`renderPrototype(spec, options)` returns the element tree without touching the DOM.

Apache-2.0.
