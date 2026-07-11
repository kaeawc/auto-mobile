package dev.jasonpearson.automobile.desktop.core.screenshot

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.runComposeUiTest

/** Test tag applied to the captured root so we snapshot exactly the content bounds. */
private const val ROOT_TAG = "automobile_screenshot_root"

/**
 * Renders [content] in an isolated Compose Desktop test host, captures it to a PNG, and either
 * records a new baseline or compares against the committed one — depending on the `screenshot.*`
 * system properties documented on [ScreenshotEnvironment].
 *
 * Usage mirrors the existing `*UiTest` files in this module:
 * ```
 * @Test fun errorCard() = screenshotTest("error_card_light") {
 *   MaterialTheme { Surface { ErrorCard(title = "Oops", message = "Try again") } }
 * }
 * ```
 *
 * Wrap [content] in the theme/`Surface` you want captured — the harness adds only an invisible
 * tagged wrapper so the snapshot is sized to the content, not the whole test window. Keep the
 * captured surface small and deterministic: avoid animations, time-based state, and random data.
 *
 * @param name Stable baseline name (also the PNG file name). Use lowercase_snake_case.
 * @param options Pixel-comparison tolerances; the defaults suit anti-aliased Compose UI.
 */
@OptIn(ExperimentalTestApi::class)
fun screenshotTest(
  name: String,
  options: ScreenshotComparator.Options = ScreenshotComparator.Options(),
  content: @Composable () -> Unit,
) {
  ScreenshotEnvironment.assumeReferencePlatform()
  runComposeUiTest {
    setContent { Box(Modifier.testTag(ROOT_TAG)) { content() } }
    waitForIdle()
    val image = onNodeWithTag(ROOT_TAG).captureToImage().toAwtImage()
    ScreenshotEnvironment.handleResult(name, image, options)
  }
}
