# Committed page bundle and one export budget

- Kind: decision
- Date: 2026-11-19
- Source: #16528
- Shaped: [Prototype web library](../how-it-works/prototype-web-library.md)

## Context

#16528 has the prototype web page inline one minified bundle, the same build as the library's
`mount`, and draw the shown view in the browser. The page builder is synchronous and runs in the
server. Since `dist/` does not ship `src/`, the server cannot bundle the renderer when a page is
requested. The library build was already about 197 KB minified and 64 KB gzip, over the
issue's earlier static-page targets of 110 KB / 34 KB and 250 KB / 75 KB.

## Options

Bundle delivery:

- Commit a generated bundle written by `packages/prototype-web/build.ts`, with a unit test that
  fails when it is stale.
- A Bun macro that inlines the build at bundle time. The repository had no macro.
- An async `Bun.build` at first use, which needs `src/` at runtime.

Budget:

- One 500,000-byte budget per export, HTML, JS and CSS counted together, minified, with no gzip
  limit.
- Keep the earlier targets and reduce the bundle's size first.

## Decision

The owner chose the first option of each on 2026-11-19. `packages/prototype-web/build.ts` writes
the minified build of `packages/prototype-web/src/page.ts` to
`src/features/prototype/web/prototypeWebPageBundle.generated.ts`, and the server reads that file.
Every export (`index`, `element`, `page`, and the still renderer's entry) has the one
500,000-byte budget, with no gzip limit.

## Consequences

- A change to the renderer or `mount` makes the committed bundle stale until it is regenerated
  with `bun run build` in `packages/prototype-web/`; the stale test fails until then. The bundle
  is built with the pinned Bun, since another Bun version can emit different bytes.
- The bundle carries a version mark in place of the root `package.json` version, and the server
  replaces it with the release's version, so a release's version bump does not make it stale.
- The build refuses to write any export over the budget.
