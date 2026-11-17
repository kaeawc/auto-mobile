# Prototype web renderer: browser and parity checks

Part of [the prototype web renderer](prototype-web-renderer.md).

## Browser check

`test/features/prototype/web/webScreenshots.integration.test.ts` loads the page of each reference
spec in headless Chromium, Firefox and WebKit. The specs are `reference-checkout` plus
`template-feed-detail`, `pager-indicator-dots`, `grid-fixed-columns-span`, `material-controls`,
`component-gallery`, `doc-example-2`, `native-controls` (every button variant and two sliders) and
`image-gallery` (its assets are `test/fixtures/prototype-web/assets/<id>.png`). Each renders in
`pixel-9` and `iphone-16`, portrait, and `reference-checkout` alone renders in each watch, TV and car
frame (the list is `webScreenshotCases.ts`). Playwright (`playwright-core`) is a devDependency of this check only;
nothing at runtime drives a browser.

- **Isolation.** The check serves the page from one fixed URL and aborts every other request,
  which fails the case, on top of the page's own CSP. No console error, page error or
  `securitypolicyviolation` event may occur.
- **Views and rotation.** Exactly one view shows, with a non-zero size, in the frame's first
  orientation. The stage carries the runtime's fitted scale and the zoom label shows it. A watch,
  TV or car page has no rotate control. On other frames, halfway through rotate both views show
  and turn, and the finished turn shows only the landscape view, wider than tall. With reduced
  motion, rotate starts no animation. With rotation locked, rotate turns only the shown portrait view,
  which ends sideways and wider than tall; unlocking then shows the landscape view upright.
- **Screen select and 3D.** A page with a screen select shows exactly the picked screen's view. The
  3D toggle turns the shown view to the three-quarter pose, and an arrow key on the focused viewport
  orbits it. Toggling back restores the shown view's DOM byte for byte.
- **Fold postures.** `webDevice3dFold.integration.test.ts` (Chromium) opens `reference-checkout` on
  `pixel-fold` (book) and `flip-foldable` (flip), enters 3D and picks `opened`, `half_opened` and
  `closed` in turn. Each must draw the leaf transform `prototypeWebPose` gives for the posture's hinge
  angle and the matching status line. Leaving 3D must restore the shown view's DOM. Its screenshots
  go to `device-3d/` under the output directory; they are not compared with goldens.
- **Clock and scroll.** The check fixes the browser clock at 9:41 UTC, so the live status bar clock
  matches the stills. A separate case installs a running clock and checks the clock advances each
  minute. Another checks that only an overflowing scroll fades, or, in an engine without
  scroll-driven animations, that every scroll does.
- **Engines.** Every engine runs these assertions. CSS 3D and clipping differ between engines, so a
  page that only works in Chromium fails here.
- **Settings cases.** `reference-checkout` also renders in both phone frames at the largest text size
  (`fontScale` 2, `accessibility-extra-extra-extra-large`) and in the `ar` locale (RTL), golden
  `<spec>--<frame>--<setting>.png` (and `--landscape.png` after it).
- **Goldens.** Only Chromium compares goldens, the one engine whose CI build they are trusted
  from. There is one PNG per orientation of the case's frame in
  `test/fixtures/prototype-web/screenshots/`, as plain git blobs, not LFS. The page as it opens is
  `<spec>--<frame>.png` and, on a frame that rotates, the end of the turn is
  `<spec>--<frame>--landscape.png`. The check takes them at 800×800 CSS px, device scale factor 1,
  with every font forced to `"DejaVu Sans", sans-serif` and the caret hidden. No font is bundled. A
  case matches when at most 0.1 % of pixels differ by more than pixelmatch's 0.1 colour distance; a
  different size never matches. A unit test keeps the directory in step with the case list.
- **Image layout.** `test/fixtures/prototype-web/image-layout-golden.json` holds the image, parent
  and image-layer boxes of un-padded inlined images (fill, fixed, wrapped and weighted, in rows and
  columns, each `contentScale`). The boxes come from `getBoundingClientRect` in layout px from the
  fixture root, so the frame's host-dependent fit scale drops out. They were measured from the
  renderer before the padded content box, and Chromium must reproduce them within 0.05 px. `--update`
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
  pixels alone. The job uploads the `prototype-web-screenshots` artifact on every run. When the
  runner renders differently, adopting it means reviewing its top-level PNGs and copying those other
  than `*.diff.png` into the golden directory.

## Android parity check

`test/features/prototype/web/webAndroidParity.integration.test.ts` measures how far the still is
from the Android renderer. For each Roborazzi golden in
`android/control-proxy/src/test/resources/screenshots/prototype/`, `webAndroidParityCases.ts`
either rebuilds the spec the Kotlin case renders or lists the golden with a reason. The rebuilt
spec carries the fixture, `night`/`notnight` mode, state overrides, `themeFrom` and the case's JSON
edit. The table lists host window chrome and content-sized floating captures instead of comparing
them. The check places every compared spec fullscreen, because the goldens draw the root and theme
without the window's placement.

- **Rendering.** The check draws the still `chromeless` on the `small-phone` frame (360×640 dp,
  the goldens' `w360dp-h640dp-mdpi`, so one dp is one pixel) into a bare document with no page
  shell. It uses device scale factor 1 with the same forced font as the page check. Chromeless
  drops the bezel, bars, cutout, corner radius, safe-area insets and window background. The goldens
  capture the content path with no window and are transparent where nothing draws, so the
  screenshot omits the page background to match. A golden smaller than the screen is compared with the
  screen's top-left region of its size.
- **Budgets.** `test/fixtures/prototype-web/android-parity-budgets.json` maps each compared golden
  to the most pixels that may differ by more than pixelmatch's 0.1 colour distance. A case fails
  when it differs in more than its budget plus 256 pixels or 1 %, whichever is larger. Hosted
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
booted iPhone 16 on iOS 27.0 (24A434), the golden runtime, so re-records stay comparable. It also
requires the app built by `scripts/ios/prototype-viewer-build.sh`. It installs a fresh
viewer per case, loads the emitted spec through `Documents/prototype/`, and sets light or dark
appearance before launch.

It launches the viewer with `--automobile-prototype-recording`, which
turns all motion off as `motion: "none"` does: indeterminate progress draws one fixed frame, and
dialogs appear without an entrance animation. The flag also pins date-dependent content to the
`en_US_POSIX` locale, UTC and a fixed clock (2026-01-15T12:00Z) for value formats.

A `datePicker`
draws a static six-week month grid instead of the system graphical picker, whose UIKit calendar
keeps laying out its month after captures match. The grid opens on the bound date's month (the
fixed day when unbound) and marks no device "today".
Without the flag the viewer is unchanged. It refuses the CI iPhone, clears its status override and
restores light appearance on exit. Optional `--viewer`, `--out` and golden names select the app, destination and cases.

- **Geometry.** Goldens in `ios/prototype-agent/Goldens/iphone-16/` are the full 1179×2556 pixel
  screenshot of the 393×852 pt screen at 3×, with the status bar pinned to 9:41. The viewer draws
  content from the top edge under the status bar, so nothing is cropped; the comparison ignores the
  clock and the signal/battery glyph rects, which the simulator draws over the content. The emitter
  `scripts/prototype/ios-golden-specs.ts` writes content-only specs and `cases.json` with the
  shared pixel geometry and case modes. The recorder checks the screenshot size.
- **Stable capture.** Two identical frames prove the screen is static, not that the viewer has
  rendered. The recorder therefore waits a settle floor (`PROTOTYPE_GOLDEN_STABLE_SETTLE_SECS`,
  default 1.5 s) after launch before its first screenshot. It then captures every 0.5 s until two
  consecutive full screenshots are byte-identical (`capture=stable`). It takes at most
  `PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES` (8) captures within `PROTOTYPE_GOLDEN_STABLE_BUDGET_SECS`
  (15 s, counted from launch).
- **Bad captures.** The remaining budget bounds each screenshot, capped at
  `PROTOTYPE_GOLDEN_CAPTURE_TIMEOUT_SECS` (10 s), with a watchdog that needs no GNU `timeout`. The
  recorder discards a screenshot that fails, times out or writes an empty file and never compares
  it, so stability needs two good frames in a row. When polling ends unstable, the recorder settles
  2 s and records one more bounded screenshot (`capture=fallback`). If that one is bad, it fails.
- **Rendering.** Chromium draws the `iphone-16` still with its iOS skin and safe-area environment
  in a bare document. CSS removes the frame padding, background and corner radii; the whole
  screen is clipped at 3×. Only the screen default font is pinned to DejaVu Sans.
- **Budgets and output.** `test/fixtures/prototype-web/ios-parity-budgets.json` uses the Android
  check's 0.1 pixel distance, runner allowance and `--update` / `--allow-grow` policy. Budgets are
  measured with `--update` after recording. Directory-dependent unit tests require
  complete case coverage, exact PNG sizes and matching budget keys. The opt-in advisory
  `Prototype Web Screenshots` workflow runs both parity checks in Chromium and uploads iOS
  captures and diffs under `ios-parity/`. Golden paths are exempt from LFS so checkout reads PNGs.
