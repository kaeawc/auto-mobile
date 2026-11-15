# Prototype web renderer: browser and parity checks

Part of [the prototype web renderer](prototype-web-renderer.md).

## Browser check

`test/features/prototype/web/webScreenshots.integration.test.ts` loads the page of each reference
spec in headless Chromium, Firefox and WebKit: `reference-checkout` plus `template-feed-detail`,
`pager-indicator-dots`, `grid-fixed-columns-span`, `material-controls`, `component-gallery`,
`doc-example-2`, `native-controls` (every button variant and two sliders) and `image-gallery`
(its assets are `test/fixtures/prototype-web/assets/<id>.png`), each in `pixel-9` and `iphone-16`, portrait,
and `reference-checkout` alone in each watch, TV and car frame (the list is
`webScreenshotCases.ts`). Playwright (`playwright-core`) is a devDependency of this check only;
nothing at runtime drives a browser.

- **Assertions.** The page is served from one fixed URL and every other request is aborted and
  fails the case, on top of the page's own CSP. No console error, page error or
  `securitypolicyviolation` event may occur. Exactly one view is shown, with a non-zero size, in
  the frame's first orientation; the stage carries the runtime's fitted scale and
  the zoom label shows it; a watch, TV or car page has no rotate control; on other frames, halfway
  through rotate both views are shown and turned, and the finished turn shows only the landscape
  view, wider than tall; with reduced motion, rotate starts no animation; a page with a screen select shows exactly the picked
  screen's view; the 3D toggle turns the shown view to the three-quarter pose, an arrow key on the
  focused viewport orbits it, and toggling back restores the shown view's DOM byte for byte. The
  browser clock is fixed at 9:41 UTC, so the live status bar clock matches the stills; a separate
  case installs a running clock and checks the clock advances each minute. Another checks that
  only an overflowing scroll fades, or, in an engine without scroll-driven animations, that every
  scroll does. Every engine runs these assertions; CSS 3D and clipping differ between engines, so
  a page that only works in Chromium fails here.
- **Settings cases.** `reference-checkout` also renders in both phone frames at the largest text size
  (`fontScale` 2, `accessibility-extra-extra-extra-large`) and in the `ar` locale (RTL), golden
  `<spec>--<frame>--<setting>.png` (and `--landscape.png` after it).
- **Goldens.** Compared only in Chromium, the one engine whose CI build they are trusted from.
  One PNG per orientation of the case's frame in `test/fixtures/prototype-web/screenshots/`
  (`<spec>--<frame>.png` as the page opens and, on a frame that rotates,
  `<spec>--<frame>--landscape.png` at the end of the turn; plain git blobs, not LFS), taken at
  800×800 CSS px, device scale factor 1,
  with every font forced to `"DejaVu Sans", sans-serif` and the caret hidden. No font is bundled. A
  case matches when at most 0.1 % of pixels differ by more than pixelmatch's 0.1 colour distance; a
  different size never matches. A unit test keeps the directory in step with the case list.
- **Image layout.** `test/fixtures/prototype-web/image-layout-golden.json` holds the image, parent
  and image-layer boxes of un-padded inlined images (fill, fixed, wrapped and weighted, in rows and
  columns, each `contentScale`), from `getBoundingClientRect` in layout px from the fixture root (so
  the frame's host-dependent fit scale drops out), measured from the renderer before the padded
  content box; Chromium must reproduce them within 0.05 px. `--update`
  rewrites it, only for a deliberate layout change.
- **Running.** `bash scripts/prototype/web-screenshots.sh` runs it (the integration lane skips it
  without `AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS=1`); `--update` rewrites the goldens, and
  `--engine <chromium|firefox|webkit>` (repeatable) limits the engines. It needs the browser builds
  of the pinned `playwright-core`:
  `node_modules/.bin/playwright-core install --only-shell chromium firefox webkit`. Every case that
  reaches capture writes `<case>.png`, and a Chromium pixel mismatch also `<case>.diff.png`, to
  `AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT` (default `scratch/prototype-web-screenshots/`);
  Firefox and WebKit captures go to its `firefox/` and `webkit/` subdirectories.
- **CI.** The advisory `Prototype Web Screenshots` workflow runs it on Linux nightly, on dispatch,
  and on pull requests that touch the web renderer, its reference fixtures, the check, or
  `package.json`/`bun.lock`. It is not a required check. Goldens are trusted only from that Linux
  Chromium build, whose text anti-aliasing other machines may not match, so a local run can fail on
  pixels alone; when the runner renders differently, the job uploads the
  `prototype-web-screenshots` artifact on every run, and adopting it means reviewing its top-level
  PNGs and copying those other than `*.diff.png` into the golden directory.

## Android parity check

`test/features/prototype/web/webAndroidParity.integration.test.ts` measures how far the still is
from the Android renderer. For each Roborazzi golden in
`android/control-proxy/src/test/resources/screenshots/prototype/`, `webAndroidParityCases.ts`
either rebuilds the spec the Kotlin case renders (fixture, `night`/`notnight` mode, state
overrides, `themeFrom` and the case's JSON edit) or lists the golden with a reason; host window
chrome and content-sized floating captures are listed, not compared. Every compared spec is placed
fullscreen, because the goldens draw the root and theme without the window's placement.

- **Rendering.** The still is drawn `chromeless` on the `small-phone` frame (360×640 dp, the
  goldens' `w360dp-h640dp-mdpi`, so one dp is one pixel) into a bare document with no page shell,
  at device scale factor 1 with the same forced font as the page check. Chromeless drops the
  bezel, bars, cutout, corner radius, safe-area insets and window background, because the goldens
  capture the content path with no window and are transparent where nothing draws; the screenshot
  omits the page background to match. A golden smaller than the screen is compared with the
  screen's top-left region of its size.
- **Budgets.** `test/fixtures/prototype-web/android-parity-budgets.json` maps each compared golden
  to the most pixels that may differ by more than pixelmatch's 0.1 colour distance. A case fails
  when it differs in more than its budget plus 256 pixels or 1 %, whichever is larger: hosted
  runners do not all rasterize alike, so the same commit's counts move slightly between CI runs.
  The allowance never reaches the golden's pixel count, so a screenshot that differs everywhere
  fails. Budgets only shrink: `--update` lowers each to what was measured and
  records a missing one, and raises one only with `--allow-grow`. The counts are measured by the
  CI Chromium build; every run logs them on one `android parity diff pixels:` line. A unit test
  keeps the case table, the skip list and the budget keys in step with the golden directory.
- **Output.** `<golden>.png` and, when any pixel differs, `<golden>.diff.png` go to
  `android-parity/` under the output directory, uploaded with the page check's artifact.

## iOS parity check

`webIosParityCases.ts` reuses the Android parity specs and content-only transforms, with a
reasoned skip list for content-sized floating captures and host chrome. The standalone viewer
recorder, `bash scripts/ios/prototype-record-goldens.sh <simulator-udid>`, requires an already
booted iPhone 16 on iOS 27.0 (24A434), the golden runtime, so re-records stay comparable, and the
app built by `scripts/ios/prototype-viewer-build.sh`. It installs a fresh
viewer per case, loads the emitted spec through `Documents/prototype/`, and sets light or dark
appearance before launch. It launches the viewer with `--automobile-prototype-recording`, which
turns all motion off as `motion: "none"` does (indeterminate progress draws one fixed frame, and
dialogs appear without an entrance animation) and pins date-dependent content to the `en_US_POSIX`
locale, UTC and a fixed clock (2026-01-15T12:00Z) for value formats. A `datePicker` draws a static
six-week month grid instead of the system graphical picker, whose UIKit calendar keeps laying out
its month after captures match; it opens on the bound date's month (the fixed day when unbound) and
marks no device "today".
Without the flag the viewer is unchanged. It refuses the CI iPhone, clears its status override and
restores light appearance on exit. Optional `--viewer`, `--out` and golden names select the app, destination and cases.

- **Geometry.** Goldens in `ios/prototype-agent/Goldens/iphone-16/` are the full 1179×2556 pixel
  screenshot of the 393×852 pt screen at 3×, with the status bar pinned to 9:41. The viewer draws
  content from the top edge under the status bar, so nothing is cropped; the comparison ignores the
  clock and the signal/battery glyph rects, which the simulator draws over the content. The emitter
  `scripts/prototype/ios-golden-specs.ts` writes content-only specs and `cases.json` with the
  shared pixel geometry and case modes. The recorder checks the screenshot size.
- **Stable capture.** Two identical frames prove the screen is static, not that the viewer has
  rendered, so the recorder waits a settle floor (`PROTOTYPE_GOLDEN_STABLE_SETTLE_SECS`, default
  1.5 s) after launch before its first screenshot. It then captures every 0.5 s until two
  consecutive full screenshots are byte-identical (`capture=stable`), for at most
  `PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES` (8) captures within `PROTOTYPE_GOLDEN_STABLE_BUDGET_SECS`
  (15 s, counted from launch). Each screenshot is bounded by the remaining budget, capped at
  `PROTOTYPE_GOLDEN_CAPTURE_TIMEOUT_SECS` (10 s), with a watchdog that needs no GNU `timeout`. A
  screenshot that fails, times out or writes an empty file is discarded and never compared, so
  stability needs two good frames in a row. When polling ends unstable, the recorder settles 2 s
  and records one more bounded screenshot (`capture=fallback`); if that one is bad, it fails.
- **Rendering.** Chromium draws the `iphone-16` still with its iOS skin and safe-area environment
  in a bare document. CSS removes the frame padding, background and corner radii; the whole
  screen is clipped at 3×. Only the screen default font is pinned to DejaVu Sans.
- **Budgets and output.** `test/fixtures/prototype-web/ios-parity-budgets.json` uses the Android
  check's 0.1 pixel distance, runner allowance and `--update` / `--allow-grow` policy. Budgets are
  measured with `--update` after recording. Directory-dependent unit tests require
  complete case coverage, exact PNG sizes and matching budget keys. The opt-in advisory
  `Prototype Web Screenshots` workflow runs both parity checks in Chromium and uploads iOS
  captures and diffs under `ios-parity/`. Golden paths are exempt from LFS so checkout reads PNGs.
