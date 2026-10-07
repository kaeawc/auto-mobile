package dev.jasonpearson.automobile.ctrlproxy.overlay.screenshot

import android.app.Application
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renderer snapshot tests for [dev.jasonpearson.automobile.ctrlproxy.overlay.OverlaySpecContent]
 * over the shared, validator-checked specs in `test/fixtures/overlay-spec/valid` (issue #10445).
 * Each renders off-device on the JVM and compares against a baseline in
 * `control-proxy/src/test/resources/screenshots/overlay/`, recorded on the Linux reference OS.
 *
 * Baselines are recorded with the `Record Desktop Screenshot Baselines` workflow (module
 * `control-proxy`); until then each test is `pending = true`.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-mdpi", application = Application::class)
class OverlaySpecContentScreenshotTest {

  /** Every node type and style token in one fullscreen tree. */
  @Test
  fun fullscreenAllNodes() =
    overlayScreenshotTest(
      "fullscreen_all_nodes",
      validOverlayFixture("fullscreen-all-nodes"),
      pending = true,
    )

  /** Tab bar, pager with a scrolled text page, text field and a closed bottom sheet. */
  @Test
  fun tabbedPagerWithTextField() =
    overlayScreenshotTest("doc_example_1", validOverlayFixture("doc-example-1"), pending = true)

  /** Horizontal scroll row with an icon action above a bottom navigation bar. */
  @Test
  fun bottomNavigationSheet() =
    overlayScreenshotTest("doc_example_2", validOverlayFixture("doc-example-2"), pending = true)

  /** Styled floating box: background colour, corner radius and a text child. */
  @Test
  fun styledFloatingBox() =
    overlayScreenshotTest("doc_example_3", validOverlayFixture("doc-example-3"), pending = true)

  /** Tab bar and bottom navigation bound to state and to a pager. */
  @Test
  fun sheetBindings() =
    overlayScreenshotTest("sheet_bindings", validOverlayFixture("sheet-bindings"), pending = true)
}
