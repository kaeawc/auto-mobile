# playwright-core for the prototype web screenshot check

Status: accepted for #16346 (CI-only headless browser screenshot check of the prototype web
renderer's reference specs).

Dependency: `playwright-core`

## Decision

The advisory `Prototype Web Screenshots` workflow loads the pages `buildPrototypeWebPage`
produces in headless Chromium, asserts that they run cleanly offline and compares each screenshot
with a golden. It drives Chromium through `playwright-core`, a devDependency pinned to an exact
version: that version names the Chromium build the workflow installs, and goldens are trusted only
from that Linux build. A golden changes when the rendered page changes and is regenerated with
`--update`, or when the CI artifact's screenshots are adopted. `playwright-core` downloads no browser at package install time; the
workflow installs one. Nothing in `src/` imports it, so there is still no headless browser at
runtime. The pixel comparison reuses `diffPngs` (`pixelmatch` and `pngjs`, already direct
dependencies).

## Alternatives checked

| Alternative                          | Why not                                                                                                                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bun.WebView` (runtime built-in)     | Experimental in Bun 1.4.4, and its Chrome backend launches whatever Chrome the host has, so the browser build (and the goldens) would drift with the runner image. Request interception and console capture need raw CDP.  |
| Hand-written CDP client over `ws`    | `test/integration/mediamtxWebRtcPublisher.integration.test.ts` does this for one evaluate call; launching, request routing, console and CSP capture and screenshots would reimplement Playwright without a pinned browser. |
| `playwright` (full package)          | Same API, but it also pulls the test runner; `playwright-core` is the library alone.                                                                                                                                       |
| `puppeteer`                          | Downloads Chrome in a postinstall step, which would put a browser download into every `bun install`.                                                                                                                       |
| String assertions on the page's HTML | The unit tests already do this; they cannot show that the script runs under the CSP, that the first view has a size, or that rotate switches views.                                                                        |
