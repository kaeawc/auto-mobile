# Desktop screenshot testing

The `desktop-core` module supports **screenshot (golden-image) tests** for its Compose UI on top of
the existing Compose Desktop UI-test setup (`compose.desktop.uiTestJUnit4` + `runComposeUiTest`).
A test renders a composable, captures it to a PNG, and compares it against a committed baseline so
unintended visual changes fail the build.

No third-party screenshot library is used — the harness is a thin wrapper around Compose Desktop's
own `captureToImage()`, which keeps it dependency-free and resilient to Compose/Kotlin upgrades.

## Writing a test

Add a test that calls `screenshotTest(name) { … }` (mirrors the module's existing `*UiTest` style):

```kotlin
class ComponentScreenshotTest {
  @Test
  fun errorCardLight() = screenshotTest("error_card_light") {
    MaterialTheme(colorScheme = lightColorScheme()) {
      Surface(Modifier.width(360.dp)) {
        ErrorCard(title = "Something went wrong", message = "Please try again later.")
      }
    }
  }
}
```

Guidelines:

- **Wrap content in the theme/`Surface` you want captured.** The harness only adds an invisible
  tagged wrapper so the snapshot is sized to your content, not the whole test window.
- **Keep it deterministic.** Avoid animations, `Date`/time-based state, randomness, and network or
  daemon data. Feed fixed inputs and fakes (the module already provides `FakeAutoMobileClient`).
- **Constrain width** for components that `fillMaxWidth()` (e.g. `ErrorCard`) so the image stays
  small and stable.
- Use `lowercase_snake_case` names; the name is also the PNG file name.

## Recording baselines

Baselines live in `desktop-core/src/test/resources/screenshots/` and are committed to git (excluded
from Git LFS in `.gitattributes`). Record or update them with `-Dscreenshot.record=true`:

```bash
# All screenshot baselines
./gradlew -p android :desktop-core:test --tests '*ScreenshotTest' -Dscreenshot.record=true

# One test class
./gradlew -p android :desktop-core:test \
  --tests '*ComponentScreenshotTest' -Dscreenshot.record=true
```

Review the resulting PNGs and commit them with your change.

## Verifying

A normal test run compares against the baselines:

```bash
./gradlew -p android :desktop-core:test --tests '*ScreenshotTest'
```

On a mismatch the test fails and writes the rejected image plus a red-highlighted diff to
`build/reports/screenshots/`.

## Cross-platform note (important)

Font rasterization differs across operating systems, so a baseline recorded on Linux will not be
pixel-identical on macOS or Windows. To avoid false failures:

- Screenshot tests **only run on the reference OS** (Linux by default). On other platforms they are
  **skipped** via a JUnit assumption, so `./gradlew … test` stays green everywhere.
- **Record and verify baselines on the same OS** — do it on CI/Linux, not a developer Mac.
- Override the gate locally (at your own risk) with `-Dscreenshot.reference.os=any`.

## Configuration flags

All are JVM system properties, forwarded to the test JVM by `desktop-core/build.gradle.kts`:

| Property                    | Default                          | Purpose                                            |
| --------------------------- | -------------------------------- | -------------------------------------------------- |
| `screenshot.record`         | `false`                          | Write baselines instead of comparing.              |
| `screenshot.reference.os`   | `linux`                          | Reference OS substring; `any` disables OS gating.  |
| `screenshot.golden.dir`     | `src/test/resources/screenshots` | Where baseline PNGs are read/written.              |
| `screenshot.report.dir`     | `build/reports/screenshots`      | Where rejected/diff images are written on failure. |

Pixel tolerances (per-channel and max differing-pixel ratio) are set per test via
`ScreenshotComparator.Options`; the defaults suit anti-aliased Compose UI.

## How it fits together

| File                        | Role                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `ScreenshotTester.kt`       | `screenshotTest(...)` — renders, captures to a `BufferedImage`.         |
| `ScreenshotEnvironment.kt`  | Reads flags, applies OS gating, records or delegates comparison.        |
| `ScreenshotComparator.kt`   | Pure record/compare/diff logic (no Compose; unit-tested for speed).     |
| `ComponentScreenshotTest.kt`| Starter baselines for representative components (light + dark).         |
