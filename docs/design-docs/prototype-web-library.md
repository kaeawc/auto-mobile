# Prototype web library

This note decides how the prototype web renderer becomes an npm library that any website can
use to embed a prototype in a device frame. It is the web member of the embeddable renderer
family (#13720), beside the Compose library and the `AutoMobilePrototype` Swift package
([Native prototype embedding](prototype-embedding.md)). The renderer itself is described in
[Prototype web renderer](prototype-web-renderer.md).

**Decision: go, in stages.** Ship a static, framework-free library first. Interactivity and a
link to a running daemon are separate decisions with their own gates, below.

## Starting point

- `@kaeawc/auto-mobile` is the CLI and MCP server: a `bin`, no `exports`, no workspaces and 65
  pinned runtime dependencies (`scripts/release/runtime-graph.json`). A browser library inside
  it would make every embedder install the CLI's dependency graph.
- The still renderer (`renderPrototypeStill` in `src/features/prototype/web/webStill.ts`) is a
  pure function from spec, frame, orientation, mode and screen to an element tree. It already
  runs no actions, timers or requests, and serializes deterministically. The page runtime
  (`webPageRuntime.ts`) only switches pre-rendered views and moves the stage.
- `renderPrototypeStill` and `toHtml` bundle for the browser with no Node builtin, at about 111 KB
  minified (38 KB gzip). Element builders share repeated style-property names, attribute names
  and style values as identifiers from `webCss.ts`, so each long literal is bundled once, and
  device-frame provenance lives in `deviceFrameSources.json`, outside the closure. The closure
  reads only the contract values in the generated `prototypeRenderContract.generated.ts`, not the
  whole contract JSON; the string-table zod schema lives in `prototypeStringsSchema.ts` and the frame schema in `deviceFrameSchema.ts`, outside
  the closure; the derived-format path takes an optional injected logger instead of
  importing the server's; and an invalid locale, text size or frame throws a plain
  `PrototypeWebInputError`, which the server's page builder and resource readers rethrow as an
  `ActionableError` with the same message. `stillBrowserBundle.test.ts` fails on any Node builtin,
  on the contract JSON, zod, the server logger or `ActionableError` in the closure, and on the core
  budget below.
- Shared JSON fixtures already drive parity across the TypeScript host, the Kotlin protocol and
  the Swift agent (`test/fixtures/prototype-spec/list-writes/`, `derive/`).

## Packaging

**A separate package, `@kaeawc/auto-mobile-prototype-web`, built from the renderer source in
`src/` and published with zero runtime dependencies.** The package directory
(`packages/prototype-web/`) holds only its `package.json`, entry points, type declarations and
build script; `bun build --target=browser` bundles the renderer into it.

- **Not a subpath export.** `@kaeawc/auto-mobile/prototype-web` would install the CLI's 65
  dependencies and `bin` into every website, and tie the browser bundle's size to the server's
  package.
- **Not a Bun workspace yet.** A workspace changes `bun.lock`'s shape, the roots that
  `scripts/release/pin-runtime-deps.ts` computes, Turbo task graphs and the affected-test
  selector, for a package that has no dependencies to manage. Because everything is bundled,
  the package adds nothing to the root lock file or the pinned runtime graph, and the existing
  `runtime-pins` lane is unaffected. Revisit a workspace only if the library gains its own
  runtime dependency.
- **Moving source is not required.** The renderer stays in `src/features/prototype/web/`, where
  the MCP resource uses it. A boundary check keeps the library's import closure free of Node
  builtins and server modules, so a server-side import cannot silently break the browser build.
- **Release.** Versions move in lockstep with `@kaeawc/auto-mobile`, published by the same
  release job after the main package and guarded by `scripts/release/already-published.sh` like
  it. Lockstep keeps `rendererVersion` in the web resource's `_meta` meaning one thing.
- **CI.** A fast unit test bundles the library entry for the browser and fails on any Node
  builtin or on a size over budget. The existing `Prototype Web Screenshots` check gains one case
  that loads the library build rather than the page, so the two renderings cannot drift.
- **License.** Apache-2.0, as the main package.

## Embedding surface

Three layers, each built on the one below. The first two are the supported API; framework
wrappers are not shipped.

1. **`renderPrototype(spec, options)`**: pure, no DOM. Returns the element tree,
   `unsupportedNodes` and the stack's screens, exactly what `renderPrototypeStill` returns. It
   runs in a worker or on a server for pre-rendering.
2. **`mount(element, options)`**: attaches a shadow root to `element`, draws the frame and the
   chosen controls into it and returns a handle with `update(options)`, `destroy()` and the
   current view state. The DOM is built with `createElement` and `style.setProperty`, never
   `innerHTML`, so a host page with a strict CSP (`style-src` without `'unsafe-inline'`) or
   Trusted Types can embed it; the shell stylesheet is a constructable stylesheet adopted by the
   shadow root.
3. **`<automobile-prototype>`**: a custom element registered by importing
   `@kaeawc/auto-mobile-prototype-web/element`. Attributes cover the scalar options (`frame`,
   `orientation`, `zoom`, `mode`, `screen`, `controls`); the spec is set as a property (`el.spec =
   …`) or from a child `<script type="application/json">`, never from an attribute or a URL the
   element fetches. Shadow DOM isolates both directions: host styles do not reach the device
   screen, and the renderer's styles do not leak out.

React 19 and Vue 3 pass properties and listen to custom events on custom elements natively, so
thin wrappers would add a package each to version, test and size-gate for little gain. Add one
only on demand, generated from the element's typed option list.

## Public options

These are public and stable. Everything else (element tree shape, CSS class names, the page
shell) is internal.

| Option        | Values                                                                      | Default                        |
| ------------- | --------------------------------------------------------------------------- | ------------------------------ |
| `spec`        | A prototype spec object, or an embed envelope (see Versioning)              | required                       |
| `frame`       | A registry id, a frame object valid against the registry schema, or `false` | `pixel-9`                      |
| `orientation` | `portrait`, `landscape`                                                     | `portrait`                     |
| `zoom`        | `fit` or a number from 0.5 to 4                                             | `fit`                          |
| `mode`        | `light`, `dark`, `system` (follows `prefers-color-scheme`)                  | `system`                       |
| `screen`      | A screen key of the outermost stack                                         | the stack's `start`            |
| `controls`    | `false`, or any of `rotate`, `zoom`, `screen`                               | `["rotate", "zoom", "screen"]` |
| `locale`      | A BCP 47 tag for string tables, formatting and layout direction             | `en-US`                        |
| `textSize`    | `{fontScale}` (Android frame, 0.85–2) or `{contentSize}` (iOS frame)        | the platform default           |

- **Chromeless** is `frame: false` with `controls: false`: the default frame's screen size and
  safe areas without bezel, status bar, cutout or navigation marks, for pages that draw their own
  chrome.
- **Custom frames** are validated with the same strict schema as `deviceFrames.json`; an invalid
  object is refused with the schema path, never drawn with wrong geometry. Frame schema v2
  ([web frames v2](prototype-web-frames-v2.md)) adds `posture` as an option when it lands.
- **Theme overrides** are not an option. The spec's `theme` is the theme; an embedder that wants
  another one changes the spec. A second theme channel would need its own precedence rules
  against `theme.mode`, `styleWhen` and the Material baseline, on every platform.
- **Events** are DOM `CustomEvent`s on the element and callbacks in `mount` options:
  `render` (with `unsupportedNodes`), `screenchange`, `orientationchange`, `zoomchange` and
  `error` (with the refusal, see Versioning). `tap`, `statechange` and `navigate` belong to the
  interactive stage and are not emitted by the static library.

## Live updates

**Static specs only.** The library never connects to a daemon.

- The daemon's HTTP ingress requires a bearer token (`src/daemon/daemonHttpToken.ts`). A website
  cannot hold that token safely, and loosening it for browsers (CORS, a token-free read
  endpoint) would let any page the user visits read every prototype the daemon knows, including
  bound `/data`.
- `automobile:prototype/{id}/web` updates already reach MCP clients through
  `resources/updated`. An embedder that wants live updates fetches the new spec by its own
  authenticated route and calls `handle.update({spec})`; `update` keeps zoom, orientation and
  screen when the new spec still has that screen.
- A daemon-served local preview page (same origin, token in the URL fragment) is the only shape
  worth considering later. It is a separate security decision under
  [platform security](prototype-platform-security.md), not part of this library.

## Interactivity

The static library draws still screens. Running the action vocabulary in the browser is a
later, separately gated stage.

- **What it takes.** The still renderer is pure, so an interactive runtime is a state store
  (state, `/data`, stack and pager positions, timers) plus re-rendering the affected subtree on
  each change. Of the 23 actions, the state, data-write, navigation, `setPage`, `scrollTo`,
  timer, `dismiss`, `hideKeyboard` and `emit` actions are pure; `request` is refused (no mock
  backend in a public page), and `platform` is refused with the module named, because there is
  no device. Transitions and motion are not animated; the runtime switches to the end state.
- **Size.** The interactive runtime ships as a separate entry
  (`@kaeawc/auto-mobile-prototype-web/interactive`), so a static embed never pays for it.
- **Parity.** Action semantics are tested by shared trace fixtures
  (`test/fixtures/prototype-spec/action-traces/`): a spec, then steps that each run one tap's
  actions or advance a fake clock, with the expected state, `/data`, stack paths, pager pages
  and shown flag after each step. The TypeScript tests, the Android runtime tests and the Swift
  agent tests each run every trace. A trace one platform cannot run yet is listed under that
  platform in `action-trace-skips.json` with its issue, and a skipped trace that passes fails
  the run, so a gap is visible rather than silent and the list only shrinks.
- **Go criterion.** Build it only after the static library has an embedder asking for taps;
  the trace fixtures are worth adding first regardless, because they also tighten Android and
  iOS parity.

## Versioning

The library is a runtime like a device: it advertises the capabilities it renders, and a spec
that needs more is refused whole, never half drawn.

- **Embed envelope.** The host exports
  `{format: "automobile-prototype-embed", version: 1, requires: [...], spec}`, where `requires` is
  `requiredPrototypeCapabilities(spec)` computed by the host that validated the spec. A new
  `automobile:prototype/{id}/embed` resource (`application/json`) serves it with the same
  revision, variant and error rules as the web resource.
- **Refusal.** The library compares `requires` with its own advertised set and, on any missing
  capability, draws an error view and emits `error` with the missing capabilities and the
  library version. An unknown envelope `version` is refused the same way.
- **Bare specs.** A spec without an envelope is accepted, with `requires` derived by the
  library's bundled gate table. That table only knows the fields of its own release, so a newer
  field it does not recognize is not detected; the README states that envelopes are the
  supported path for specs from a newer server.
- **Unsupported but known.** A node type the library knows but cannot draw keeps today's dashed
  placeholder and appears in `unsupportedNodes`, as in the web page.
- **Validation is not bundled.** The strict validator needs the full contract and zod. The
  library trusts the envelope's host validation, and escapes all text and rejects event-handler
  attributes as the still renderer already does.

## Size and tree-shaking

Budgets are minified and gzip, measured by the bundling test, for an embed that imports only
that entry:

| Entry          | Contents                           | Minified | Gzip   |
| -------------- | ---------------------------------- | -------- | ------ |
| core (`mount`) | renderer, frame registry, `mount`  | 136 KB   | 46 KB  |
| `element`      | core plus the custom element       | 141 KB   | 48 KB  |
| `interactive`  | the action runtime, on top of core | +40 KB   | +12 KB |

- Per-node tree-shaking is not offered. Node renderers are dispatched by type from a spec only
  known at runtime, so a bundler cannot drop any. Splitting renderers into opt-in groups would
  make an embed silently show placeholders for nodes its author forgot to register; the budget
  is met without it.
- The frame registry stays bundled (3 KB); frames are data, not code.

## Delivery order

Each step is one pull request and leaves `main` releasable:

1. Make the still renderer's import closure browser-safe and add the bundling and size test.
2. Add the embed envelope and the `automobile:prototype/{id}/embed` resource.
3. Add `packages/prototype-web/` with `renderPrototype` and `mount`, the boundary check and a
   screenshot case that loads the library build.
4. Add the `<automobile-prototype>` element and its events.
5. Publish from the release job in lockstep and document the library under `docs/using/`.
6. Add shared action trace fixtures run by TypeScript, Kotlin and Swift.
7. Decide the interactive runtime against an embedder's request; build it on the trace fixtures.
