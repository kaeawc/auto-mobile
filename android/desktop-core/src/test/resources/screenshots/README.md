# Desktop screenshot baselines

This directory holds the committed baseline PNGs for `desktop-core` screenshot tests
(see `src/test/kotlin/.../core/screenshot/`). Each `*.png` here is the reference image a
`screenshotTest("name") { … }` compares against.

## Recording / updating baselines

Baselines are pixel-identical only on the **reference OS** (Linux by default), because font
rasterization differs across platforms. Record them on that OS (or in CI):

```bash
# Record every screenshot baseline
./gradlew -p android :desktop-core:test --tests '*ScreenshotTest' -Dscreenshot.record=true

# Record a single test's baselines
./gradlew -p android :desktop-core:test \
  --tests '*ComponentScreenshotTest' -Dscreenshot.record=true
```

Then review the generated/updated PNGs in this folder and commit them alongside the code change.

## Verifying

Plain `./gradlew -p android :desktop-core:test` compares against these baselines. On a non-reference
OS the screenshot tests are **skipped** (a JUnit assumption), so they never produce false failures
on developer machines — override with `-Dscreenshot.reference.os=any` to force them locally. A test
whose baseline has not been recorded yet is likewise **skipped (pending)** rather than failed.

On a mismatch, the rejected image and a red-highlighted diff are written under
`build/reports/screenshots/` for inspection.

See `android/docs/screenshot-testing.md` for the full guide.
