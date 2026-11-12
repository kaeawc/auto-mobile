# Prototype web library

The prototype web renderer is meant to become an npm library any website can use to embed a
prototype in a device frame, the web member of the embeddable renderer family (#13720) beside the
Compose library and the `AutoMobilePrototype` Swift package
([Native prototype embedding](prototype-embedding.md)). The renderer itself is described in
[Prototype web renderer](prototype-web-renderer.md).

No library package is published yet: there is no `packages/prototype-web/`, `mount`,
`<automobile-prototype>` element or interactive runtime. What exists today is the groundwork below.
The planned package, API, options and release are in the devlog entry under Background.

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
  JSON, zod, the server logger or `ActionableError` in the closure, and on a bundle over 500,000
  bytes of HTML, JS and CSS counted together, minified (no separate gzip limit).

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
