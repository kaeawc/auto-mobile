# Prototype web library

The goal is to ship the prototype web renderer as an npm library any website can use to embed a
prototype in a device frame. It is the web member of the embeddable renderer family (#13720) beside the
Compose library and the `AutoMobilePrototype` Swift package
([Native prototype embedding](prototype-embedding.md)). [Prototype web renderer](prototype-web-renderer.md)
describes the renderer itself.

`packages/prototype-web/` (`@kaeawc/auto-mobile-prototype-web`) is not published yet, and there is
no interactive runtime. The planned release is in the devlog entries under Background.

## Package

- `packages/prototype-web/` holds only `package.json` (no dependencies), the entries
  `packages/prototype-web/src/index.ts` and `packages/prototype-web/src/element.ts`, their
  hand-written public types `index.d.ts` and `element.d.ts`, and `build.ts`. It is not a Bun
  workspace, so the root `bun.lock` and the pinned runtime graph do not change.
- `bun run build` in that directory bundles each entry on its own with `bun build --target=browser`
  into `dist/index.js` and `dist/element.js` (gitignored). `dist/element.js` is the package's only
  side effect. The library source is `src/features/prototype/web/embed/`.
- `test/features/prototype/web/prototypeWebPackage.typecheck.ts` assigns each export and public type
  both ways between `index.d.ts` and the implementation, so the typecheck fails when they drift.
- `prototypeWebLibraryBundle.test.ts` is the boundary check. Each entry's browser bundle reaches no
  Node builtin and stays within the export budget below, and the element adds at most 8,000 bytes
  over `index`. Its only inputs are
  `src/features/prototype/`, the CtrlProxy protocol constants and the root `package.json`, whose
  `version` is the library version.
- `webLibrary.integration.test.ts`, run by `Prototype Web Screenshots`, mounts the library build in
  Chromium and compares its pixels with the still's `toHtml` output drawn the same way. It also
  draws `<automobile-prototype>` from the element build and compares it with `mount`.

## API

- `renderPrototype(spec | envelope, options)` is pure: it returns the still's element tree, the
  frame and orientation drawn, `unsupportedNodes` and the outermost stack's screens (start first).
  It throws `PrototypeWebRefusal` carrying `{code, message, missing, libraryVersion}`.
- `mount(element, options)` attaches an open shadow root and builds the DOM with `createElement`,
  `setAttribute` and `style.setProperty`, never `innerHTML`. Its shell stylesheet is a constructable
  stylesheet. It returns `{update, destroy, state}`; `update` merges options, keeping zoom,
  orientation and screen, and an unknown screen draws the stack's start.
- Options: `spec`, `frame`, `orientation`, `zoom`, `mode`, `screen`, `controls`, `locale` and
  `textSize`.
  - The frame is an id, or `false` for the default frame's screen alone. A frame object is not
    accepted yet.
  - Zoom is `fit` or a scale from 0.5 to 4.
  - Mode is `light`, `dark`, or `system`, which follows `prefers-color-scheme`.
  - Controls are `false`, or any of `rotate`, `zoom` and `screen`.
- Callbacks: `onRender` (`unsupportedNodes`), `onScreenChange`, `onOrientationChange`,
  `onZoomChange` and `onError`.
- The host element is 640 px tall unless the page sets its height; `fit` scales the frame into
  the viewport below the controls and refits on resize.

## Element

Importing `@kaeawc/auto-mobile-prototype-web/element` registers `<automobile-prototype>`, once and
only where `customElements` exists. `PrototypeElementController` (`embed/prototypeWebElement.ts`)
holds its logic; the class in `packages/prototype-web/src/element.ts` only forwards its lifecycle.

- Attributes `frame`, `orientation`, `zoom`, `mode`, `screen` and `controls` set the scalar options.
  - The `frame` and `controls` attributes take `false` or `none` to turn them off.
  - The `controls` attribute lists names separated by spaces or commas.
  - The `zoom` attribute is `fit` or a number. An unknown `orientation` or `mode` is ignored.
- The spec comes from the `spec` property, else the first child `<script type="application/json">`.
  It is never read from an attribute or fetched. Unparseable JSON draws the `invalidInput` error
  view. A `spec` set before the module defined the element is replayed through the setter on
  upgrade.
- It mounts when connected with a spec and destroys the mount when disconnected. Connected without
  one, it watches its children and mounts once a JSON script arrives. While the page is still
  parsing, it waits for the script's text to parse; after that, invalid JSON draws the error view. A changed
  attribute or spec updates the mount; a removed attribute mounts afresh, because `update` keeps
  an option it is not given.
- Events are `CustomEvent`s carrying the `mount` callback's detail: `render`, `screenchange`,
  `orientationchange`, `zoomchange` and `error`. Events fired while the first mount draws are
  dispatched once it returns, so a listener can set the spec or remove the element.

## Refusal

- An envelope with a `version` other than 1, or whose `requires` names a capability outside
  `PROTOTYPE_WEB_CAPABILITIES`, draws an error view (`role="alert"`) and calls `onError`.
- `PROTOTYPE_WEB_CAPABILITIES` is generated from `knownPrototypeCapabilities()` by
  `scripts/prototype/generate-prototype-web-capabilities.ts`; a unit test fails when it is stale.
- A bare spec is drawn without a capability check. An unknown frame, an orientation the frame lacks
  or an invalid locale is refused with `invalidOption`.
- Envelope glyphs are parsed with the browser's `DOMParser` into allow-listed SVG shapes; without
  one (in a worker) icons draw the placeholder.

## Browser-safe still renderer

- `renderPrototypeStill` (`src/features/prototype/web/webStill.ts`) is a pure function from spec,
  frame, orientation, mode and screen to an element tree. It runs no actions, timers or requests
  and serializes deterministically. The page runtime (`webPageRuntime.ts`) only switches
  pre-rendered views and moves the stage.
- `renderPrototypeStill` and `toHtml` bundle for the browser with no Node builtin. To keep the
  closure small and browser-safe:
  - element builders share repeated style-property names, attribute names and style values as
    identifiers from `webCss.ts`, so each long literal is bundled once;
  - device-frame provenance lives in `deviceFrameSources.json`, the string-table zod schema in
    `prototypeStringsSchema.ts` and the frame schema in `deviceFrameSchema.ts`, all outside the
    closure;
  - the closure reads only the contract values in the generated
    `prototypeRenderContract.generated.ts`, not the whole contract JSON;
  - the derived-format path takes an optional injected logger instead of importing the server's;
  - an invalid locale, text size or frame throws a plain `PrototypeWebInputError`, which the
    server's page builder and resource readers rethrow as an `ActionableError` with the same
    message.
- `test/features/prototype/web/stillBrowserBundle.test.ts` fails on any Node builtin, the contract
  JSON, zod, the server logger or `ActionableError` in the closure. It also fails on a bundle over
  500,000 bytes of HTML, JS and CSS counted together, minified (no separate gzip limit).

## Embed envelope

`automobile:prototype/{id}/embed` serves `{format: "automobile-prototype-embed", version: 1,
requires, spec}`, where `requires` is `requiredPrototypeCapabilities(spec)` computed by the host
that validated the spec, so a web renderer can refuse a spec it cannot draw whole. Its revision,
variant and error rules and its `glyphs` and `iconMissing` fields are described under "Embed
envelope" in [Prototype web renderer](prototype-web-renderer.md).

## Action trace fixtures

`test/fixtures/prototype-spec/action-traces/` holds shared traces: a spec, then steps that each run
one tap's actions or advance a fake clock, with the expected state, `/data`, stack paths, pager
pages and shown flag after each step. The TypeScript tests (`prototypeActionTraces.test.ts`), the
Android runtime tests (`PrototypeActionTracesTest`) and the Swift agent tests
(`PrototypeActionTracesTests`) each run every trace. A trace one platform cannot run yet is listed
under that platform in `action-trace-skips.json` with its issue, and a skipped trace that passes
fails the run, so the list only shrinks.

## Background

- [Embeddable web prototype library plan](../devlog/2026-11-03-prototype-web-library-plan.md)
- [Web library advertises the host's known capabilities](../devlog/2026-11-16-prototype-web-library-capabilities.md)
